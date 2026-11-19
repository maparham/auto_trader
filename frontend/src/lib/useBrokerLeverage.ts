import { useEffect, useState } from "react";
import { fetchMarketDetail } from "./feed";

// The broker's leverage changes only when the user edits the account's
// settings, so one answer per (broker, epic) is kept for a while. A failed or
// empty answer is kept only briefly: mt5-self has no figure on its first ask
// after a backend start (its sessions script loads in the background), and a
// Capital 429 is gone a moment later, so a long-kept null would pin a live
// ticket to the Settings leverage for minutes.
const TTL_MS = 10 * 60_000;
const NULL_TTL_MS = 30_000;
// An open ticket that got no figure asks once more after this long.
const RETRY_MS = 3_000;
const cache = new Map<string, { at: number; ttl: number; value: Promise<number | null> }>();

function lookup(epic: string, brokerId: string, force = false): Promise<number | null> {
  const key = `${brokerId}\u0000${epic}`;
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < hit.ttl) return hit.value;
  const entry = { at: Date.now(), ttl: TTL_MS, value: Promise.resolve<number | null>(null) };
  entry.value = fetchMarketDetail(epic, brokerId)
    .then((d) => (typeof d?.accountLeverage === "number" && d.accountLeverage > 0 ? d.accountLeverage : null))
    .catch(() => null)
    .then((v) => {
      if (v == null) entry.ttl = NULL_TTL_MS;
      return v;
    });
  cache.set(key, entry);
  return entry.value;
}

/** The account's effective leverage on `epic` as its broker states it
 * (Capital's account preferences, mt5-self's margin calc), or null when the
 * broker does not say or `enabled` is false. */
export function useBrokerLeverage(epic: string, brokerId: string, enabled = true): number | null {
  const [lev, setLev] = useState<number | null>(null);
  useEffect(() => {
    setLev(null);
    if (!enabled || !epic) return;
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    void lookup(epic, brokerId).then((v) => {
      if (!alive) return;
      if (v != null) return setLev(v);
      retry = setTimeout(() => {
        void lookup(epic, brokerId, true).then((v2) => alive && setLev(v2));
      }, RETRY_MS);
    });
    return () => {
      alive = false;
      clearTimeout(retry);
    };
  }, [epic, brokerId, enabled]);
  return lev;
}

/** Test seam: forget every cached lookup. */
export function clearBrokerLeverageCache(): void {
  cache.clear();
}
