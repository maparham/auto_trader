// The one seam between the web app and the native Tauri shell (tauri-shell/).
// Everything here is a no-op in a plain browser: `inShell()` is false and
// `shellInvoke` resolves to null, so callers never need a guard of their own.

type TauriGlobal = {
  core?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
};

function tauri(): TauriGlobal | null {
  const g = (window as unknown as Record<string, unknown>).__TAURI__;
  return g ? (g as TauriGlobal) : null;
}

/** True only when the page is running inside the native shell. */
export function inShell(): boolean {
  return tauri() !== null;
}

/** Call a shell command. Resolves to null in a browser, or if the call fails:
 *  the shell is a convenience layer, so a broken bridge must never break the
 *  trading UI. */
export async function shellInvoke(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  const invoke = tauri()?.core?.invoke;
  if (!invoke) return null;
  try {
    return await invoke(cmd, args);
  } catch {
    return null;
  }
}
