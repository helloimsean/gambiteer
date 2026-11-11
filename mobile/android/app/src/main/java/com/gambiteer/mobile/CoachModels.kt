package com.gambiteer.mobile

import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import kotlin.concurrent.thread

data class CoachModel(
    val id: String,
    val ollamaName: String,
    val label: String,
    val description: Int, // a string resource, so it follows the app's language
    val parameters: String,
    val fileName: String,
    val url: String,
    val sha256: String,
    val bytes: Long,
) {
    fun file(context: Context): File = File(context.getExternalFilesDir("models"), fileName)
    fun partFile(context: Context): File = File(context.getExternalFilesDir("models"), "$fileName.part")
}

/** The downloadable coach models: Gemma 4 from Hugging Face, Apache-2.0, no account needed. */
object CoachCatalog {
    private const val BASE = "https://huggingface.co/litert-community"
    private const val E4B_REVISION = "71064b01bd5e2bfd9a5f9dd52df86ae4800138c1"
    private const val E2B_REVISION = "3d48132a00cf76de57d926de30f5c5c5ed9b8c0d"
    private const val E4B_BYTES = 3_659_530_240L
    private const val E2B_BYTES = 2_588_147_712L

    val models = listOf(
        CoachModel(
            id = "e4b",
            ollamaName = "gemma4:e4b",
            label = "Gemma 4 E4B",
            description = R.string.model_e4b_description,
            parameters = "4B",
            fileName = "gemma-4-E4B-it.litertlm",
            url = "$BASE/gemma-4-E4B-it-litert-lm/resolve/$E4B_REVISION/gemma-4-E4B-it.litertlm",
            sha256 = "0b2a8980ce155fd97673d8e820b4d29d9c7d99b8fa6806f425d969b145bd52e0",
            bytes = E4B_BYTES,
        ),
        CoachModel(
            id = "e2b",
            ollamaName = "gemma4:e2b",
            label = "Gemma 4 E2B",
            description = R.string.model_e2b_description,
            parameters = "2B",
            fileName = "gemma-4-E2B-it.litertlm",
            url = "$BASE/gemma-4-E2B-it-litert-lm/resolve/$E2B_REVISION/gemma-4-E2B-it.litertlm",
            sha256 = "181938105e0eefd105961417e8da75903eacda102c4fce9ce90f50b97139a63c",
            bytes = E2B_BYTES,
        ),
    )

    fun installed(context: Context): List<CoachModel> = models.filter { it.file(context).isFile }

    /** Written by the coach's process, read by Settings: "GPU" or "CPU", absent with no model loaded. */
    fun backendFile(context: Context): File = File(context.filesDir, "coach-backend")
}

/** Starts, tracks and resumes the model downloads (see ModelDownload). Lives in the app's main process. */
class CoachModels(private val context: Context, private val releaseCoach: () -> Unit) {
    private val catalog = CoachCatalog.models
    private val prefs = context.getSharedPreferences("coach-models", Context.MODE_PRIVATE)
    private val downloads = ConcurrentHashMap<String, ModelDownload>()
    private val errors = ConcurrentHashMap<String, String>()

    init {
        forgetDownloadManager()
    }

    fun download(id: String, allowMobileData: Boolean) {
        val model = catalog.firstOrNull { it.id == id } ?: return
        if (model.file(context).isFile) return
        errors.remove(id)
        prefs.edit().putBoolean(pendingKey(id), allowMobileData).apply()
        start(model, allowMobileData)
    }

    /** Carries on downloads that stopped with the app (closed, or paused by Android). */
    fun resumePending() {
        for (model in catalog) {
            if (prefs.contains(pendingKey(model.id)) && !model.file(context).isFile) {
                start(model, prefs.getBoolean(pendingKey(model.id), false))
            }
        }
    }

