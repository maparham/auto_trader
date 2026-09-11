import { useEffect, useState } from "react";
import { fetchWhoami } from "./api";

/**
 * True once `/api/admin/whoami` answers 200 (the server is the only authority
 * on admin-ness). Any failure leaves it false: a 403 for a normal user, a
 * network blip, or auth being off all keep the admin entry points hidden.
 */
export function useIsAdmin(enabled = true): boolean {
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    fetchWhoami()
      .then((w) => {
        if (live) setIsAdmin(Boolean(w.isAdmin));
      })
      .catch(() => {
        /* not an admin, or the probe failed: stay hidden */
      });
    return () => {
      live = false;
    };
  }, [enabled]);
  return isAdmin;
}
