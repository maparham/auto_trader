// One sticky toast for the "your network is blocking the broker" state.
//
// The backend tags broker calls that die at a WAF interstitial (restricted
// internet connection) with X-Broker-Blocked; the account/trades poll loops
// report that here. State is edge-triggered: the toast appears once when the
// block starts and is auto-dismissed when a poll succeeds again — a user who
// ×-dismisses it early is not re-nagged every 6s poll while the block persists
// (the keyed toast's ×N badge would otherwise climb forever).

import { toast, dismissToast } from "./notify";

const KEY = "broker-blocked";
let active = false;

/** A broker call failed with the blocked-network marker. */
export function reportBrokerBlocked(detail?: string): void {
  if (active) return;
  active = true;
  toast(
    detail ||
      "Broker unreachable — this network is blocking the broker's API " +
        "(restricted internet connection). Account data may be stale.",
    { duration: null, key: KEY },
  );
}

/** A broker call succeeded — the network path is open again. */
export function reportBrokerReachable(): void {
  if (!active) return;
  active = false;
  dismissToast(KEY);
}
