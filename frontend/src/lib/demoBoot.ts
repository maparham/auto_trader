// Boot-branch decision for the signed-out demo home page: when should the
// sign-in card win over the demo instead? Kept tiny and pure so main.tsx's
// wiring stays declarative and this stays unit-testable.
import { inShell } from "./shellBridge";

/** True when the sign-in card should render instead of the demo: an explicit
 *  `?sign_in=1` ask, or the native shell (it drives live trading, so a
 *  signed-out visitor there always needs a real sign-in, never the public
 *  demo). Everything else (a plain signed-out browser visit) gets the demo. */
export function shouldShowSignIn(search: string): boolean {
  if (new URLSearchParams(search).get("sign_in") === "1") return true;
  return inShell();
}

