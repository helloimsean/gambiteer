package com.gambiteer.mobile

import android.app.ActivityManager
import android.app.Application
import android.app.ApplicationExitInfo
import android.content.Context
import android.util.Log
import com.google.ai.edge.litertlm.Backend as LlmBackend
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.Message
import com.google.ai.edge.litertlm.SamplerConfig
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.thread
import kotlin.concurrent.withLock

/**
 * The part of Ollama's HTTP API the backend uses, answered by a model running on this phone.
 *
 * backend/app/ollama_client.py builds the prompts and parses the stream, so it stays unchanged and
 * only needs OLLAMA_URL pointed here. Implemented: GET /api/tags and POST /api/chat (NDJSON).
 */
class CoachServer(private val context: Context) {
    private val pool = Executors.newCachedThreadPool()
    private val scheduler = Executors.newSingleThreadScheduledExecutor()
    private val engineLock = ReentrantLock()
    private var engine: Engine? = null
    private var engineFile: File? = null
    private var releaseTask: ScheduledFuture<*>? = null
    private val gpuInUse = File(context.filesDir, "coach-gpu-in-use")
    private val backendFile = CoachCatalog.backendFile(context)

    @Volatile
    private var releaseRequested = false

    fun start() {
        thread(name = "gambiteer-coach", isDaemon = true) {
            try {
                ServerSocket(PORT, 16, InetAddress.getByName(Backend.HOST)).use { server ->
                    while (true) {
                        val socket = server.accept()
                        pool.execute { socket.use(::handle) }
                    }
                }
            } catch (e: IOException) {
                Log.e(TAG, "coach server stopped", e)
            }
        }
    }

    /** Frees the model's memory; the next explanation loads it again. */
    fun release() {
        if (!engineLock.tryLock()) {
            releaseRequested = true // an explanation is running: generate() frees it when done
            return
        }
        try {
            releaseEngine()
        } finally {
            engineLock.unlock()
        }
    }

    private fun handle(socket: Socket) {
        try {
            val input = BufferedInputStream(socket.getInputStream())
            val output = socket.getOutputStream()
            val head = readHead(input) ?: return
            val requestLine = head.lineSequence().first().split(" ")
            if (requestLine.size < 2) return
            val path = requestLine[1].substringBefore('?')
            when ("${requestLine[0]} $path") {
                "GET /api/tags" -> tags(output)
                "POST /api/chat" -> chat(readBody(input, head), output)
                else -> json(output, 404, JSONObject().put("error", "not found"))
            }
            output.flush()
        } catch (e: IOException) {
            Log.d(TAG, "client went away: ${e.message}")
        } catch (e: Exception) {
            Log.e(TAG, "request failed", e)
        }
    }

    private fun tags(output: OutputStream) {
        val installed = CoachCatalog.installed(context)
        if (installed.isEmpty()) {
            // A failure, like Ollama being down: the app then reports the coach as unavailable.
            json(output, 503, JSONObject().put("error", "no coach model downloaded"))
            return
        }
        val list = JSONArray()
        for (model in installed) {
            list.put(
                JSONObject()
                    .put("name", model.ollamaName)
                    .put("model", model.ollamaName)
                    .put("size", model.bytes)
                    .put("details", JSONObject().put("family", "gemma4").put("parameter_size", model.parameters)),
            )
        }
        json(output, 200, JSONObject().put("models", list))
    }

    private fun chat(body: String, output: OutputStream) {
        val request = JSONObject(body)
        val name = request.optString("model")
        val model = CoachCatalog.installed(context).firstOrNull { it.ollamaName == name }
        if (model == null) {
            json(output, 404, JSONObject().put("error", "model '$name' is not downloaded"))
            return
        }
        val messages = request.getJSONArray("messages")
        val options = request.optJSONObject("options") ?: JSONObject()
        output.write(
            ("HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nConnection: close\r\n\r\n").toByteArray(),
        )
        output.flush()
        try {
            generate(model.file(context), messages, options) { token ->
                writeChunk(output, name, token, done = false)
            }
            writeChunk(output, name, "", done = true)
        } catch (e: IOException) {
            throw e
        } catch (e: Throwable) {
            // Throwable, because a failed native library load or running out of memory is an Error.
            // The status line has gone out, so the failure has to travel as a stream line.
            Log.e(TAG, "generation failed", e)
            output.write((JSONObject().put("error", e.message ?: e.toString()).toString() + "\n").toByteArray())
        }
    }

