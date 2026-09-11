// Pure parsing for the shell browser-auth handoff boots, mirroring
// snapshotBoot.ts: ?shell_auth=1&port=..&state=.. boots the Chrome-side
// handoff page, ?__clerk_ticket=.. is the webview-side sign-in ticket.

export interface ShellAuthParams {
  port: number;
  state: string;
}

export function parseShellAuthParams(search: string): ShellAuthParams | null {
  const q = new URLSearchParams(search);
  if (q.get("shell_auth") !== "1") return null;
  const port = Number(q.get("port"));
  const state = q.get("state");
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !state) return null;
  return { port, state };
}

export function parseClerkTicket(search: string): string | null {
  return new URLSearchParams(search).get("__clerk_ticket") || null;
}
