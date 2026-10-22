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
// Which failure the on-screen toast describes, or null when none is showing.
let active: "blocked" | "broker" | "server" | null = null;

/** Swap the toast when the failure changes kind (e.g. a blocked network turns
 * out to be a broker outage); a repeat of the same kind stays edge-triggered. */
function claim(kind: "blocked" | "broker" | "server"): boolean {
  if (active === kind) return false;
  if (active) dismissToast(KEY);
  active = kind;
  return true;
}

/** A broker call failed with the blocked-network marker. */
export function reportBrokerBlocked(detail?: string): void {
  if (!claim("blocked")) return;
  toast(
    detail ||
      "Broker unreachable — this network is blocking the broker's API " +
        "(restricted internet connection). Account data may be stale.",
    { duration: null, key: KEY },
  );
}

/** A broker call failed because the broker itself (`brokerName`) or our own
 * server is down, not the user's network. Same sticky, edge-triggered toast. */
export function reportBrokerOutage(who: "broker" | "server", brokerName: string): void {
  if (!claim(who)) return;
  toast(
    who === "broker"
      ? `${brokerName} isn't responding. Account data may be stale. Retrying.`
      : "Chartkar's server is overloaded. Account data may be stale. Retrying.",
    { duration: null, key: KEY },
  );
}

/** A broker call succeeded — the network path is open again. */
export function reportBrokerReachable(): void {
  if (!active) return;
  active = null;
  dismissToast(KEY);
}
