// Diagnostic: how long a chart series switch (timeframe or symbol) takes from
// the load effect starting to the first frame painted with the new bars, split
// into the recent-bars fetch, the preserve-center cover, and setBars. Posted
// to the backend's timing ring (GET /api/candle-cache/timings) next to the
// server's own breakdown of the same request, which rides back here in the
// Server-Timing header. Dev builds, and admin accounts in production (the
// endpoint is admin-only, so anyone else would only collect 403s).

import { API_BASE as BASE, apiFetch } from "./http";
import { PERF_DIAG_ON } from "./perfDiag";
import { isAdminAccount } from "./trading";

export type SwitchTiming = Record<string, string | number | boolean | null>;

export function reportSwitchTiming(entry: SwitchTiming): void {
  if (!PERF_DIAG_ON && !isAdminAccount()) return;
  console.info("[switch-timing]", entry);
  void apiFetch(`${BASE}/api/candle-cache/timings/client`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry),
  }).catch(() => {});
}
