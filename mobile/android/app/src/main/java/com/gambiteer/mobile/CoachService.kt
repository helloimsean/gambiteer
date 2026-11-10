package com.gambiteer.mobile

import android.app.Service
import android.content.Intent
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Messenger

/**
 * Hosts the coach in its own process (see the manifest), so a crash in the model's native code
 * loses one explanation instead of the whole app. Any message means "free the model's memory".
 */
class CoachService : Service() {
    private lateinit var server: CoachServer
    private val messenger = Messenger(Handler(Looper.getMainLooper()) { server.release(); true })

    override fun onCreate() {
        super.onCreate()
        CoachCatalog.backendFile(this).delete() // left behind if the last process crashed
        server = CoachServer(this)
        server.start()
    }

    override fun onBind(intent: Intent): IBinder = messenger.binder
}
