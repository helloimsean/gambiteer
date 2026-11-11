package com.gambiteer.mobile

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.LocaleManager
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.LocaleList
import android.os.Looper
import android.provider.MediaStore
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import android.window.OnBackInvokedDispatcher

class MainActivity : Activity() {
    private lateinit var app: GambiteerApp
    private lateinit var web: WebView
    private lateinit var splash: TextView
    private val handler = Handler(Looper.getMainLooper())
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    private val watchBackend = object : Runnable {
        private var loaded = false

        override fun run() {
            val failure = app.backend.failure
            when {
                failure != null -> {
                    splash.text = getString(R.string.app_failed, failure)
                    splash.visibility = View.VISIBLE
                    return
                }
                loaded -> handler.postDelayed(this, WATCH_MS)
                app.backend.ready -> {
                    loaded = true
                    web.loadUrl(Backend.URL)
                    handler.postDelayed(this, WATCH_MS)
                }
                else -> {
                    splash.text = getString(R.string.first_launch_slower, app.backend.status)
                    handler.postDelayed(this, POLL_MS)
                }
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        app = application as GambiteerApp

        web = WebView(this).apply {
            setBackgroundColor(BACKGROUND)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.textZoom = 100
            settings.setSupportZoom(false)
            settings.cacheMode = WebSettings.LOAD_NO_CACHE
            overScrollMode = View.OVER_SCROLL_NEVER
            webViewClient = Client()
            webChromeClient = Chrome()
            addJavascriptInterface(Bridge(), "GambiteerNative")
        }
        WebView.setWebContentsDebuggingEnabled(true)

        splash = TextView(this).apply {
            setBackgroundColor(BACKGROUND)
            setTextColor(Color.rgb(232, 230, 227))
            textSize = 16f
            gravity = Gravity.CENTER
            setPadding(64, 0, 64, 0)
            text = getString(R.string.starting)
        }

        val root = FrameLayout(this).apply {
            setBackgroundColor(BACKGROUND)
            addView(web, FrameLayout.LayoutParams(-1, -1))
            addView(splash, FrameLayout.LayoutParams(-1, -1))
            setOnApplyWindowInsetsListener { view, insets ->
                val bars = insets.getInsets(
                    WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime(),
                )
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                WindowInsets.CONSUMED
            }
        }
        setContentView(root)

        // Android 15+ always draws edge to edge; this makes older versions match.
        @Suppress("DEPRECATION")
        window.setDecorFitsSystemWindows(false)
        window.insetsController?.setSystemBarsAppearance(
            0,
            WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
        )

        onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) {
            web.evaluateJavascript("window.__gambiteerBack ? window.__gambiteerBack() : false") { handled ->
                if (handled != "true") moveTaskToBack(true)
            }
        }

        handler.post(watchBackend)
    }

    override fun onResume() {
        super.onResume()
        app.models.resumePending()
        web.onResume()
        web.resumeTimers()
    }

    override fun onPause() {
        web.onPause()
        web.pauseTimers()
        super.onPause()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        web.destroy()
        super.onDestroy()
    }

    @Deprecated("The system file picker still reports through this callback")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != FILE_REQUEST) return
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
        fileCallback = null
    }

    private inner class Client : WebViewClient() {
        override fun onPageFinished(view: WebView, url: String) {
            splash.visibility = View.GONE
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url
            if (url.host == Backend.HOST) return false
            try {
                startActivity(Intent(Intent.ACTION_VIEW, url))
            } catch (e: ActivityNotFoundException) {
                Log.w(TAG, "no app can open $url", e)
            }
            return true
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            Log.e(TAG, "web renderer gone, crashed=${detail.didCrash()}")
            recreate()
            return true
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onShowFileChooser(
            view: WebView,
            callback: ValueCallback<Array<Uri>>,
            params: FileChooserParams,
        ): Boolean {
            fileCallback?.onReceiveValue(null)
            fileCallback = callback
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "*/*"
            }
            @Suppress("DEPRECATION")
            startActivityForResult(intent, FILE_REQUEST)
            return true
        }
    }

    /** What the phone web build can ask of Android (see web/src/native.ts). */
    private inner class Bridge {
        @JavascriptInterface
        fun coachStatus(): String = app.models.statusJson()

        @JavascriptInterface
        fun downloadCoach(id: String, allowMobileData: Boolean) {
            runOnUiThread {
                // Shows the download's progress notification; the download runs either way.
                if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), NOTIFY_REQUEST)
                }
            }
            app.models.download(id, allowMobileData)
        }

        @JavascriptInterface
        fun cancelCoach(id: String) = app.models.cancel(id)

        @JavascriptInterface
        fun deleteCoach(id: String) = app.models.delete(id)

        @JavascriptInterface
        fun setKeepScreenOn(on: Boolean) {
            runOnUiThread {
                if (on) {
                    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                } else {
                    window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                }
            }
        }

        /**
         * The web app's language (Settings > Language), so Android's own texts (the start screen and
         * the download notification) match it. Android keeps it for the next launch.
         */
        @JavascriptInterface
        fun setLanguage(code: String) {
            val wanted = LocaleList.forLanguageTags(code)
            val manager = getSystemService(LocaleManager::class.java)
            if (manager.applicationLocales != wanted) manager.applicationLocales = wanted
        }

        /** Saves a text file (a PGN) to the phone's Downloads folder. */
        @JavascriptInterface
        fun saveTextFile(name: String, text: String): Boolean {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, "application/x-chess-pgn")
            }
            var uri: Uri? = null
            return try {
                val created = checkNotNull(contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values))
                uri = created
                contentResolver.openOutputStream(created).use { stream -> checkNotNull(stream).write(text.toByteArray()) }
                true
            } catch (e: Exception) {
                Log.e(TAG, "could not save $name", e)
                uri?.let { contentResolver.delete(it, null, null) } // no empty file left in Downloads
                false
            }
        }
    }

    companion object {
        private const val TAG = "Gambiteer"
        private const val POLL_MS = 300L
        private const val WATCH_MS = 2000L
        private const val FILE_REQUEST = 41
        private const val NOTIFY_REQUEST = 42
        private val BACKGROUND = Color.rgb(38, 36, 33)
    }
}
