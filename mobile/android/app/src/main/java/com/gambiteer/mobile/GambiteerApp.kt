package com.gambiteer.mobile

import android.app.Application
import android.content.ComponentCallbacks2
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import android.os.Message
import android.os.Messenger
import android.os.RemoteException

/** Owns everything that must outlive the Activity: the Python backend and the link to the coach. */
class GambiteerApp : Application(), ServiceConnection {
    lateinit var models: CoachModels
        private set
    lateinit var backend: Backend
        private set

    @Volatile
    private var coach: Messenger? = null

    override fun onCreate() {
        super.onCreate()
        if (getProcessName() != packageName) return // the coach's own process runs only CoachService
        models = CoachModels(this, ::releaseCoach)
        backend = Backend(this)
        bindCoach()
        backend.start()
    }

    /** BIND_IMPORTANT gives the coach the CPU scheduling of the visible app rather than background's. */
    private fun bindCoach() {
        bindService(Intent(this, CoachService::class.java), this, Context.BIND_AUTO_CREATE or Context.BIND_IMPORTANT)
    }

    /** Frees the model's memory; the next explanation loads it again. */
    private fun releaseCoach() {
        try {
            coach?.send(Message.obtain())
        } catch (_: RemoteException) {
            // Its process is gone, and the memory with it.
        }
    }

    override fun onServiceConnected(name: ComponentName, service: IBinder) {
        coach = Messenger(service)
    }

    override fun onServiceDisconnected(name: ComponentName) {
        coach = null // Android restarts it
    }

    override fun onBindingDied(name: ComponentName) {
        unbindService(this)
        bindCoach()
    }

    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        if (level >= ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN) releaseCoach()
    }
}
