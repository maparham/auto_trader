// Pure parsing for the shell browser-auth handoff boots, mirroring
// snapshotBoot.ts. Two handoff shapes boot the browser-side page:
// ?shell_auth=1&port=..&state=.. (desktop shell, loopback return) and
// ?shell_auth=1&return=app&state=.. (Android app, intent-URL return).
// ?__clerk_ticket=.. is the webview-side sign-in ticket.

export type ShellAuthParams =
  | { kind: "loopback"; port: number; state: string }
  | { kind: "app"; state: string };

export const APP_CALLBACK_URL = "https://chartkar.app/app-auth/callback";
export const APP_PACKAGE = "app.chartkar.android";

export function parseShellAuthParams(search: string): ShellAuthParams | null {
  const q = new URLSearchParams(search);
  if (q.get("shell_auth") !== "1") return null;
  const state = q.get("state");
  if (!state) return null;
  if (q.get("return") === "app") return { kind: "app", state };
  const port = Number(q.get("port"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { kind: "loopback", port, state };
}

/** The Android return link. An intent URL, not the plain https callback:
 *  Chrome does not hand a same-site navigation to an App Link app, and an
 *  intent URL on a tap opens the pinned package regardless of domain. The
 *  fallback (app not installed) carries no ticket. */
export function appReturnIntentUrl(ticket: string, state: string): string {
  const q = new URLSearchParams({ ticket, state });
  const cb = new URL(APP_CALLBACK_URL);
  return (
    `intent://${cb.host}${cb.pathname}?${q.toString()}` +
    `#Intent;scheme=https;package=${APP_PACKAGE};` +
    `S.browser_fallback_url=${encodeURIComponent(APP_CALLBACK_URL)};end`
  );
}

export function parseClerkTicket(search: string): string | null {
  return new URLSearchParams(search).get("__clerk_ticket") || null;
}
