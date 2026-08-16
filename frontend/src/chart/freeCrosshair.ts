// Free (non-bar-snapped) crosshair x. klinecharts draws the vertical crosshair
// line — and its time-axis label — at crosshair.realX, the CENTER of the bar
// under the cursor, not at the cursor itself. With the cursor resting while the
// chart pans underneath (wheel/trackpad), the store re-snaps from the stored
// cursor pixel on every scroll step, so the line rides along with the snapped
// bar for up to a bar-width and then jumps back under the cursor at each bar
// boundary. There is no style/option to disable the snap (CrosshairLineView
// hard-reads realX), so we wrap the store's setCrosshair and pin realX to the
// raw cursor x afterwards. Everything semantic (dataIndex, timestamp,
// kLineData — the tooltip text, legend bar) still comes from the snapped bar;
// realX only positions the line/label, and nothing else reads it.
//
// getChartStore() is a real ChartImp method absent from the public typings
// (same access pattern as overlays.ts syncDrawingSelectionFromClick); if a
// future klinecharts drops it we silently keep the native snapping behavior.

interface CrosshairLike {
  x?: number;
  realX?: number;
}

interface StoreLike {
  setCrosshair: (crosshair?: CrosshairLike, options?: unknown) => void;
  getCrosshair: () => CrosshairLike;
}

export function applyFreeCrosshairX(chart: unknown): void {
  const store = (chart as { getChartStore?: () => StoreLike | null | undefined } | null)?.getChartStore?.();
  if (!store || typeof store.setCrosshair !== "function" || typeof store.getCrosshair !== "function") return;
  const orig = store.setCrosshair.bind(store);
  store.setCrosshair = (crosshair?: CrosshairLike, options?: unknown) => {
    orig(crosshair, options);
    const x = crosshair?.x;
    if (typeof x === "number" && isFinite(x)) store.getCrosshair().realX = x;
  };
}
