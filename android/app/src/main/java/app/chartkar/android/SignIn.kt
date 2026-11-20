package app.chartkar.android

import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.SecureRandom

/**
 * Browser sign-in, pure rules (no Android types, so JVM tests cover them).
 * The app opens chartkar.app's handoff page with a random state; the page
 * mints a single-use Clerk ticket and returns it through the App Link
 * https://chartkar.app/app-auth/callback?ticket=..&state=..; the app checks
 * the state and loads the page with ?__clerk_ticket=. Same rules as the Tauri
 * app's auth.rs. The pending state is persisted by the caller, because
 * Android may kill the app while the user is in the browser.
 */
object SignIn {
    const val TTL_SECS = 300L
    private const val CALLBACK_HOST = "chartkar.app"
    private const val CALLBACK_PATH = "/app-auth/callback"
    private const val HANDOFF_ORIGIN = "https://chartkar.app/"

    data class Pending(val state: String, val expiresAt: Long) {
        fun encode(): String = "$state|$expiresAt"

        companion object {
            fun decode(raw: String?): Pending? {
                val parts = raw?.split("|") ?: return null
                if (parts.size != 2 || parts[0].isEmpty()) return null
                val exp = parts[1].toLongOrNull() ?: return null
                return Pending(parts[0], exp)
            }
        }
    }

    data class Callback(val ticket: String, val state: String)

    sealed class Outcome {
        data class Accept(val ticket: String) : Outcome()
        object Expired : Outcome()
        object Mismatch : Outcome()
    }

    /** The query key and value to load the page with. */
    data class Target(val key: String, val value: String)

    fun randomState(): String {
        val b = ByteArray(32)
        SecureRandom().nextBytes(b)
        return b.joinToString("") { "%02x".format(it) }
    }

    /** "https://chartkar.app/app-auth/callback?ticket=..&state=.." to its
     *  values. Any other scheme, host or path, or a missing value, is null. */
    fun parseCallback(raw: String): Callback? {
        val u = try { URI(raw) } catch (_: Exception) { return null }
        if (u.scheme != "https" || u.host != CALLBACK_HOST) return null
        if ((u.path ?: "").trimEnd('/') != CALLBACK_PATH) return null
        var ticket: String? = null
        var state: String? = null
        for (pair in (u.rawQuery ?: "").split("&")) {
            val i = pair.indexOf('=')
            if (i < 0) continue
            val k = URLDecoder.decode(pair.substring(0, i), "UTF-8")
            val v = URLDecoder.decode(pair.substring(i + 1), "UTF-8")
            when (k) {
                "ticket" -> ticket = v
                "state" -> state = v
            }
        }
        if (ticket.isNullOrEmpty() || state.isNullOrEmpty()) return null
        return Callback(ticket, state)
    }

    /** Nothing pending or past the deadline: Expired. A different state:
     *  Mismatch (dropped; a newer attempt stays pending). Otherwise Accept. */
    fun decide(pending: Pending?, state: String, ticket: String, now: Long): Outcome = when {
        pending == null -> Outcome.Expired
        pending.state != state -> Outcome.Mismatch
        now > pending.expiresAt -> Outcome.Expired
        else -> Outcome.Accept(ticket)
    }

    /** A callback URL to the page target, or null when it is not one of ours
     *  or belongs to another attempt. The caller clears the pending state
     *  whenever this returns non-null. */
    fun resolve(pending: Pending?, raw: String, now: Long): Target? {
        val cb = parseCallback(raw) ?: return null
        return when (val o = decide(pending, cb.state, cb.ticket, now)) {
            is Outcome.Accept -> Target("__clerk_ticket", o.ticket)
            Outcome.Expired -> Target("auth_error", "expired")
            Outcome.Mismatch -> null
        }
    }

    fun handoffUrl(state: String): String =
        "${HANDOFF_ORIGIN}?shell_auth=1&return=app&state=${enc(state)}"

    /** The page's origin root with one query pair. */
    fun appUrl(current: String, key: String, value: String): String {
        val u = URI(current)
        val port = if (u.port == -1) "" else ":${u.port}"
        return "${u.scheme}://${u.host}$port/?${enc(key)}=${enc(value)}"
    }

    private fun enc(s: String): String = URLEncoder.encode(s, "UTF-8")
}
