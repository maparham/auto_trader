// Pan momentum: a drag-pan that is released while moving keeps gliding and
// slows to a stop, instead of halting dead under the finger.
//
// klinecharts owns the drag itself; this only watches. A press counts as a pan
// when klinecharts fires onScroll while it is held (so overlay drags, axis
// scaling and the select-a-range tools, which never scroll, get no momentum).
// The release velocity comes from the pointer's last ~100ms; the glide feeds
// scrollByDistance each frame, the same per-move distance a drag uses, so
// onScroll keeps firing for the date-range link. A new press or a wheel stops
// the glide.

import { emitGlide } from "./glideEvent";

/** Velocity decay time constant (ms). */
export const PAN_TAU_MS = 300;
/** Release speed (px/ms) below which there is no glide. */
export const PAN_MIN_SPEED = 0.25;
/** Cap on the release speed (px/ms), so a flick does not fling the chart away. */
export const PAN_MAX_SPEED = 4;
/** A drag that paused this long before release ends without momentum. */
const STALE_MS = 60;
const WINDOW_MS = 100;
const STOP_SPEED = 0.02;

export interface PanMomentumChart {
  scrollByDistance(distance: number): void;
  isScrollEnabled(): boolean;
  subscribeAction(type: "onScroll", cb: () => void): void;
  unsubscribeAction(type: "onScroll", cb: () => void): void;
}

/**
 * Release velocity (px/ms) from timestamped pointer x samples, or 0 when the
 * pointer had stopped before `now`.
 */
export function releaseVelocity(samples: ReadonlyArray<{ t: number; x: number }>, now: number): number {
  const last = samples[samples.length - 1];
  if (!last || now - last.t > STALE_MS) return 0;
  let first = last;
  for (let i = samples.length - 1; i >= 0 && last.t - samples[i].t <= WINDOW_MS; i--) first = samples[i];
  const dt = last.t - first.t;
  if (dt <= 0) return 0;
  const v = (last.x - first.x) / dt;
  return Math.max(-PAN_MAX_SPEED, Math.min(PAN_MAX_SPEED, v));
}

export function attachPanMomentum(
  dom: HTMLElement,
  chart: PanMomentumChart,
  raf: (cb: FrameRequestCallback) => number = (cb) => requestAnimationFrame(cb),
  cancelRaf: (id: number) => void = (id) => cancelAnimationFrame(id),
  now: () => number = () => performance.now(),
): () => void {
  let pressed = false;
  let scrolled = false;
  let gliding = false;
  let samples: { t: number; x: number }[] = [];
  let v = 0;
  let last = 0;
  let handle = 0;

  const stop = () => {
    if (handle) cancelRaf(handle);
    handle = 0;
    gliding = false;
    v = 0;
  };

  const tick = () => {
    handle = 0;
    if (!gliding) return;
    if (!chart.isScrollEnabled()) return stop();
    const t = now();
    const dt = Math.min(t - last, 64);
    last = t;
    v *= Math.exp(-dt / PAN_TAU_MS);
    if (Math.abs(v) < STOP_SPEED) return stop();
    chart.scrollByDistance(v * dt);
    emitGlide(dom);
    handle = raf(tick);
  };

  const onScroll = () => {
    if (pressed && !gliding) scrolled = true;
  };

  const onDown = (e: PointerEvent) => {
    stop();
    pressed = true;
    scrolled = false;
    samples = [{ t: now(), x: e.clientX }];
  };

  const onMove = (e: PointerEvent) => {
    if (!pressed) return;
    const t = now();
    samples.push({ t, x: e.clientX });
    // Keep only what releaseVelocity can read.
    while (samples.length > 2 && t - samples[0].t > WINDOW_MS * 2) samples.shift();
  };

  const onUp = () => {
    if (!pressed) return;
    pressed = false;
    if (!scrolled) return;
    const t = now();
    const rv = releaseVelocity(samples, t);
    if (Math.abs(rv) < PAN_MIN_SPEED) return;
    v = rv;
    gliding = true;
    last = t;
    handle = raf(tick);
  };

  const onCancel = () => {
    pressed = false;
  };

  chart.subscribeAction("onScroll", onScroll);
  dom.addEventListener("pointerdown", onDown, true);
  dom.addEventListener("pointermove", onMove, true);
  dom.addEventListener("wheel", stop, { capture: true, passive: true });
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onCancel, true);
  return () => {
    stop();
    chart.unsubscribeAction("onScroll", onScroll);
    dom.removeEventListener("pointerdown", onDown, true);
    dom.removeEventListener("pointermove", onMove, true);
    dom.removeEventListener("wheel", stop, { capture: true });
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancel, true);
  };
}
