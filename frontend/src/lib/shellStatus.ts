// Mirror the live engine's status onto the native shell's menu-bar glyph.
// A no-op in a plain browser, and the only place that knows the mapping from
// LiveStatus to the shell's three-colour tray icon.
import { liveStateSignal } from "./liveController";
import type { LiveStatus } from "./liveState";
import { inShell, shellInvoke } from "./shellBridge";

type ShellStatus = "live" | "idle" | "error";

function glyphFor(status: LiveStatus): ShellStatus {
  switch (status) {
    case "armed":
      return "live";
    case "lost-lease":
      return "error";
    default:
      return "idle";
  }
}

/** Start mirroring; returns an unsubscribe. Safe to call in any environment.
 *  `Signal.subscribe` does not emit the current value, so nothing is reported
 *  until the first real transition, which is right: the tray starts on idle. */
export function startShellStatusMirror(): () => void {
  if (!inShell()) return () => {};
  let last: ShellStatus | null = null;
  return liveStateSignal.subscribe((s) => {
    const next = glyphFor(s.status);
    if (next === last) return;
    last = next;
    void shellInvoke("set_status", { state: next });
  });
}
