package com.gambiteer.mobile

import android.app.DownloadManager
import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.Collections
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

data class CoachModel(
    val id: String,
    val ollamaName: String,
    val label: String,
    val description: String,
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
            description = "Best explanations (recommended)",
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
            description = "Smaller and quicker, looser wording",
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

/** Downloads and checks the models. Lives in the app's main process; CoachService only reads the files. */
class CoachModels(private val context: Context, private val releaseCoach: () -> Unit) {
    private val catalog = CoachCatalog.models
    private val manager = context.getSystemService(DownloadManager::class.java)
    private val prefs = context.getSharedPreferences("coach-models", Context.MODE_PRIVATE)
    private val worker = Executors.newSingleThreadScheduledExecutor()
    private val verifying: MutableSet<String> = Collections.synchronizedSet(mutableSetOf())
    private val errors = java.util.concurrent.ConcurrentHashMap<String, String>()

    init {
        worker.scheduleWithFixedDelay({ runCatching(::advance) }, 2, 3, TimeUnit.SECONDS)
    }

    fun download(id: String, allowMobileData: Boolean) {
        val model = catalog.firstOrNull { it.id == id } ?: return
        if (model.file(context).isFile || prefs.contains(key(id)) || id in verifying) return
        errors.remove(id)
        model.partFile(context).delete()
        val request = DownloadManager.Request(Uri.parse(model.url))
            .setTitle("Gambiteer coach: ${model.label}")
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setDestinationInExternalFilesDir(context, "models", model.partFile(context).name)
            .setAllowedOverMetered(allowMobileData)
            .setAllowedOverRoaming(false)
        prefs.edit().putLong(key(id), manager.enqueue(request)).apply()
    }

    fun cancel(id: String) {
        val model = catalog.firstOrNull { it.id == id } ?: return
        takeDownload(id)?.let { manager.remove(it) }
        model.partFile(context).delete()
        errors.remove(id)
    }

    fun delete(id: String) {
        val model = catalog.firstOrNull { it.id == id } ?: return
        releaseCoach()
        model.file(context).delete()
        errors.remove(id)
    }

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
            .put("description", model.description)
            .put("bytes", model.bytes)
            .put("downloaded", 0L)
        when {
            model.id in verifying -> json.put("state", "verifying")
            model.file(context).isFile -> json.put("state", "ready")
            else -> {
                val id = prefs.takeIf { it.contains(key(model.id)) }?.getLong(key(model.id), -1L)
                val row = id?.let(::query)
                if (row == null) {
                    json.put("state", if (errors.containsKey(model.id)) "failed" else "absent")
                    errors[model.id]?.let { json.put("error", it) }
                } else {
                    json.put("downloaded", row.bytes)
                    json.put("state", if (row.status == DownloadManager.STATUS_RUNNING) "downloading" else "waiting")
                    row.reason?.let { json.put("note", it) }
                }
            }
        }
        return json
    }

    /** Runs in the background: picks up finished or failed downloads even with the screen closed. */
    private fun advance() {
        for (model in catalog) {
            if (!prefs.contains(key(model.id))) continue
            val id = prefs.getLong(key(model.id), -1L)
            val row = query(id)
            when (row?.status) {
                null -> takeDownload(model.id)
                DownloadManager.STATUS_FAILED -> {
                    errors[model.id] = row.reason ?: "The download failed."
                    takeDownload(model.id)?.let { manager.remove(it) }
                }
                DownloadManager.STATUS_SUCCESSFUL -> {
                    // The download stays registered until checked, so a kill during the hash just
                    // repeats the check at the next launch instead of losing the file.
                    if (verifying.add(model.id)) worker.execute { verify(model) }
                }
            }
        }
    }

    private fun verify(model: CoachModel) {
        try {
            val part = model.partFile(context)
            if (sha256(part) != model.sha256) {
                part.delete()
                errors[model.id] = "The download was corrupted. Please try again."
            } else if (!part.renameTo(model.file(context))) {
                errors[model.id] = "Could not save the model to this phone's storage."
            }
        } catch (e: Exception) {
            Log.e(TAG, "verify failed", e)
            errors[model.id] = e.message ?: "Could not check the download."
        } finally {
            takeDownload(model.id)
            verifying.remove(model.id)
        }
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(1 shl 20)
        file.inputStream().use { input ->
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private class Row(val status: Int, val bytes: Long, val reason: String?)

    private fun query(id: Long): Row? {
        manager.query(DownloadManager.Query().setFilterById(id)).use { cursor: Cursor ->
            if (!cursor.moveToFirst()) return null
            val status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
            val bytes = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
            val reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON))
            return Row(status, bytes, describe(status, reason))
        }
    }

    private fun describe(status: Int, reason: Int): String? = when (status) {
        DownloadManager.STATUS_PAUSED -> when (reason) {
            DownloadManager.PAUSED_QUEUED_FOR_WIFI -> "Waiting for Wi-Fi"
            DownloadManager.PAUSED_WAITING_FOR_NETWORK -> "Waiting for a connection"
            DownloadManager.PAUSED_WAITING_TO_RETRY -> "Retrying soon"
            else -> "Paused"
        }
        DownloadManager.STATUS_FAILED -> when (reason) {
            DownloadManager.ERROR_INSUFFICIENT_SPACE -> "Not enough free storage on this phone."
            DownloadManager.ERROR_CANNOT_RESUME -> "The download could not resume. Please try again."
            else -> "The download failed (code $reason)."
        }
        else -> null
    }

    private fun takeDownload(id: String): Long? {
        if (!prefs.contains(key(id))) return null
        val value = prefs.getLong(key(id), -1L)
        prefs.edit().remove(key(id)).apply()
        return value
    }

    private fun key(id: String) = "download-$id"

    companion object {
        private const val TAG = "GambiteerModels"
    }
}
