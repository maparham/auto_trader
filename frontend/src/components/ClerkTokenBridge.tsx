// Registers Clerk's token getter and sign-out with the plain-module HTTP/WS
// clients (lib/authToken, lib/http). Rendered inside ClerkProvider only; in
// local dev (no Clerk key) it never mounts and both hooks stay null.
import { useEffect } from "react";
import { useAuth, useClerk } from "@clerk/clerk-react";
import { setTokenGetter } from "../lib/authToken";
import { setUnauthorizedHandler } from "../lib/http";

export default function ClerkTokenBridge() {
  const { getToken } = useAuth();
  const clerk = useClerk();
  useEffect(() => {
    // `fresh` (the 401-retry path) forces a newly minted token: Clerk's cache
    // would otherwise hand back the very token the server just rejected.
    setTokenGetter((opts) => getToken(opts?.fresh ? { skipCache: true } : undefined));
    setUnauthorizedHandler(() => {
      void clerk.signOut();
    });
    return () => {
      setTokenGetter(null);
      setUnauthorizedHandler(null);
    };
  }, [getToken, clerk]);
  // Mint a token as soon as the tab comes back or the network returns, so the
  // first requests after a laptop wake don't go out on the expired cached one
  // (each would 401 and need its own retry).
  useEffect(() => {
    const warm = () => {
      if (document.visibilityState !== "visible") return;
      getToken({ skipCache: true }).catch(() => {});
    };
    document.addEventListener("visibilitychange", warm);
    window.addEventListener("online", warm);
    return () => {
      document.removeEventListener("visibilitychange", warm);
      window.removeEventListener("online", warm);
    };
  }, [getToken]);
  return null;
}
