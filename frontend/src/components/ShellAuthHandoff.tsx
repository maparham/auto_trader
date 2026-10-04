// Browser side of the shell browser-auth handoff. Rendered inside <SignedIn>,
// so by the time this runs the user is authenticated in this browser. Mints a
// single-use Clerk sign-in token via the backend, then returns it by shape:
// - loopback (?shell_auth=1&port=..&state=.., desktop shell): a TOP-LEVEL
//   redirect to the shell's loopback listener. A fetch from an https page to
//   http://127.0.0.1 would be blocked as mixed content, a navigation is not.
// - app (?shell_auth=1&return=app&state=.., Android app): a "Return to
//   Chartkar" intent-URL link the user taps to hand the ticket to the app.
import { useEffect, useRef, useState } from "react";
import { API_BASE, apiFetch } from "../lib/http";
import { appReturnIntentUrl, type ShellAuthParams } from "../lib/shellAuthBoot";

export default function ShellAuthHandoff({ params }: { params: ShellAuthParams }) {
  const [error, setError] = useState<string | null>(null);
  const [appTicket, setAppTicket] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    // The token is single-use and the redirect leaves the page: never run
    // twice (StrictMode mounts effects twice in dev).
    if (started.current) return;
    started.current = true;
    void (async () => {
      let res: Response;
      try {
        res = await apiFetch(`${API_BASE}/api/auth/shell-token`, { method: "POST" });
      } catch {
        setError("could not reach the backend");
        return;
      }
      if (!res.ok) {
        setError(`sign-in token request failed (${res.status})`);
        return;
      }
      const body = (await res.json().catch(() => null)) as { token?: string } | null;
      if (!body?.token) {
        setError("the response carried no token");
        return;
      }
      if (params.kind === "app") {
        // A tap is required: Chrome only hands an intent URL to an app on a
        // user gesture. The token's 5 minute TTL already started at the mint.
        setAppTicket(body.token);
        return;
      }
      const u = new URL(`http://127.0.0.1:${params.port}/callback`);
      u.searchParams.set("ticket", body.token);
      u.searchParams.set("state", params.state);
      window.location.replace(u.toString());
    })();
  }, [params]);

  return (
    <div style={{ display: "grid", placeItems: "center", minHeight: "100vh" }}>
      <div style={{ textAlign: "center", maxWidth: 420 }}>
        {error ? (
          `Handoff failed: ${error}. Close this tab and tap the sign-in button in Chartkar again.`
        ) : appTicket ? (
          <div style={{ display: "grid", gap: 12, justifyItems: "center" }}>
            <a
              href={appReturnIntentUrl(appTicket, params.state)}
              style={{
                background: "var(--accent)",
                color: "var(--accent-text)",
                borderRadius: 8,
                padding: "12px 28px",
                fontSize: 15,
                fontWeight: 600,
                textDecoration: "none",
              }}
            >
              Return to Chartkar
            </a>
            <div>This link works for 5 minutes. If it has expired, sign in from the app again.</div>
          </div>
        ) : (
          "Signing in to Chartkar..."
        )}
      </div>
    </div>
  );
}
