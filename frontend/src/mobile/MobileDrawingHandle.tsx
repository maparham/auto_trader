// A round ⋯ handle that floats beside the selected drawing on a phone. Tapping
// it opens the same drawing menu a long press does, for fingers that find the
// hold awkward. It rides just above the spot the finger selected the drawing
// at (below it near the chart top), so it shows up where the user is looking,
// and follows the drawing through drags, scrolls and zooms on a rAF loop that
// runs only while something is selected.
import { useEffect, useRef } from "react";
import type { Chart } from "klinecharts";
import type { OverlayManager } from "../lib/overlays";
import { drawingMenuRequest } from "../lib/signals";
import { distToSegment, nearLine } from "../lib/touchHitSlop";

/** Gap (CSS px) between the anchor and the handle's centre. */
const OFFSET = 44;
/** Half the handle's size, for clamping it inside the chart. */
const HALF = 18;
/** How near (CSS px) a later tap must land to the drawing to move the handle. */
const ON_LINE_PX = 24;
/** How old (ms) a tap may be and still count as the one that selected. */
const TAP_MAX_AGE = 1500;

interface Pt {
  x: number;
  y: number;
}

// The last finger-down, in viewport px, and when that finger lifted. The
// selection lands before this component mounts, so the listeners have to be
// up already.
let lastTap: (Pt & { t: number; up: number }) | null = null;
if (typeof window !== "undefined") {
  window.addEventListener(
    "pointerdown",
    (e) => {
      lastTap = { x: e.clientX, y: e.clientY, t: Date.now(), up: 0 };
    },
    { capture: true, passive: true },
  );
  window.addEventListener(
    "pointerup",
    () => {
      if (lastTap) lastTap.up = Date.now();
    },
    { capture: true, passive: true },
  );
}

/** The handle's centre for an anchor point, in chart-root px, or null off screen. */
export function spotNear(p: Pt, width: number, height: number): Pt | null {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  if (p.x < 0 || p.x > width || p.y < 0 || p.y > height) return null;
  const y = p.y - OFFSET >= HALF ? p.y - OFFSET : p.y + OFFSET;
  if (y > height - HALF) return null;
  return { x: Math.min(Math.max(p.x, HALF), width - HALF), y };
}

/** Fallback with no tap to go by: near the drawing's topmost on-screen point. */
export function handleSpot(pts: Pt[], width: number, height: number): Pt | null {
  const on = pts.filter((p) => p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height);
  if (!on.length) return null;
  return spotNear(on.reduce((a, b) => (b.y < a.y ? b : a)), width, height);
}

type DataPt = { timestamp?: number; value?: number; dataIndex?: number };
type Anchor = { kind: "seg"; i: number; t: number } | { kind: "data"; tap: DataPt; p0: DataPt };

/** The segment of pts nearest p, and p's projection on it as a fraction (unclamped). */
export function segAnchor(p: Pt, pts: Pt[]): { i: number; t: number } {
  let best = { i: 0, t: 0, d: Infinity };
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    const d = distToSegment(p, a, b);
    if (d < best.d) best = { i, t, d };
  }
  return { i: best.i, t: best.t };
}

/** The point at fraction t along segment i of pts. */
export function segPoint(anchor: { i: number; t: number }, pts: Pt[]): Pt {
  const a = pts[anchor.i];
  const b = pts[anchor.i + 1];
  return { x: a.x + anchor.t * (b.x - a.x), y: a.y + anchor.t * (b.y - a.y) };
}

