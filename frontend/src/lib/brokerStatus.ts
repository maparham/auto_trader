// Whether each data broker is answering right now (GET /api/brokers/status),
// for the status dots in the broker menus. The backend reads it off its
// record of recent calls; with probe=1 it first sends one light test call to
// each broker that has had no success for a few minutes (never MetaApi mt5).
import { useEffect, useState } from "react";
import { API_BASE as BASE, apiFetch } from "./http";
import { isDemoMode } from "./demoMode";

export type BrokerState = "ok" | "down" | "unknown";

export interface BrokerStatus {
  state: BrokerState;
  /** Seconds since the broker last answered; null when it never has. */
  okAgeS: number | null;
  /** Why the latest call failed. Admins only. */
  reason: string | null;
}

export type BrokerStatusMap = Record<string, BrokerStatus>;

export async function fetchBrokerStatus(probe: boolean): Promise<BrokerStatusMap> {
  const res = await apiFetch(`${BASE}/api/brokers/status${probe ? "?probe=1" : ""}`);
  if (!res.ok) throw new Error(`broker status failed (${res.status})`);
  return ((await res.json()) as { brokers: BrokerStatusMap }).brokers;
}

/** Status of every broker while `active` (the menu is open): what the server
 * already knows first, then again once the stale brokers have been tested.
 * `checking` is true until that second answer lands. A failed fetch leaves the
 * map as it was, so the menu just shows no dots. */
export function useBrokerStatus(active: boolean): {
  status: BrokerStatusMap;
  checking: boolean;
} {
  const [status, setStatus] = useState<BrokerStatusMap>({});
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    // The demo principal may not read this endpoint.
    if (!active || isDemoMode()) return;
    let alive = true;
    let probed = false;
    setChecking(true);
    fetchBrokerStatus(false)
      .then((s) => {
        // The quick answer must not overwrite the tested one.
        if (alive && !probed) setStatus(s);
      })
      .catch(() => {});
    fetchBrokerStatus(true)
      .then((s) => {
        probed = true;
        if (alive) setStatus(s);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setChecking(false);
      });
    return () => {
      alive = false;
      setChecking(false);
    };
  }, [active]);

  return { status, checking };
}

/** Tooltip lines for one broker's dot. */
export function brokerStatusText(s: BrokerStatus | undefined, checking: boolean): string[] {
  if (!s || s.state === "unknown") {
    return checking ? ["Checking the connection"] : ["Not used since the server started"];
  }
  if (s.state === "ok") return ["Connected"];
  return s.reason ? ["Not connected", s.reason] : ["Not connected"];
}
