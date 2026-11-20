// The one seam between the web app and a native shell: the desktop Tauri
// shell (tauri-shell/), the old Tauri Android app (tauri-android/), and the
// native Kotlin Android app (android/), which exposes `window.ChartkarAndroid`.
// Everything here is a no-op in a plain browser: `inShell()` is false and
// `shellInvoke` resolves to null, so callers never need a guard of their own.

type TauriGlobal = {
  core?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
};

/** The Kotlin app's JavascriptInterface: a synchronous call that takes the
 *  args as JSON and returns its reply as JSON ("null" for no answer). */
type AndroidBridge = { invoke: (cmd: string, argsJson: string) => string };

function tauri(): TauriGlobal | null {
  const g = (window as unknown as Record<string, unknown>).__TAURI__;
  return g ? (g as TauriGlobal) : null;
}

function android(): AndroidBridge | null {
  if (typeof window === "undefined") return null;
  const g = (window as unknown as Record<string, unknown>).ChartkarAndroid;
  return g ? (g as AndroidBridge) : null;
}

/** True only when the page is running inside a native shell. */
export function inShell(): boolean {
  return tauri() !== null || android() !== null;
}

/** Call a shell command. Resolves to null in a browser, or if the call fails:
 *  the shell is a convenience layer, so a broken bridge must never break the
 *  trading UI. */
export async function shellInvoke(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  const a = android();
  if (a) {
    try {
      return JSON.parse(a.invoke(cmd, JSON.stringify(args ?? {}))) as unknown;
    } catch {
      return null;
    }
  }
  const invoke = tauri()?.core?.invoke;
  if (!invoke) return null;
  try {
    return await invoke(cmd, args);
  } catch {
    return null;
  }
}

/** True only inside an Android app (android/ or tauri-android/). The desktop
 *  shell is also a Tauri webview, so Android-only behavior must key on this,
 *  never on inShell() alone. */
export function inAndroidApp(): boolean {
  if (android()) return true;
  return tauri() !== null && typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
}
