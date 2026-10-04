// The signed-out screen, extended for the native shell's browser-auth handoff.
//
// Two jobs, both no-ops in a plain browser session:
// - Consume a ?__clerk_ticket= sign-in token (delivered by the shell after the
//   Chrome handoff). Consumed EXPLICITLY, with the Clerk card unmounted while
//   pending: the ticket is single-use, so nothing else may also try it.
// - Offer "Sign in with your browser" when running inside the shell, which
//   asks the shell (browser_sign_in) to start the loopback handoff.
//
// In the Android app the browser is the only sign-in path: the Clerk card is
// hidden, browser_sign_in replies true, and the app lands back here with
// ?auth_error=expired when a callback found nothing pending or arrived late.
import { useEffect, useRef, useState } from "react";
import { SignIn, useSignIn } from "@clerk/clerk-react";
import { parseAuthError, parseClerkTicket } from "../lib/shellAuthBoot";
import { inAndroidApp, inShell, shellInvoke } from "../lib/shellBridge";

function stripTicketParam(): void {
  const u = new URL(window.location.href);
  u.searchParams.delete("__clerk_ticket");
  window.history.replaceState(null, "", u.toString());
}

function stripAuthErrorParam(): void {
  const u = new URL(window.location.href);
  u.searchParams.delete("auth_error");
  window.history.replaceState(null, "", u.toString());
}

export default function ShellTicketSignIn() {
  // Read once on mount: the param is stripped as soon as the attempt settles.
  const [ticket] = useState(() => parseClerkTicket(window.location.search));
  const [ticketFailed, setTicketFailed] = useState(false);
  const [buttonError, setButtonError] = useState(false);
  // Read once on mount, then stripped so a reload does not repeat it.
  const [expired] = useState(() => parseAuthError(window.location.search) === "expired");
  const android = inAndroidApp();
  const tried = useRef(false);
  const { signIn, setActive, isLoaded } = useSignIn();

  useEffect(() => {
    if (!ticket || !isLoaded || tried.current) return;
    tried.current = true;
    void (async () => {
      try {
        const res = await signIn.create({ strategy: "ticket", ticket });
        stripTicketParam();
        if (res.status === "complete" && res.createdSessionId) {
          await setActive({ session: res.createdSessionId });
        } else {
          setTicketFailed(true);
        }
      } catch {
        stripTicketParam();
        setTicketFailed(true);
      }
    })();
  }, [ticket, isLoaded, signIn, setActive]);

  useEffect(() => {
    if (expired) stripAuthErrorParam();
  }, [expired]);

  if (ticket && !ticketFailed) {
    return (
      <div style={{ display: "grid", placeItems: "center", minHeight: "100vh" }}>
        Signing you in...
      </div>
    );
  }

  return (
    <div style={{ display: "grid", placeItems: "center", minHeight: "100vh" }}>
      <div style={{ display: "grid", justifyItems: "center", gap: 14 }}>
        {!android && <SignIn />}
        {inShell() && (
          <div style={{ textAlign: "center" }}>
            {expired && <div>Sign-in expired, try again.</div>}
            <button
              type="button"
              onClick={() => {
                setButtonError(false);
                // Desktop replies with its loopback port, Android with true;
                // shellInvoke maps a failure to null.
                void shellInvoke("browser_sign_in").then((reply) => {
                  if (typeof reply !== "number" && reply !== true) setButtonError(true);
                });
              }}
              style={{
                background: "var(--accent)",
                color: "var(--accent-text)",
                border: "none",
                borderRadius: 8,
                padding: "12px 28px",
                fontSize: 15,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Sign in with your browser
            </button>
            {buttonError && (
              <div>Could not start browser sign-in. Try again.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
