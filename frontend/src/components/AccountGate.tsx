import type { ReactNode } from "react";
import { useUser } from "@clerk/clerk-react";
import { PREFIX } from "../lib/persist/core";

const LAST_USER_KEY = `${PREFIX}.lastUserId`;

/** Hosted-only guard between <SignedIn> and <App />. The hosted hydrate keeps
 * device-local keys (activeLayoutId/scratch/autosave) on purpose; on a shared
 * browser that leaks user A's layout state to user B. The wipe runs during
 * render, before children mount, so the persist hydrate never sees stale keys.
 * The stamp is a raw string (not JSON): no other code reads it. */
export default function AccountGate({ children }: { children: ReactNode }) {
  const { isLoaded, user } = useUser();
  if (!isLoaded || !user) return null; // <SignedIn> makes this transient
  if (localStorage.getItem(LAST_USER_KEY) !== user.id) {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(`${PREFIX}.`)) localStorage.removeItem(key);
    }
    localStorage.setItem(LAST_USER_KEY, user.id);
  }
  return <>{children}</>;
}
