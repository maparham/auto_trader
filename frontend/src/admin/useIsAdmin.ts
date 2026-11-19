import { useEffect, useState } from "react";
import { AdminHttpError, fetchWhoami } from "./api";

/** Waits before each retry of a failed probe. A 403 is final; anything else
 *  (a token not ready yet, a slow or dropped request) may pass on a retry. */
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000];

/**
 * True once `/api/admin/whoami` answers 200 (the server is the only authority
 * on admin-ness). A 403 (normal user) or auth being off keeps it false. Other
 * failures are retried a few times, so one failed request at page load does
 * not hide the admin entry points until a reload.
 */
export function useIsAdmin(enabled = true): boolean {
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const probe = (attempt: number) => {
      fetchWhoami()
        .then((w) => {
          if (live) setIsAdmin(Boolean(w.isAdmin));
        })
        .catch((err: unknown) => {
          if (!live) return;
          if (err instanceof AdminHttpError && err.status === 403) return;
          const delay = RETRY_DELAYS_MS[attempt];
          if (delay !== undefined) timer = setTimeout(() => probe(attempt + 1), delay);
        });
    };
    probe(0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [enabled]);
  return isAdmin;
}
