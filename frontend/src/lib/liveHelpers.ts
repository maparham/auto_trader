/** Bar-close detection off the live-candle stream. The WS has no isClosed flag;
 *  a timestamp advance is the signal that the PRIOR bar closed (same rule the
 *  chart uses). Equal ts = the in-progress bar updating; older = stale. */
export function detectBarClose(
  prevTs: number | null,
  k: { timestamp: number },
): { closed: boolean; openedTs: number } {
  return { closed: prevTs !== null && k.timestamp > prevTs, openedTs: k.timestamp };
}

/** Deterministic idempotency key. A reload/HMR/double-fire on the same bar+leg+
 *  side yields the same id, so the broker's dedupe collapses it to one order. */
export function deriveOrderId(
  strategyId: string,
  barTsSec: number,
  leg: "long" | "short",
  side: "buy" | "sell",
): string {
  return `${strategyId}:${barTsSec}:${leg}:${side}`;
}
