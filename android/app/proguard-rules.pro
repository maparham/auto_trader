# The page calls ChartkarAndroid.invoke through @JavascriptInterface.
-keepclassmembers class app.chartkar.android.ShellBridge {
    @android.webkit.JavascriptInterface <methods>;
}
