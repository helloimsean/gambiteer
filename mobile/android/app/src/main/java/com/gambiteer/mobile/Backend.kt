package com.gambiteer.mobile

import android.content.Context
import android.util.Log
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket
import kotlin.concurrent.thread

/** Starts the FastAPI backend (see python/mobile_boot.py) on its own thread. */
class Backend(private val context: Context) {
    @Volatile
    var failure: String? = null
        private set

    @Volatile
    var status: String = context.getString(R.string.starting)
        private set

    /** True once the server accepts connections. Android forbids this check on the main thread. */
    @Volatile
    var ready: Boolean = false
        private set

    fun start() {
        thread(name = "gambiteer-backend-probe", isDaemon = true) {
            while (failure == null && !isUp()) Thread.sleep(PROBE_MS)
            ready = failure == null
        }
        thread(name = "gambiteer-backend", isDaemon = true) {
            try {
                status = context.getString(R.string.unpacking)
                val payload = unpackPayload()
                status = context.getString(R.string.starting_engine)
                if (!Python.isStarted()) Python.start(AndroidPlatform(context))
                Python.getInstance().getModule("mobile_boot").callAttr(
                    "run",
                    context.applicationInfo.nativeLibraryDir,
                    payload.path,
                    PORT,
                    CoachServer.PORT,
                    AccessKey.get(context),
                )
                failure = context.getString(R.string.engine_stopped)
            } catch (t: Throwable) {
                Log.e(TAG, "backend failed", t)
                failure = t.message ?: t.toString()
            }
        }
    }

    private fun isUp(): Boolean = try {
        Socket().use {
            it.connect(InetSocketAddress(HOST, PORT), 250)
            true
        }
    } catch (_: Exception) {
        false
    }

    /** Copies the web app and opening data out of the APK once per installed version. */
    private fun unpackPayload(): File {
        val target = File(context.filesDir, "payload")
        val stamp = File(context.filesDir, "payload.stamp")
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        val version = info.lastUpdateTime.toString()
        if (target.isDirectory && stamp.isFile && stamp.readText() == version) return target
        stamp.delete()
        target.deleteRecursively()
        copyAssets("payload", target)
        stamp.writeText(version)
        return target
    }

    private fun copyAssets(path: String, target: File) {
        val children = context.assets.list(path).orEmpty()
        if (children.isEmpty()) {
            target.parentFile?.mkdirs()
            context.assets.open(path).use { input -> target.outputStream().use { input.copyTo(it) } }
            return
        }
        target.mkdirs()
        for (child in children) copyAssets("$path/$child", File(target, child.removeSuffix(ASSET_SUFFIX)))
    }

    companion object {
        const val HOST = "127.0.0.1"
        const val PORT = 8000
        const val URL = "http://$HOST:$PORT/"
        private const val TAG = "GambiteerBackend"
        private const val PROBE_MS = 200L

        /** Added at build time so the Android tools leave the .gz files alone (see build.gradle.kts). */
        private const val ASSET_SUFFIX = ".asset"
    }
}
