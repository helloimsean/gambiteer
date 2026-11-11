package com.gambiteer.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Handler
import android.os.IBinder
import android.os.Looper

/**
 * Keeps coach downloads going while the app is in the background, which Android only allows a
 * foreground service with a notification. CoachModels runs the downloads; this shows their progress
 * and stops once none is left.
 */
class ModelDownloadService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private val models get() = (application as GambiteerApp).models

    private val tick = object : Runnable {
        override fun run() {
            val active = models.activeDownloads()
            if (active.isEmpty()) {
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                return
            }
            getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(active))
            handler.postDelayed(this, TICK_MS)
        }
    }

    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "Coach downloads", NotificationManager.IMPORTANCE_LOW),
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, notification(models.activeDownloads()), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        handler.removeCallbacks(tick)
        handler.post(tick)
        return START_NOT_STICKY
    }

    /** Android 15+ limits how long a data sync may run in the background: pause, resume on next open. */
    override fun onTimeout(startId: Int, fgsType: Int) {
        models.pauseDownloads()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        handler.removeCallbacks(tick)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun notification(active: List<ModelDownload>): Notification {
        val total = active.sumOf { it.model.bytes }
        val done = active.sumOf { it.downloaded }
        val first = active.firstOrNull()
        val text = when {
            first == null -> "Starting…"
            first.verifying -> "Checking ${first.model.label}…"
            first.note != null -> first.note
            else -> "${first.model.label}: %.1f of %.1f GB".format(done / 1e9, total / 1e9)
        }
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle("Downloading the coach")
            .setContentText(text)
            .setProgress(PROGRESS_MAX, if (total > 0) (done * PROGRESS_MAX / total).toInt() else 0, first == null)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
            .setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    companion object {
        private const val CHANNEL = "downloads"
        private const val NOTIFICATION_ID = 7
        private const val TICK_MS = 1000L
        private const val PROGRESS_MAX = 1000
    }
}
