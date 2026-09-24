// A wider hit area for thin lines and grab dots under a finger.
//
// klinecharts hit-tests a `line` figure within a hardcoded 2px (DEVIATION in
// its figure module), fine for a mouse and near impossible for a fingertip:
// a trend line or horizontal line can't be tapped, dragged or long-pressed on
// a phone without several tries. registerFigure replaces a same-named
// built-in, so we re-register `line` with the SAME draw and a check that
// widens to TOUCH_SLOP_PX while the last pointer was a finger. The mouse keeps
// the library's own 2px check untouched.
//
// The grab dots on a selected drawing's ends get the same treatment, wider
// still (TOUCH_HANDLE_PX): klinecharts draws them as `circle` figures of r 6,
// so a finger that lands a little off the dot fell through to the line and
// dragged the whole drawing instead of one end. The dot needs no priority
// logic of its own: an overlay's dots are created after its body figures and
// hit-testing walks children last-first, so near both, the dot wins.
//
// The same `line` registration also paints the selected drawing's glow, the
// Trendlines indicator's selection look: a wide translucent under-stroke in
// the line's own color. OverlayManager.syncSelectGlow flags the selected
// drawing's line style with SELECT_GLOW_KEY; figures never see the overlay,
// so the style is the only way in.
//
// Figures carry no event type, hence the module flag: pointer events fire
// before the touch/mouse events klinecharts hit-tests on, so the flag is
// current by the time any figure is checked.
import { getFigureClass, registerFigure } from "klinecharts";
import { TL_SELECT_GLOW, TL_SELECT_GLOW_ALPHA } from "./indicators/trendlineMarks";

/** Max distance (CSS px) from a line that still counts as on it, for touch. */
export const TOUCH_SLOP_PX = 12;
/** Touch hit radius (CSS px) of a drawing's endpoint grab dot. */
export const TOUCH_HANDLE_PX = 20;
/** Line style key that asks for the selection glow. Live-only, never saved. */
export const SELECT_GLOW_KEY = "selectGlow";

interface Pt {
  x: number;
  y: number;
}
interface LineAttrs {
  coordinates: Pt[];
}

/** Distance from p to the segment a-b. */
export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Is p within tol of any segment of the line (or lines) in attrs? */
export function nearLine(p: Pt, attrs: LineAttrs | LineAttrs[], tol: number): boolean {
  for (const line of ([] as LineAttrs[]).concat(attrs)) {
    const cs = line.coordinates;
    for (let i = 1; i < cs.length; i++) {
      if (distToSegment(p, cs[i - 1], cs[i]) <= tol) return true;
    }
  }
  return false;
}

interface CircleAttrs {
  x: number;
  y: number;
  r: number;
}

/**
 * Is this circle one of klinecharts' own endpoint grab dots? Its styles are
 * built bare ({ color } only, drawDefaultFigures), while every circle an
 * overlay draws is merged over the theme's circle defaults and so carries
 * `style`. That keeps the wider touch radius off markers and hover targets.
 */
export function isGrabDot(styles: unknown): boolean {
  return styles != null && typeof styles === "object" && !("style" in styles);
}

/** Is p within tol of any circle's centre in attrs? */
export function nearDot(p: Pt, attrs: CircleAttrs | CircleAttrs[], tol: number): boolean {
  return ([] as CircleAttrs[]).concat(attrs).some((c) => Math.hypot(p.x - c.x, p.y - c.y) <= Math.max(c.r, tol));
}

/** The selection glow under a flagged line: same path, wider, translucent, solid. */
export function drawSelectGlow(ctx: CanvasRenderingContext2D, attrs: LineAttrs | LineAttrs[], styles: unknown): void {
  const st = styles as { color?: string; size?: number; [SELECT_GLOW_KEY]?: boolean } | null;
  if (st?.[SELECT_GLOW_KEY] !== true) return;
  ctx.save();
  ctx.globalAlpha = TL_SELECT_GLOW_ALPHA;
  ctx.strokeStyle = st.color ?? "#1677ff";
  ctx.lineWidth = (st.size ?? 1) + TL_SELECT_GLOW;
  ctx.setLineDash([]);
  ctx.beginPath();
  for (const line of ([] as LineAttrs[]).concat(attrs)) {
    const cs = line.coordinates;
    if (cs.length < 2) continue;
    ctx.moveTo(cs[0].x, cs[0].y);
    for (let i = 1; i < cs.length; i++) ctx.lineTo(cs[i].x, cs[i].y);
  }
  ctx.stroke();
  ctx.restore();
}

let touch = false;
let installed = false;

// Idempotent: registration is global, like registerCustomOverlays.
export function installTouchHitSlop(): void {
  if (installed || typeof window === "undefined") return;
  // The built-in, captured before we replace it. Its prototype methods only
  // forward to the figure definition and never read `this`.
  type Builtin = {
    prototype: {
      checkEventOnImp: (c: Pt, attrs: unknown, styles: unknown) => boolean;
      drawImp: (ctx: CanvasRenderingContext2D, attrs: unknown, styles: unknown) => void;
    };
  } | null;
  const Line = getFigureClass("line") as unknown as Builtin;
  const Circle = getFigureClass("circle") as unknown as Builtin;
  if (!Line || !Circle) return;
  installed = true;
  const track = (e: PointerEvent) => {
    touch = e.pointerType === "touch";
  };
  window.addEventListener("pointerdown", track, { capture: true, passive: true });
  window.addEventListener("pointermove", track, { capture: true, passive: true });
  const line = Line.prototype;
  registerFigure({
    name: "line",
    checkEventOn: (c: Pt, attrs: unknown, styles: unknown) =>
      touch ? nearLine(c, attrs as LineAttrs | LineAttrs[], TOUCH_SLOP_PX) : line.checkEventOnImp(c, attrs, styles),
    draw: (ctx: CanvasRenderingContext2D, attrs: unknown, styles: unknown) => {
      drawSelectGlow(ctx, attrs as LineAttrs | LineAttrs[], styles);
      line.drawImp(ctx, attrs, styles);
    },
  } as never);
  const circle = Circle.prototype;
  registerFigure({
    name: "circle",
    checkEventOn: (c: Pt, attrs: unknown, styles: unknown) =>
      touch && isGrabDot(styles)
        ? nearDot(c, attrs as CircleAttrs | CircleAttrs[], TOUCH_HANDLE_PX)
        : circle.checkEventOnImp(c, attrs, styles),
    draw: (ctx: CanvasRenderingContext2D, attrs: unknown, styles: unknown) => circle.drawImp(ctx, attrs, styles),
  } as never);
}
