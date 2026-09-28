// A round ⋯ handle beside the touch crosshair on a phone. There is no
// right-click on a touch screen, so this is the way into the chart's context
// menu (Paste, Copy timestamp, the price actions): a long press places the
// crosshair, the finger lifts, and the handle appears just above the crosshair
// point. It hides while a finger is on the chart (so it never sits under the
// thumb dragging the crosshair) and when the crosshair clears (a pan, a tap
// elsewhere). The menu acts on the crosshair's price and time, not the handle's.
import { useEffect, useRef } from "react";
import type { Chart } from "klinecharts";
import type { OverlayManager } from "../lib/overlays";
import { chartMenuRequest } from "../lib/signals";
import { subscribeCrosshairWrites, type CrosshairPoint } from "../chart/crosshairWrites";
import { positionedHost, spotNear } from "./MobileDrawingHandle";

/** Half the handle's size, matching MobileDrawingHandle's clamp. */
const HALF = 18;

/** Whether the handle shows, given the crosshair and what the finger is doing. */
export function handleShows(s: {
  point: CrosshairPoint | null;
  touch: boolean;
  fingerDown: boolean;
  hidden: boolean;
  drawing: boolean;
}): boolean {
  return s.point != null && s.touch && !s.fingerDown && !s.hidden && !s.drawing;
}

export default function MobileCrosshairHandle({
  chart,
  overlays,
  hidden,
}: {
  chart: Chart;
  overlays: OverlayManager;
  /** A drawing is selected: its own handle owns the spot. */
  hidden: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const pointRef = useRef<CrosshairPoint | null>(null);
  const hiddenRef = useRef(hidden);
  const updateRef = useRef<() => void>(() => {});
  hiddenRef.current = hidden;

  useEffect(() => {
    const root = chart.getDom?.();
    if (!root) return;
    let touch = false;
    let fingerDown = false;
    const update = () => {
      const el = ref.current;
      if (!el) return;
      const point = pointRef.current;
      const show = handleShows({
        point,
        touch,
        fingerDown,
        hidden: hiddenRef.current,
        drawing: overlays.isDrawing(),
      });
      const spot = show && point ? spotNear(point, root.clientWidth, root.clientHeight) : null;
      el.hidden = !spot;
      if (!spot) return;
      const a = root.getBoundingClientRect();
      const b = positionedHost(el).getBoundingClientRect();
      el.style.transform = `translate(${a.left - b.left + spot.x - HALF}px, ${a.top - b.top + spot.y - HALF}px)`;
    };
    updateRef.current = update;
    // The write's x/y are relative to the chart root (see usePointerCrosshair).
    const offWrites = subscribeCrosshairWrites(chart, (cr) => {
      pointRef.current = cr;
      update();
    });
    const onDown = (e: PointerEvent) => {
      touch = e.pointerType === "touch";
      fingerDown = touch;
      update();
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerType !== "touch" || !fingerDown) return;
      fingerDown = false;
      update();
    };
    root.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    return () => {
      offWrites();
      root.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      updateRef.current = () => {};
    };
  }, [chart, overlays]);

  // A drawing selected or deselected re-decides without waiting for a write.
  useEffect(() => {
    updateRef.current();
  }, [hidden]);

  return (
    <button
      ref={ref}
      className="m-drawing-handle"
      aria-label="Chart menu"
      hidden
      onClick={(e) => {
        const point = pointRef.current;
        const root = chart.getDom?.();
        if (!point || !root) return;
        const a = root.getBoundingClientRect();
        const r = e.currentTarget.getBoundingClientRect();
        chartMenuRequest.set({
          chart,
          x: a.left + point.x,
          y: a.top + point.y,
          menuX: r.left,
          menuY: r.bottom + 4,
        });
      }}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="4" cy="9" r="1.6" fill="currentColor" />
        <circle cx="9" cy="9" r="1.6" fill="currentColor" />
        <circle cx="14" cy="9" r="1.6" fill="currentColor" />
      </svg>
    </button>
  );
}
