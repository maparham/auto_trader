// Observe every crosshair WRITE on the chart store — moves and clears alike.
//
// klinecharts' public `onCrosshairChange` action only fires when the crosshair
// is SET on a pane (StoreImp.setCrosshair gates it on isString(paneId)), so a
// clear (setCrosshair() with no arg — a touch pan starting, a tap on a drawing,
// the outside-tap handler) is silent. On a phone that is the only signal we get
// that the crosshair went away: klinecharts consumes the touch sequence on its
// canvas, so no synthetic mousemove/mouseleave ever reaches our listeners.
// Wrapping the store setter (the same pattern as freeCrosshair.ts, which we
// chain over) hands the listener the raw written crosshair, or null on a clear.
//
// getChartStore() is a real ChartImp method absent from the public typings; on
// a chart without it the subscription is a no-op that still returns a cleanup.

export interface CrosshairWrite {
  x?: number;
  y?: number;
  paneId?: string;
}

// What the listener sees on a set: the pixel is guaranteed numeric.
export interface CrosshairPoint extends CrosshairWrite {
  x: number;
  y: number;
}

interface StoreLike {
  setCrosshair: (crosshair?: CrosshairWrite, options?: unknown) => void;
}

function isPoint(c: CrosshairWrite | undefined): c is CrosshairPoint {
  return c != null && typeof c.x === "number" && typeof c.y === "number";
}

export function subscribeCrosshairWrites(
  chart: unknown,
  listener: (crosshair: CrosshairPoint | null) => void,
): () => void {
  const store = (chart as { getChartStore?: () => StoreLike | null | undefined } | null)?.getChartStore?.();
  if (!store || typeof store.setCrosshair !== "function") return () => {};
  // The wrapper stays installed for the chart's life and delegates through a
  // slot, so tearing down never has to unwind a chain of wrappers in order.
  let active: ((crosshair: CrosshairPoint | null) => void) | null = listener;
  const orig = store.setCrosshair.bind(store);
  store.setCrosshair = (crosshair?: CrosshairWrite, options?: unknown) => {
    orig(crosshair, options);
    if (!active) return;
    active(isPoint(crosshair) ? crosshair : null);
  };
  return () => {
    active = null;
  };
}
