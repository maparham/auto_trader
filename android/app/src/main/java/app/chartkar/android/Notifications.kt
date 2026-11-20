package app.chartkar.android

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/** Local notifications: the page's `notify_native` (an alert that fires while
 *  the app is open) and, later, FCM pushes share the "alerts" channel. */
object Notifications {
    const val CHANNEL_ALERTS = "alerts"

    fun ensureChannel(ctx: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(CHANNEL_ALERTS) != null) return
        val ch = NotificationChannel(
            CHANNEL_ALERTS,
            ctx.getString(R.string.channel_alerts),
            NotificationManager.IMPORTANCE_HIGH,
        )
        ch.description = ctx.getString(R.string.channel_alerts_desc)
        nm.createNotificationChannel(ch)
    }

    fun canPost(ctx: Context): Boolean =
        Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED

    /** Posts one alert. `url`, when set, is opened in the app on tap. */
    fun post(ctx: Context, title: String, body: String, url: String? = null, id: Int = nextId()) {
        ensureChannel(ctx)
        if (!canPost(ctx)) return
        val open = Intent(ctx, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        if (url != null) open.putExtra(MainActivity.EXTRA_OPEN_URL, url)
        val pi = PendingIntent.getActivity(
            ctx, id, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val n = NotificationCompat.Builder(ctx, CHANNEL_ALERTS)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()
        try {
            NotificationManagerCompat.from(ctx).notify(id, n)
        } catch (_: SecurityException) {
            // Permission revoked between the check and the post.
        }
    }

    /** An FCM alert: tap opens its page in the app; a position alert adds
     *  its Remove SL / Remove TP button. */
    fun postAlert(ctx: Context, note: AlertPush.Note, alertId: String) {
        ensureChannel(ctx)
        if (!canPost(ctx)) return
        val id = if (alertId.isEmpty()) nextId() else AlertPush.notificationId(note.tag)
        val b = NotificationCompat.Builder(ctx, CHANNEL_ALERTS)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(note.title)
            .setContentText(note.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(note.body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(openIntent(ctx, note.tapUrl, id * 2))
        note.action?.let { b.addAction(0, it.label, openIntent(ctx, it.url, id * 2 + 1)) }
        try {
            NotificationManagerCompat.from(ctx).notify(id, b.build())
        } catch (_: SecurityException) {
            // Permission revoked between the check and the post.
        }
    }

    private fun openIntent(ctx: Context, url: String, requestCode: Int): PendingIntent {
        val open = Intent(ctx, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(MainActivity.EXTRA_OPEN_URL, url)
        return PendingIntent.getActivity(
            ctx, requestCode, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private var counter = 0
    @Synchronized
    private fun nextId(): Int = (System.currentTimeMillis() / 1000).toInt() * 16 + (counter++ and 15)
}
