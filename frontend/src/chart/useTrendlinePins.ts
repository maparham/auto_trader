// Click-to-pin for TRENDLINES end handles. Clicking the dot at a line's right
// end runs that line on to the pane's edge and keeps it there; clicking again
// releases it.
//
// The pin lives in the indicator's extendData (render-only, so nothing a
// strategy reads can move) and is persisted with patchIndicatorExtend, the same
// direct-manipulation seam the Slope threshold drag uses. The settings modal's
// snapshot effect only runs while that modal is open, so a click on the chart
// has to save itself.
//
// Hit targets come from getTrendlineHandles, which the draw path fills with the
// pixels it actually painted. Recomputing them here would be a second copy of
// the clamping and interpolation, free to drift from what the user sees.
import { useEffect } from "react";
import type { Chart, Indicator } from "klinecharts";
import {
  getTrendlineHandles,
  hitHandle,
  type TrendlinesExtend,
} from "../lib/indicators/trendlines";
import { patchIndicatorExtend } from "../lib/persist";
import { overrideExtend } from "../lib/overrideExtend";

interface Args {
  chartRef: React.MutableRefObject<Chart | null>;
  containerRef: React.RefObject<HTMLElement | null>;
  scope: string;
}

/** Every TRENDLINES instance on the chart, with its pane. */
function trendlineInstances(
  chart: Chart,
): Array<{ paneId: string; name: string }> {
  const out: Array<{ paneId: string; name: string }> = [];
  const inds = chart.getIndicators({}) as unknown;
  const list: Indicator[] = Array.isArray(inds)
    ? (inds as Indicator[])
    : inds instanceof Map
      ? [...(inds as Map<string, Indicator[]>).values()].flat()
      : [];
  for (const ind of list) {
    // Instances are named TRENDLINES, TRENDLINES2, ... so match the prefix, not
    // equality, or only the first instance is ever clickable.
    if (typeof ind?.name === "string" && ind.name.startsWith("TRENDLINES")) {
      out.push({ paneId: ind.paneId ?? "candle_pane", name: ind.name });
    }
  }
  return out;
}

/** Write `pinned` onto a live indicator's extendData so that REMOVALS land.
 *
 * The hazard belongs to overrideExtend, which is where it is explained: a
 * shorter array never shrinks the live one, because klinecharts merges
 * extendData index by index. Unpinning saved correctly and never repainted, so
 * a released line stayed extended until the next page load, and that was the
 * first of five places with the same shape.
 *
 * Only `pinned` is sent, not the whole extendData: merge walks the keys it is
 * given, so the neighbouring options (extend, dedupe, ...) are left alone. */
export function overridePinned(
  chart: Chart,
  paneId: string,
  name: string,
  next: string[],
): void {
  overrideExtend(chart, paneId, name, { pinned: next });
}

export function useTrendlinePins({
  chartRef,
  containerRef,
  scope,
}: Args): void {
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const chart = chartRef.current;
      if (!chart) return;
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      for (const { paneId, name } of trendlineInstances(chart)) {
        const key = hitHandle(getTrendlineHandles(chart, paneId, name), px, py);
        if (!key) continue;
        const ind = chart.getIndicators({ paneId, name }) as unknown;
        const live = (Array.isArray(ind) ? (ind[0] as Indicator) : null)
          ?.extendData;
        const ext = (live ?? {}) as TrendlinesExtend;
        const pinned = new Set(ext.pinned ?? []);
        // Toggle: a second click on a pinned handle releases it.
        if (pinned.has(key)) pinned.delete(key);
        else pinned.add(key);
        const next = [...pinned];
        overridePinned(chart, paneId, name, next);
        patchIndicatorExtend(scope, name, { pinned: next });
        // Ours: do not let the press reach klinecharts' pan, or a pin toggle
        // also nudges the chart.
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    };

    // The hover cursor is NOT set here. klinecharts paints its own cursor on
    // the canvas, so an inline style on this container never shows; only
    // `.chart-wrap.cur-pointer canvas` beats it. usePointerCrosshair owns that
    // one cursorMode for every hit target, and calls hitAnyTrendlineHandle.
    el.addEventListener("mousedown", onDown, true);
    return () => el.removeEventListener("mousedown", onDown, true);
  }, [chartRef, containerRef, scope]);
}
