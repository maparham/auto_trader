// Smooth wheel zoom over the chart's plot area.
//
// klinecharts applies each wheel event as an instant bar-space jump (10% per
// mouse notch), so a mouse wheel zooms in visible steps. This takes over the
// vertical wheel over the plot: every event moves a TARGET bar space
// (exponential in the delta, so zoom in and out are symmetric), and a rAF loop
// eases the real bar space toward it. Each frame goes through
// zoomAtCoordinate, i.e. klinecharts' own zoom() path, so onZoom still fires
// (date-range link, quick-range pill) and the configured zoom anchor still
// applies. Wheels over the price or time axis strips, and horizontal wheels,
// fall through to klinecharts untouched.

import { emitGlide } from "./glideEvent";

/** Zoom per wheel pixel: one 100px mouse notch is about 12.7%. */
export const ZOOM_PER_PX = 0.0012;
/** Easing time constant (ms): about 95% of the way there after 3 tau. */
export const ZOOM_TAU_MS = 70;
/** klinecharts' default barSpaceLimit; setBarSpace drops a value outside it. */
export const BAR_SPACE_MIN = 1;
export const BAR_SPACE_MAX = 50;

const LINE_PX = 40;

export interface SmoothZoomChart {
  getBarSpace(): { bar: number };
  zoomAtCoordinate(scale: number, coordinate?: { x: number; y: number }): void;
  isZoomEnabled(): boolean;
  getSize(paneId?: string, position?: string): { width: number; height: number } | null;
}

/** Bar-space multiplier for one wheel event (deltaY > 0 zooms out). */
export function wheelZoomFactor(deltaY: number, deltaMode: number, pagePx: number): number {
  const px = deltaMode === 1 ? deltaY * LINE_PX : deltaMode === 2 ? deltaY * pagePx : deltaY;
  return Math.exp(-ZOOM_PER_PX * px);
}

/** One frame of exponential easing from `cur` toward `target`. */
export function easeStep(cur: number, target: number, dtMs: number, tauMs = ZOOM_TAU_MS): number {
  return cur + (target - cur) * (1 - Math.exp(-dtMs / tauMs));
}

/**
 * Attach to klinecharts' own event element (chart.getDom()) in the capture
 * phase: stopPropagation there skips klinecharts' non-capture wheel listener
 * on the same element, while other capture listeners on it (and on ancestors)
 * still run. Returns the detach function.
 */
export function attachSmoothWheelZoom(
  dom: HTMLElement,
  getChart: () => SmoothZoomChart | null,
  raf: (cb: FrameRequestCallback) => number = (cb) => requestAnimationFrame(cb),
  cancelRaf: (id: number) => void = (id) => cancelAnimationFrame(id),
  now: () => number = () => performance.now(),
): () => void {
  let target: number | null = null;
  let anchorX = 0;
  let handle = 0;
  let last = 0;
  // Bar space this loop left behind last frame; anything else means another
  // zoom (axis double-click, a range pick) moved the chart, so stand down.
  let expected = NaN;

  const tick = () => {
    handle = 0;
    const c = getChart();
    if (!c || target == null) {
      target = null;
      return;
    }
    const t = now();
    const dt = Math.min(t - last, 64);
    last = t;
    const cur = c.getBarSpace().bar;
    if (Number.isFinite(expected) && Math.abs(cur - expected) > 1e-6) {
      target = null;
      return;
    }
    let next = easeStep(cur, target, dt);
    if (Math.abs(target - next) / target < 0.002) next = target;
    c.zoomAtCoordinate(next / cur, { x: anchorX, y: 0 });
    expected = c.getBarSpace().bar;
    emitGlide(dom);
    // Done, or klinecharts refused the step (the chart moved under us): stop
    // rather than spin on a target it will never reach.
    if (next === target || c.getBarSpace().bar === cur) {
      target = null;
      return;
    }
    handle = raf(tick);
  };

  const onWheel = (e: WheelEvent) => {
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.deltaY === 0) return;
    const c = getChart();
    if (!c || !c.isZoomEnabled()) return;
    const rect = dom.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const mainW = c.getSize("candle_pane", "main")?.width ?? 0;
    const xAxisH = c.getSize("x_axis_pane", "root")?.height ?? 0;
    if (!mainW || x > mainW || y > rect.height - xAxisH) return;
    e.preventDefault();
    e.stopPropagation();
    const base = target ?? c.getBarSpace().bar;
    const next = base * wheelZoomFactor(e.deltaY, e.deltaMode, rect.height);
    target = Math.min(BAR_SPACE_MAX, Math.max(BAR_SPACE_MIN, next));
    anchorX = x;
    if (!handle) {
      expected = NaN;
      // Count the first frame as a full one, or the frame right after the
      // event moves almost nothing and the glide starts a frame late.
      last = now() - 16;
      handle = raf(tick);
    }
  };

  dom.addEventListener("wheel", onWheel, { capture: true, passive: false });
  return () => {
    dom.removeEventListener("wheel", onWheel, { capture: true });
    if (handle) cancelRaf(handle);
    handle = 0;
    target = null;
  };
}
