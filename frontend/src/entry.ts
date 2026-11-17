// Page entry. index.html's inline head script marks <html data-landing> when
// the static home page should show (signed-out visitor on chartkar.app's bare
// "/"). The home page is plain HTML, so the app's code is not even fetched
// then; every other visit boots the app exactly as before.
if (!document.documentElement.hasAttribute('data-landing')) {
  void import('./main.tsx')
}