    private fun generate(file: File, messages: JSONArray, options: JSONObject, onToken: (String) -> Unit) {
        var system: String? = null
        val history = mutableListOf<Message>()
        var last = ""
        for (i in 0 until messages.length()) {
            val message = messages.getJSONObject(i)
            val content = message.optString("content")
            when (message.optString("role")) {
                "system" -> system = content
                "assistant" -> history.add(Message.model(content))
                else -> {
                    if (i < messages.length() - 1) history.add(Message.user(content)) else last = content
                }
            }
        }
        engineLock.withLock {
            releaseTask?.cancel(false)
            val useGpu = gpuAllowed()
            if (useGpu) gpuInUse.createNewFile()
            try {
                val config = ConversationConfig(
                    systemInstruction = system?.let { Contents.of(it) },
                    initialMessages = history,
                    samplerConfig = SamplerConfig(
                        topK = 40,
                        topP = 0.95,
                        temperature = options.optDouble("temperature", 0.3),
                        seed = 0,
                    ),
                    maxOutputToken = options.optInt("num_predict", 220),
                )
                loadEngine(file, useGpu).createConversation(config).use { conversation ->
                    runBlocking {
                        conversation.sendMessageAsync(last).collect { onToken(it.toString()) }
                    }
                }
            } finally {
                gpuInUse.delete()
                if (releaseRequested) {
                    releaseRequested = false
                    releaseEngine()
                } else {
                    releaseTask = scheduler.schedule({ release() }, IDLE_RELEASE_MINUTES, TimeUnit.MINUTES)
                }
            }
        }
    }

    /**
     * A GPU driver can crash the process in native code, where no catch can fall back to the CPU.
     * gpuInUse marks the time the GPU may be running. Finding the mark after a native crash rules
     * the GPU out until the app is updated; a mark left by anything else (the user closing the app,
     * Android reclaiming memory) means nothing.
     */
    private fun gpuAllowed(): Boolean {
        val blocked = File(context.filesDir, "coach-gpu-blocked")
        val build = context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime.toString()
        if (gpuInUse.delete() && lastExitWasNativeCrash()) {
            Log.w(TAG, "the GPU crashed this process, using the CPU from now on")
            blocked.writeText(build)
        }
        return !blocked.isFile || blocked.readText() != build
    }

    private fun lastExitWasNativeCrash(): Boolean =
        context.getSystemService(ActivityManager::class.java)
            .getHistoricalProcessExitReasons(context.packageName, 0, EXIT_HISTORY)
            .firstOrNull { it.processName == Application.getProcessName() }
            ?.reason == ApplicationExitInfo.REASON_CRASH_NATIVE

    private fun loadEngine(file: File, useGpu: Boolean): Engine {
        engine?.let { if (engineFile == file && it.isInitialized()) return it }
        releaseEngine()
        val gpu = if (useGpu) tryGpu(file) else null
        val loaded = gpu ?: create(file, LlmBackend.CPU(numOfThreads = CPU_THREADS))
        backendFile.writeText(if (gpu != null) "GPU" else "CPU")
        engine = loaded
        engineFile = file
        return loaded
    }

    private fun tryGpu(file: File): Engine? = try {
        create(file, LlmBackend.GPU())
    } catch (e: Throwable) {
        Log.w(TAG, "GPU backend unavailable, using the CPU", e)
        null
    }

    private fun create(file: File, backend: LlmBackend): Engine {
        val candidate = Engine(
            EngineConfig(
                modelPath = file.path,
                backend = backend,
                maxNumTokens = MAX_TOKENS,
                cacheDir = context.cacheDir.path,
            ),
        )
        candidate.initialize()
        return candidate
    }

    private fun releaseEngine() {
        engine?.close()
        engine = null
        engineFile = null
        backendFile.delete()
    }

    private fun writeChunk(output: OutputStream, model: String, text: String, done: Boolean) {
        val chunk = JSONObject()
            .put("model", model)
            .put("message", JSONObject().put("role", "assistant").put("content", text))
            .put("done", done)
        output.write((chunk.toString() + "\n").toByteArray())
        output.flush()
    }

    private fun json(output: OutputStream, code: Int, value: JSONObject) {
        val reason = if (code == 200) "OK" else "Error"
        val body = value.toString().toByteArray()
        output.write(
            ("HTTP/1.1 $code $reason\r\nContent-Type: application/json\r\n" +
                "Content-Length: ${body.size}\r\nConnection: close\r\n\r\n").toByteArray(),
        )
        output.write(body)
    }

    private fun readHead(input: InputStream): String? {
        val bytes = ByteArrayOutputStream()
        var matched = 0
        val end = "\r\n\r\n"
        while (matched < end.length) {
            val value = input.read()
            if (value < 0) return null
            bytes.write(value)
            matched = when {
                value.toChar() == end[matched] -> matched + 1
                value.toChar() == '\r' -> 1
                else -> 0
            }
            if (bytes.size() > MAX_HEAD_BYTES) throw IOException("request head too large")
        }
        return bytes.toString(Charsets.ISO_8859_1.name())
    }

    private fun readBody(input: InputStream, head: String): String {
        val length = head.lineSequence()
            .firstOrNull { it.startsWith("content-length:", ignoreCase = true) }
            ?.substringAfter(':')?.trim()?.toIntOrNull()
            ?: throw IOException("missing Content-Length")
        if (length > MAX_BODY_BYTES) throw IOException("request body too large")
        return String(input.readNBytes(length), Charsets.UTF_8)
    }

    companion object {
        const val PORT = 11434
        private const val TAG = "GambiteerCoach"
        private const val MAX_TOKENS = 4096 // matches num_ctx in ollama_client.py
        private const val CPU_THREADS = 4
        private const val IDLE_RELEASE_MINUTES = 5L
        private const val EXIT_HISTORY = 16
        private const val MAX_HEAD_BYTES = 16 * 1024
        private const val MAX_BODY_BYTES = 1024 * 1024
    }
}
