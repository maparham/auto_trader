// Chrome side of the shell browser-auth handoff (?shell_auth=1&port=..&state=..).
// Rendered inside <SignedIn>, so by the time this runs the user is
// authenticated in this browser. Mints a single-use Clerk sign-in token via
// the backend and hands it to the shell's loopback listener with a TOP-LEVEL
// redirect: a fetch from an https page to http://127.0.0.1 would be blocked
// as mixed content, a navigation is not.
import { useEffect, useRef, useState } from "react";
import { API_BASE, apiFetch } from "../lib/http";
import type { ShellAuthParams } from "../lib/shellAuthBoot";

export default function ShellAuthHandoff({ params }: { params: ShellAuthParams }) {
  const [error, setError] = useState<string | null>(null);
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
      const u = new URL(`http://127.0.0.1:${params.port}/callback`);
      u.searchParams.set("ticket", body.token);
      u.searchParams.set("state", params.state);
      window.location.replace(u.toString());
    })();
  }, [params]);

  return (
    <div style={{ display: "grid", placeItems: "center", minHeight: "100vh" }}>
      <div style={{ textAlign: "center", maxWidth: 420 }}>
        {error
          ? `Handoff failed: ${error}. Close this tab and click the sign-in button in Chartkar again.`
          : "Signing in to Chartkar..."}
      </div>
    </div>
  );
}
