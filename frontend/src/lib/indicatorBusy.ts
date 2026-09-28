// Which indicator instances are mid-compute, for the legend's busy
// mark. A LEAF with no runtime imports, like overrideExtend: the calc and the
// MTF coordinator both write here and both are node-testable.
//
// Counted, not boolean: a pinned instance's HTF refresh and a deferred calc can
// overlap on the same instance, and the first to finish must not clear the
// mark while the other is still running.

// Keyed by the indicator OBJECT: klinecharts hands calc the same instance that
// chart.getIndicators() returns, and calc never sees the chart.
const busy = new WeakMap<object, number>();
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((l) => l());
}

export function markIndicatorBusy(ind: object): void {
  busy.set(ind, (busy.get(ind) ?? 0) + 1);
  notify();
}

export function clearIndicatorBusy(ind: object): void {
  const n = busy.get(ind);
  if (!n) return;
  if (n > 1) busy.set(ind, n - 1);
  else busy.delete(ind);
  notify();
}

export function isIndicatorBusy(ind: object | null | undefined): boolean {
  return !!ind && (busy.get(ind) ?? 0) > 0;
}

export function subscribeIndicatorBusy(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Resolves once the browser has painted a frame, so a busy mark set just
 * before a synchronous compute is actually on screen while it runs. The rAF
 * lands before the paint; the timeout after it lands after. Without rAF (node
 * tests) it resolves on the next microtask. */
export function afterNextPaint(): Promise<void> {
  if (typeof requestAnimationFrame !== "function") return Promise.resolve();
  return new Promise((resolve) =>
    requestAnimationFrame(() => setTimeout(resolve, 0)),
  );
}
