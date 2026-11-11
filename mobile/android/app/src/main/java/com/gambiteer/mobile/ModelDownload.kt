package com.gambiteer.mobile

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.Collections
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLongArray
import kotlin.concurrent.thread

/**
 * Downloads one model straight into the app's own storage, over several connections at once.
 *
 * Android's DownloadManager took 26 minutes for 3.7 GB on a 300 Mbps connection: it writes from
 * another process through the shared-storage layer, in small pieces. Here each of [PARTS]
 * connections fetches one byte range and writes it in 1 MB blocks. Progress is saved every few
 * seconds, so a download that Android stops carries on from where it was.
 */
class ModelDownload(
    private val context: Context,
    val model: CoachModel,
    private val allowMobileData: Boolean,
) {
    /** A failure retrying cannot fix; the message is shown to the user. */
    class Failed(message: String) : Exception(message)

    /** Why the download is waiting, or null while it runs. */
    @Volatile
    var note: String? = null
        private set

    @Volatile
    var verifying = false
        private set

    /** True once stopped by [stop]; [discard] says whether the files go too. */
    @Volatile
    var stopped = false
        private set

    @Volatile
    var discard = false
        private set

    private val done = AtomicLongArray(PARTS)
    private val connections: MutableSet<HttpURLConnection> = Collections.synchronizedSet(mutableSetOf())
    private val partFile = model.partFile(context)
    private val progressFile = progressFile(context, model)

    val downloaded: Long
        get() = (0 until PARTS).sumOf { done.get(it) }

    /** Stops the download; with [discardFiles] the partial file is deleted, otherwise it resumes later. */
    fun stop(discardFiles: Boolean) {
        discard = discardFiles
        stopped = true
        synchronized(connections) { connections.forEach { it.disconnect() } }
    }

    /** Blocks until the model is downloaded and checked, or [stop] is called. Throws [Failed]. */
    fun run() {
        try {
            prepare()
            val failure = AtomicBoolean(false)
            var error: Throwable? = null
            val workers = (0 until PARTS).map { index ->
                thread(name = "download-${model.id}-$index") {
                    try {
                        runPart(index)
                    } catch (t: Throwable) {
                        if (failure.compareAndSet(false, true)) error = t
                        stop(discardFiles = false)
                    }
                }
            }
            while (workers.any { it.isAlive }) {
                workers.first { it.isAlive }.join(SAVE_EVERY_MS)
                saveProgress()
            }
            if (failure.get() && !discard) {
                val cause = error
                throw if (cause is Failed) cause else Failed(context.getString(R.string.download_stopped, cause?.message ?: cause.toString()))
            }
            if (stopped) return
            verify()
        } finally {
            if (discard) {
                partFile.delete()
                progressFile.delete()
            }
        }
    }

    private fun prepare() {
        partFile.parentFile?.mkdirs()
        val saved = loadProgress()
        if (saved != null && partFile.length() == model.bytes) {
            for (i in 0 until PARTS) done.set(i, saved[i])
            return
        }
        progressFile.delete()
        RandomAccessFile(partFile, "rw").use { it.setLength(model.bytes) }
    }

    private fun start(index: Int): Long = model.bytes * index / PARTS

    private fun length(index: Int): Long = start(index + 1) - start(index)

    private fun runPart(index: Int) {
        var failures = 0
        while (!stopped && done.get(index) < length(index)) {
            awaitNetwork()
            if (stopped) return
            val before = done.get(index)
            try {
                fetch(index)
            } catch (e: IOException) {
                if (stopped) return
                failures = if (done.get(index) > before) 1 else failures + 1
                if (failures > MAX_FAILURES) throw Failed(context.getString(R.string.download_keeps_failing, e.message ?: e.toString()))
                Thread.sleep(minOf(MAX_BACKOFF_MS, 1000L shl failures))
            }
        }
    }

    private fun fetch(index: Int) {
        val from = start(index) + done.get(index)
        val to = start(index) + length(index) - 1
        val connection = open(from, to)
        try {
            val code = connection.responseCode
            when {
                code == HttpURLConnection.HTTP_PARTIAL -> Unit
                code == HttpURLConnection.HTTP_OK -> throw Failed(context.getString(R.string.download_no_resume))
                code in 400..499 && code != 408 && code != 429 -> throw Failed(context.getString(R.string.download_refused, code))
                else -> throw IOException("HTTP $code")
            }
            val range = connection.getHeaderField("Content-Range").orEmpty()
            if (!range.startsWith("bytes $from-")) throw IOException("unexpected range '$range'")
            RandomAccessFile(partFile, "rw").use { file ->
                val channel = file.channel
                val buffer = ByteArray(BLOCK_BYTES)
                var position = from
                connection.inputStream.use { input ->
                    while (!stopped) {
                        val count = fill(input, buffer)
                        if (count == 0) break
                        channel.write(ByteBuffer.wrap(buffer, 0, count), position)
                        position += count
                        done.addAndGet(index, count.toLong())
                    }
                }
            }
            if (!stopped && done.get(index) < length(index)) throw IOException("the connection closed early")
        } finally {
            connections.remove(connection)
            connection.disconnect()
        }
    }

    /** Reads until [buffer] is full or the stream ends, so each disk write is a whole block. */
    private fun fill(input: InputStream, buffer: ByteArray): Int {
        var count = 0
        while (count < buffer.size) {
            val read = input.read(buffer, count, buffer.size - count)
            if (read < 0) break
            count += read
        }
        return count
    }

    /** Follows the redirects itself so the Range header goes along (Hugging Face sends a CDN link). */
    private fun open(from: Long, to: Long): HttpURLConnection {
        var target = URL(model.url)
        repeat(MAX_REDIRECTS) {
            val connection = target.openConnection() as HttpURLConnection
            connection.instanceFollowRedirects = false
            connection.connectTimeout = CONNECT_TIMEOUT_MS
            connection.readTimeout = READ_TIMEOUT_MS
            connection.setRequestProperty("Range", "bytes=$from-$to")
            connection.setRequestProperty("Accept-Encoding", "identity")
            connection.setRequestProperty("User-Agent", "Gambiteer-Android")
            connections.add(connection)
            if (stopped) connection.disconnect()
            val code = connection.responseCode
            if (code !in 300..399) return connection
            val location = connection.getHeaderField("Location")
            connections.remove(connection)
            connection.disconnect()
            target = URL(target, location ?: throw IOException("redirect without a location"))
        }
        throw IOException("too many redirects")
    }

    private fun awaitNetwork() {
        while (!stopped) {
            val problem = networkProblem()
            note = problem
            if (problem == null) return
            Thread.sleep(NETWORK_POLL_MS)
        }
    }

    private fun networkProblem(): String? {
        val manager = context.getSystemService(ConnectivityManager::class.java)
        val caps = manager.getNetworkCapabilities(manager.activeNetwork)
        if (caps == null || !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) {
            return context.getString(R.string.waiting_connection)
        }
        if (!allowMobileData && !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)) {
            return context.getString(R.string.waiting_wifi)
        }
        return null
    }

    private fun verify() {
        verifying = true
        saveProgress()
        if (sha256(partFile) != model.sha256) {
            partFile.delete()
            progressFile.delete()
            throw Failed(context.getString(R.string.download_corrupted))
        }
        if (!partFile.renameTo(model.file(context))) throw Failed(context.getString(R.string.download_save_failed))
        progressFile.delete()
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(BLOCK_BYTES)
        file.inputStream().use { input ->
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    /** One line: the model size, then the bytes done in each part. */
    private fun saveProgress() {
        val temp = File(progressFile.path + ".tmp")
        temp.writeText((listOf(model.bytes) + (0 until PARTS).map { done.get(it) }).joinToString(" "))
        temp.renameTo(progressFile)
    }

    private fun loadProgress(): LongArray? = savedParts(context, model)

    companion object {
        const val PARTS = 8
        private const val BLOCK_BYTES = 1 shl 20
        private const val SAVE_EVERY_MS = 2000L
        private const val MAX_FAILURES = 8
        private const val MAX_BACKOFF_MS = 30_000L
        private const val MAX_REDIRECTS = 5
        private const val CONNECT_TIMEOUT_MS = 15_000
        private const val READ_TIMEOUT_MS = 30_000
        private const val NETWORK_POLL_MS = 3000L

        fun progressFile(context: Context, model: CoachModel) =
            File(model.partFile(context).path + ".progress")

        /** The bytes done per part from an earlier run, or null if there is nothing to resume. */
        fun savedParts(context: Context, model: CoachModel): LongArray? {
            val values = runCatching {
                progressFile(context, model).readText().trim().split(" ").map(String::toLong)
            }.getOrNull() ?: return null
            if (values.size != PARTS + 1 || values[0] != model.bytes) return null
            return values.drop(1).toLongArray()
        }
    }
}
