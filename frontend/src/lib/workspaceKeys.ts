// The workspace key namespace, and the one way to clear it. A leaf module with
// no imports of its own, deliberately: persist/core imports impersonation (for
// the mirror gate) and impersonation needs the wipe, so parking the wipe in
// either of them would close an import cycle.

export const PREFIX = "auto-trader";

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
