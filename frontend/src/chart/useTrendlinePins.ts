// Click-to-pin for TRENDLINES end handles. Clicking the dot at a line's right
// end runs that line on to the pane's edge and keeps it there; clicking again
// releases it.
//
// The pin lives in the indicator's extendData (render-only, so nothing a
// strategy reads can move) and is SESSION-ONLY: it is never written to the saved
// indicator config, and applyIndicator strips a `pinned` that rode in on an old
// snapshot, a template or a paste. A pin is a transient "hold this one open while
// I look at it" gesture, not a setting worth surviving a reload.
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
import { overrideExtend } from "../lib/overrideExtend";

interface Args {
  chartRef: React.MutableRefObject<Chart | null>;
  containerRef: React.RefObject<HTMLElement | null>;
}

/** getIndicators' result as a flat list, whichever of klinecharts' two shapes
 * (array, or Map of pane to array) it answered in. ONE normalizer for every
 * caller: a toggle that understood fewer shapes than the instance walk would
 * read the live `pinned` as empty on the shape it missed, and its write would
 * then silently wipe every other pin. */
function indicatorList(inds: unknown): Indicator[] {
  if (Array.isArray(inds)) return inds as Indicator[];
  if (inds instanceof Map)
    return [...(inds as Map<string, Indicator[]>).values()].flat();
  return [];
}

/** Every TRENDLINES instance on the chart, with its pane. */
function trendlineInstances(
  chart: Chart,
): Array<{ paneId: string; name: string }> {
  const out: Array<{ paneId: string; name: string }> = [];
  for (const ind of indicatorList(chart.getIndicators({}) as unknown)) {
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

/** Flip one lineKey in the live indicator's pin set: a second toggle on a
 * pinned key releases it. Reads the CURRENT pins off the live instance (in
 * either getIndicators shape) so a toggle only ever moves its own key. */
export function togglePin(
  chart: Chart,
  paneId: string,
  name: string,
  key: string,
): void {
  const live = indicatorList(chart.getIndicators({ paneId, name }) as unknown)[0]
    ?.extendData;
  const ext = (live ?? {}) as TrendlinesExtend;
  const pinned = new Set(ext.pinned ?? []);
  if (pinned.has(key)) pinned.delete(key);
  else pinned.add(key);
  overridePinned(chart, paneId, name, [...pinned]);
}

/** How far the pointer may travel between press and release and still count
 * as a click. Ordinary clicks wobble a pixel or two; a pan travels tens. */
const TL_CLICK_SLOP = 4;

export function useTrendlinePins({ chartRef, containerRef }: Args): void {
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // A CLICK toggles, not a press. The mousedown over a handle is still
    // swallowed — the press must never also pan the chart — but the toggle
    // itself waits for a mouseup within TL_CLICK_SLOP of it, so a drag that
    // happens to start inside a handle's 8px hit circle does nothing at all
    // (no pan, no toggle) instead of flipping a pin the user never aimed at.
    let pending: {
      paneId: string;
      name: string;
      key: string;
      x: number;
      y: number;
    } | null = null;

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
        pending = { paneId, name, key, x: e.clientX, y: e.clientY };
        // Ours: do not let the press reach klinecharts' pan, or a pin toggle
        // also nudges the chart.
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    };

    // On WINDOW, capture: the release may land outside the container (or off
    // the handle entirely), and a pending press must be consumed either way
    // or it would pair with some later, unrelated mouseup.
    const onUp = (e: MouseEvent) => {
      if (!pending) return;
      const p = pending;
      pending = null;
      const chart = chartRef.current;
      if (!chart || e.button !== 0) return;
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > TL_CLICK_SLOP) return;
      togglePin(chart, p.paneId, p.name, p.key);
    };

    // The hover cursor is NOT set here. klinecharts paints its own cursor on
    // the canvas, so an inline style on this container never shows; only
    // `.chart-wrap.cur-pointer canvas` beats it. usePointerCrosshair owns that
    // one cursorMode for every hit target, and calls hitAnyTrendlineHandle.
    el.addEventListener("mousedown", onDown, true);
    window.addEventListener("mouseup", onUp, true);
    return () => {
      el.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("mouseup", onUp, true);
    };
  }, [chartRef, containerRef]);
}
