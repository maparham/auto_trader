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
  return null;
}
