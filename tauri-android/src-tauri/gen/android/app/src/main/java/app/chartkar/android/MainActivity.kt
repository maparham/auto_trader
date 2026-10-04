package app.chartkar.android

import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  // Back asks the page first: an open sheet closes (frontend/src/mobile/
  // backStack.ts). Wry's own handler only knows WebView history, and sheets
  // keep none, so with a sheet open it closed the whole app instead.
  override val handleBackNavigation: Boolean = false

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  // The WebView writes cookies to disk on its own schedule (about every 30 s),
  // so swiping the app away right after sign-in lost Clerk's session cookie.
  // Flush whenever the app leaves the foreground.
  override fun onPause() {
    super.onPause()
    CookieManager.getInstance().flush()
  }

  override fun onWebViewCreate(webView: WebView) {
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        webView.evaluateJavascript(
          "typeof window.__chartkarBack === 'function' && window.__chartkarBack()"
        ) { handled ->
          if (handled == "true") return@evaluateJavascript
          if (webView.canGoBack()) {
            webView.goBack()
            return@evaluateJavascript
          }
          isEnabled = false
          onBackPressedDispatcher.onBackPressed()
          isEnabled = true
        }
      }
    })
  }
}
