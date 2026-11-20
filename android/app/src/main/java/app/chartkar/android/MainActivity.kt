package app.chartkar.android

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * The whole app: one WebView on chartkar.app (BuildConfig.START_URL), browser
 * sign-in through an App Link, back handled by the page first, and the
 * `window.ChartkarAndroid` bridge. Design:
 * docs/superpowers/specs/2026-11-20-native-android-shell-design.md.
 */
class MainActivity : ComponentActivity(), ShellBridge.Host {
    companion object {
        /** A same-origin page to open, from a tapped notification. */
        const val EXTRA_OPEN_URL = "app.chartkar.android.OPEN_URL"
        private const val PREFS = "auth"
        private const val PENDING_KEY = "pending"
        private const val ASKED_NOTIFY_KEY = "askedNotify"
    }

    private lateinit var webView: WebView
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    private val pickFiles = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res.resultCode, res.data))
        fileCallback = null
    }

    private val askNotify = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override val context: Context get() = this

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        Notifications.ensureChannel(this)

        val root = FrameLayout(this)
        webView = WebView(this)
        root.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)
        // Edge-to-edge is enforced from target SDK 35: keep the page clear of
        // the status bar, the navigation bar and the keyboard.
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, true)
        }
        webView.addJavascriptInterface(ShellBridge(this), "ChartkarAndroid")
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (staysInApp(url)) return false
                openExternal(url)
                return true
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams,
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return try {
                    pickFiles.launch(params.createIntent())
                    true
                } catch (_: Exception) {
                    fileCallback = null
                    false
                }
            }
        }

        // Back asks the page first: an open sheet closes (frontend/src/mobile/
        // backStack.ts), then WebView history, then the app leaves.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                webView.evaluateJavascript(
                    "typeof window.__chartkarBack === 'function' && window.__chartkarBack()",
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

        val restored = savedInstanceState != null && webView.restoreState(savedInstanceState) != null
        if (!handleIntent(intent) && !restored) webView.loadUrl(BuildConfig.START_URL)
        askNotificationPermissionOnce()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    // The WebView writes cookies to disk on its own schedule (about every
    // 30 s), so swiping the app away right after sign-in lost Clerk's session
    // cookie. Flush whenever the app leaves the foreground.
    override fun onPause() {
        super.onPause()
        CookieManager.getInstance().flush()
    }

    /** A sign-in callback or a notification's page. True when it loaded a page. */
    private fun handleIntent(intent: Intent?): Boolean {
        if (intent == null) return false
        intent.getStringExtra(EXTRA_OPEN_URL)?.let { url ->
            intent.removeExtra(EXTRA_OPEN_URL)
            if (staysInApp(Uri.parse(url))) {
                webView.loadUrl(url)
                return true
            }
        }
        val data = intent.data?.toString() ?: return false
        if (intent.action != Intent.ACTION_VIEW) return false
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        val pending = SignIn.Pending.decode(prefs.getString(PENDING_KEY, null))
        val target = SignIn.resolve(pending, data, nowSecs()) ?: return false
        prefs.edit().remove(PENDING_KEY).apply()
        intent.data = null
        val base = webView.url?.takeIf { staysInApp(Uri.parse(it)) } ?: BuildConfig.START_URL
        webView.loadUrl(SignIn.appUrl(base, target.key, target.value))
        return true
    }

    override fun startBrowserSignIn(): Boolean {
        val p = SignIn.Pending(SignIn.randomState(), nowSecs() + SignIn.TTL_SECS)
        // Persisted first: Android may kill the app while the user is in the browser.
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(PENDING_KEY, p.encode()).commit()
        runOnUiThread { openExternal(Uri.parse(SignIn.handoffUrl(p.state))) }
        return true
    }

    /** chartkar.app and its subdomains (Clerk) and the start origin stay in
     *  the WebView; every other link opens in the browser. */
    private fun staysInApp(url: Uri): Boolean {
        val host = url.host ?: return false
        val start = Uri.parse(BuildConfig.START_URL)
        if (host == start.host && url.port == start.port) return true
        return url.scheme == "https" && (host == "chartkar.app" || host.endsWith(".chartkar.app"))
    }

    private fun openExternal(url: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (_: Exception) {
            // No browser installed: nothing sensible to do.
        }
    }

    private fun askNotificationPermissionOnce() {
        if (Build.VERSION.SDK_INT < 33 || Notifications.canPost(this)) return
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        if (prefs.getBoolean(ASKED_NOTIFY_KEY, false)) return
        prefs.edit().putBoolean(ASKED_NOTIFY_KEY, true).apply()
        askNotify.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    private fun nowSecs(): Long = System.currentTimeMillis() / 1000
}
