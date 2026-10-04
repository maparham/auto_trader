// /app-auth/callback is the Android App Link target. The app normally
// receives it; this page only renders when the link opened in a browser
// instead (app not installed, link not verified). Same pathname-only
// routing as adminBoot.ts.
export function shouldBootAppAuthCallback(pathname: string = window.location.pathname): boolean {
  return pathname.replace(/\/+$/, "") === "/app-auth/callback";
}
