package app.chartkar.android

import java.net.URI
import java.net.URLEncoder

/**
 * One FCM alert message (backend core/fcm_notify.py, data-only) turned into
 * what the notification shows and opens. Pure, so JVM tests cover it.
 * A tap opens the alert's chart (`?alertEpic=..&alertBroker=..`), an account
 * alert just the app; a position alert adds Remove SL / Remove TP, which opens
 * `?removeLevel=<token>` where the page asks before removing
 * (frontend/src/lib/appPush.ts).
 */
object AlertPush {
    data class Action(val label: String, val url: String)
    data class Note(val title: String, val body: String, val tapUrl: String, val action: Action?, val tag: String)

    fun from(startUrl: String, d: Map<String, String>): Note? {
        val title = d["title"].orEmpty()
        val body = d["body"].orEmpty()
        if (title.isEmpty() && body.isEmpty()) return null
        val root = root(startUrl)
        val kind = d["kind"] ?: "price"
        val epic = d["epic"].orEmpty()
        val tap = if (kind.startsWith("account") || epic.isEmpty()) {
            root
        } else {
            val broker = d["broker"].orEmpty()
            "$root?alertEpic=${enc(epic)}" + (if (broker.isEmpty()) "" else "&alertBroker=${enc(broker)}")
        }
        val token = d["removeToken"]
        val side = d["side"]
        val action = if (kind == "position" && !token.isNullOrEmpty() && (side == "sl" || side == "tp")) {
            Action(if (side == "sl") "Remove SL" else "Remove TP", "$root?removeLevel=${enc(token)}")
        } else {
            null
        }
        val tag = "$kind|${d["id"].orEmpty()}|$epic"
        return Note(title, body, tap, action, tag)
    }

    /** One notification per alert: a repeat fire replaces the last one. */
    fun notificationId(alertId: String): Int = alertId.hashCode() and 0x7fffffff

    private fun root(startUrl: String): String {
        val u = URI(startUrl)
        val port = if (u.port == -1) "" else ":${u.port}"
        return "${u.scheme}://${u.host}$port/"
    }

    private fun enc(s: String): String = URLEncoder.encode(s, "UTF-8")
}
