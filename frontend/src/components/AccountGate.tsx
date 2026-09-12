import type { ReactNode } from "react";
import { useUser } from "@clerk/clerk-react";
import { PREFIX, wipeWorkspaceKeys } from "../lib/workspaceKeys";
import { setImpersonatedUserId } from "../lib/impersonation";

const LAST_USER_KEY = `${PREFIX}.lastUserId`;

/** Hosted-only guard between <SignedIn> and <App />. The hosted hydrate keeps
 * device-local keys (activeLayoutId/scratch/autosave) on purpose; on a shared
 * browser that leaks user A's layout state to user B. The wipe runs during
 * render, before children mount, so the persist hydrate never sees stale keys.
 * The stamp is a raw string (not JSON): no other code reads it, but it IS
 * listed in persist/core's DEVICE_LOCAL_FLAT_KEYS so the hosted hydrate's
 * prune keeps it (otherwise every reload would look like an account switch).
 *
 * Also clears a stale impersonation flag: signing out and back in as a
 * DIFFERENT user must not leave every request carrying X-Impersonate-User
 * for someone who isn't the target. But enterImpersonation's own reload has
 * no stamp change at all (the Clerk user is unchanged, by design), so this
 * can only clear the flag when the stamp was PRESENT and different, never on
 * the post-enter boot where there is no prior stamp to compare against. */
export default function AccountGate({ children }: { children: ReactNode }) {
  const { isLoaded, user } = useUser();
  if (!isLoaded || !user) return null; // <SignedIn> makes this transient
  const prev = localStorage.getItem(LAST_USER_KEY);
  if (prev !== user.id) {
    wipeWorkspaceKeys();
    if (prev) setImpersonatedUserId(null);
    localStorage.setItem(LAST_USER_KEY, user.id);
  }
  return <>{children}</>;
}
