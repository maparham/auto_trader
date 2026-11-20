package app.chartkar.android

import android.content.ClipboardManager
import android.content.Context
import android.webkit.JavascriptInterface
import org.json.JSONObject

/**
 * `window.ChartkarAndroid` in the page (frontend/src/lib/shellBridge.ts).
 * One synchronous entry point: `invoke(cmd, argsJson)` returns a JSON string,
 * "null" for an unknown command or a failure, so the page never needs a try.
 * Runs on the WebView's binder thread; anything that touches views posts to
 * the main thread through `host`.
 */
class ShellBridge(private val host: Host) {
    interface Host {
        val context: Context
        /** Opens the browser on the sign-in handoff page. */
        fun startBrowserSignIn(): Boolean
    }

    @JavascriptInterface
    fun invoke(cmd: String, argsJson: String): String = try {
        val args = try { JSONObject(argsJson) } catch (_: Exception) { JSONObject() }
        when (cmd) {
            "browser_sign_in" -> if (host.startBrowserSignIn()) "true" else "null"
            "notify_native" -> {
                Notifications.post(host.context, args.optString("title"), args.optString("body"))
                "true"
            }
            "read_clipboard" -> readClipboard()
            else -> "null"
        }
    } catch (_: Exception) {
        "null"
    }

    private fun readClipboard(): String {
        val cm = host.context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return "null"
        val text = cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(host.context)?.toString()
        return if (text == null) "null" else JSONObject.quote(text)
    }
}