export default function MobileDrawingHandle({
  chart,
  overlays,
  selectedId,
}: {
  chart: Chart;
  overlays: OverlayManager;
  selectedId: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const anchorRef = useRef<{ anchor: Anchor | null; seenTap: number }>({ anchor: null, seenTap: 0 });

  useEffect(() => {
    const toPixel = (p: DataPt): Pt => {
      const px = chart.convertToPixel([p], { paneId: "candle_pane", absolute: true });
      const q = (Array.isArray(px) ? px[0] : px) as Partial<Pt> | undefined;
      return { x: q?.x ?? NaN, y: q?.y ?? NaN };
    };
    // Where the handle rides, from the tap: for a drawing of two or more
    // points, a spot along one of its segments (segment index plus fraction),
    // so it moves with the drawing when it is dragged whole or by one end, and
    // with the candles on scroll and zoom. A one-point drawing (a horizontal
    // line) keeps the tap in data space and shifts it by however far its
    // point has moved. The selecting tap counts wherever it landed; a later
    // one only when it lands on the drawing, so placing a new line's second
    // point or grabbing the line moves the handle there, while panning the
    // chart from empty space leaves it be. The anchor outlives a change of
    // id with no tap in between: a drawing rebuilt under a new id after a
    // drag keeps its handle where it was.
    const kept = anchorRef.current;
    let anchor: Anchor | null = kept.anchor;
    let seenTap = kept.seenTap;
    if (!lastTap || lastTap.t !== seenTap) {
      anchor = null;
      seenTap = 0;
    }
    const reanchor = (root: HTMLElement, pts: Pt[]) => {
      const tap = lastTap;
      if (!tap || tap.t === seenTap) return;
      const initial = seenTap === 0;
      seenTap = tap.t;
      anchorRef.current = { anchor, seenTap };
      if (initial && Date.now() - Math.max(tap.t, tap.up) > TAP_MAX_AGE) return;
      const r = root.getBoundingClientRect();
      const local = { x: tap.x - r.left, y: tap.y - r.top };
      if (!initial && !nearLine(local, { coordinates: pts }, ON_LINE_PX)) return;
      if (pts.length >= 2) {
        anchor = { kind: "seg", ...segAnchor(local, pts) };
      } else {
        const p0 = overlays.getDrawing(selectedId)?.points[0];
        const d = chart.convertFromPixel([local], { paneId: "candle_pane", absolute: true });
        const q = (Array.isArray(d) ? d[0] : d) as DataPt | undefined;
        if (p0 && q?.dataIndex != null && q.value != null) anchor = { kind: "data", tap: { dataIndex: q.dataIndex, value: q.value }, p0 };
      }
      anchorRef.current = { anchor, seenTap };
    };

    let raf = 0;
    const place = () => {
      raf = requestAnimationFrame(place);
      const el = ref.current;
      const root = chart.getDom?.();
      const host = el?.offsetParent;
      const d = overlays.getDrawing(selectedId);
      if (!el || !root || !host || !d) return;
      const pts = d.points.map(toPixel);
      reanchor(root, pts);
      let spot: Pt | null;
      if (anchor?.kind === "seg" && pts.length > anchor.i + 1) {
        spot = spotNear(segPoint(anchor, pts), root.clientWidth, root.clientHeight);
      } else if (anchor?.kind === "data" && pts.length) {
        const t = toPixel(anchor.tap);
        const was = toPixel(anchor.p0);
        spot = spotNear({ x: t.x + pts[0].x - was.x, y: t.y + pts[0].y - was.y }, root.clientWidth, root.clientHeight);
      } else {
        spot = handleSpot(pts, root.clientWidth, root.clientHeight);
      }
      el.hidden = !spot;
      if (!spot) return;
      const a = root.getBoundingClientRect();
      const b = host.getBoundingClientRect();
      el.style.transform = `translate(${a.left - b.left + spot.x - HALF}px, ${a.top - b.top + spot.y - HALF}px)`;
    };
    place();
    return () => cancelAnimationFrame(raf);
  }, [chart, overlays, selectedId]);

  return (
    <button
      ref={ref}
      className="m-drawing-handle"
      aria-label="Drawing menu"
      hidden
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        drawingMenuRequest.set({ id: selectedId, x: r.left, y: r.bottom + 4 });
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
