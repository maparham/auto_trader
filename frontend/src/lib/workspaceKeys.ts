// The workspace key namespace, and the one way to clear it. Imports nothing
// but demoPreview (itself a leaf), deliberately: persist/core imports
// impersonation (for the mirror gate) and impersonation needs the wipe, so
// parking the wipe in either of them would close an import cycle.
import { isDemoPreview, PREVIEW_PREFIX } from "./demoPreview";

/** Every workspace key hangs off this. An admin previewing the public demo
 *  gets a namespace of its own so the seeded demo layout cannot land on top
 *  of their real one; see demoPreview.ts. Decided once at module init from
 *  the URL, so the many `const KEY = `${PREFIX}.x`` constants around the app
 *  are correct no matter what order modules load in. */
export const PREFIX = isDemoPreview() ? PREVIEW_PREFIX : "auto-trader";

/** Remove every namespaced workspace key from localStorage.
 *
 *  Two callers, wiping for the same reason: the local store is broker-keyed,
 *  not user-keyed, so without this one user's workspace sits on top of
 *  another's. AccountGate wipes when the signed-in Clerk user changes;
 *  impersonation wipes on entering and leaving a session, where the Clerk user
 *  does NOT change and so AccountGate never fires. */
export function wipeWorkspaceKeys(): void {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(`${PREFIX}.`)) localStorage.removeItem(key);
  }
}