    fun cancel(id: String) {
        val model = catalog.firstOrNull { it.id == id } ?: return
        prefs.edit().remove(pendingKey(id)).apply()
        errors.remove(id)
        val running = downloads[id]
        if (running != null) running.stop(discardFiles = true) else discardFiles(model)
    }

    fun delete(id: String) {
        val model = catalog.firstOrNull { it.id == id } ?: return
        releaseCoach()
        model.file(context).delete()
        errors.remove(id)
    }

    /** Stops every download but keeps what it fetched; resumePending carries on. */
    fun pauseDownloads() {
        downloads.values.forEach { it.stop(discardFiles = false) }
    }

    fun activeDownloads(): List<ModelDownload> = downloads.values.toList()

    fun statusJson(): String {
        val models = JSONArray()
        for (model in catalog) models.put(status(model))
        val backend = CoachCatalog.backendFile(context).takeIf { it.isFile }?.readText()
        return JSONObject().put("models", models).put("backend", backend ?: JSONObject.NULL).toString()
    }

    private fun status(model: CoachModel): JSONObject {
        val json = JSONObject()
            .put("id", model.id)
            .put("name", model.ollamaName)
            .put("label", model.label)
            .put("description", context.getString(model.description))
            .put("bytes", model.bytes)
            .put("downloaded", 0L)
        val running = downloads[model.id]
        when {
            running != null && running.verifying -> json.put("state", "verifying")
            running != null -> {
                val note = running.note
                json.put("downloaded", running.downloaded)
                json.put("state", if (note != null) "waiting" else "downloading")
                note?.let { json.put("note", it) }
            }
            model.file(context).isFile -> json.put("state", "ready")
            errors.containsKey(model.id) -> json.put("state", "failed").put("error", errors[model.id])
            prefs.contains(pendingKey(model.id)) -> {
                json.put("state", "waiting").put("note", context.getString(R.string.download_paused))
                json.put("downloaded", ModelDownload.savedParts(context, model)?.sum() ?: 0L)
            }
            else -> json.put("state", "absent")
        }
        return json
    }

    private fun start(model: CoachModel, allowMobileData: Boolean) {
        val job = ModelDownload(context, model, allowMobileData)
        if (downloads.putIfAbsent(model.id, job) != null) return
        try {
            context.startForegroundService(Intent(context, ModelDownloadService::class.java))
        } catch (e: Exception) {
            // Android refuses while the app is in the background; the download still runs while it can.
            Log.w(TAG, "downloading without the foreground service", e)
        }
        thread(name = "download-${model.id}") {
            try {
                job.run()
                if (!job.stopped || job.discard) prefs.edit().remove(pendingKey(model.id)).apply()
            } catch (e: ModelDownload.Failed) {
                errors[model.id] = e.message ?: context.getString(R.string.download_failed)
                prefs.edit().remove(pendingKey(model.id)).apply()
            } catch (e: Exception) {
                Log.e(TAG, "download failed", e)
                errors[model.id] = context.getString(R.string.download_failed_reason, e.message ?: e.toString())
                prefs.edit().remove(pendingKey(model.id)).apply()
            } finally {
                downloads.remove(model.id, job)
                // Cancelled and asked for again before this one had finished stopping.
                if (job.discard && prefs.contains(pendingKey(model.id))) resumePending()
            }
        }
    }

    private fun discardFiles(model: CoachModel) {
        model.partFile(context).delete()
        ModelDownload.progressFile(context, model).delete()
    }

    /** Earlier versions downloaded through DownloadManager: drop anything left from those. */
    private fun forgetDownloadManager() {
        val manager = context.getSystemService(DownloadManager::class.java)
        for (model in catalog) {
            val key = "download-${model.id}"
            if (!prefs.contains(key)) continue
            runCatching { manager.remove(prefs.getLong(key, -1L)) }
            prefs.edit().remove(key).apply()
            discardFiles(model)
        }
    }

    private fun pendingKey(id: String) = "pending-$id"

    companion object {
        private const val TAG = "GambiteerModels"
    }
}
