// Per-line TRENDLINES interaction: pick a line, then Highlight / Hide / To
// drawing from its context menu.
//
//  - Pick: a click (mouse) or tap (touch) on a line's body selects it, drawn
//    with a soft glow; a click or tap anywhere else clears it. Session-only,
//    carried on the instance's extendData.selectedLine so the draw path sees it.
//  - Menu: a right-click on any line (desktop, from ChartCore's contextmenu
//    handler), or a hold on the SELECTED line (touch: tap to pick, then hold,
//    the same rule the drawing menu follows).
//  - Highlight / Hide persist in the saved indicator config
//    (extendData.lineMarks, per epic), which the backend mirrors, so they
//    survive reloads and reach the user's other devices. The saved config is
//    the source of truth: every toggle reads it, not the live instance, so a
//    change pushed from another device is never stomped by a stale live copy.
//
// Hit targets come from the draw (trendlineMarks' segment registry), the same
// capture-don't-recompute rule the end-handle pins follow.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Chart } from "klinecharts";
import ContextMenu, { type MenuItem } from "../ContextMenu";
import { MenuIcons } from "../lib/menuIcons";
import { overrideExtend } from "../lib/overrideExtend";
import { indTypeOf } from "../lib/indicators/shared";
import { loadIndicatorConfigs, saveIndicatorConfig } from "../lib/persist";
import type { OverlayManager } from "../lib/overlays";
import {
  hitTrendline,
  marksFor,
  toggleMark,
  TL_LINE_HIT,
  TL_LINE_HIT_TOUCH,
  type LineMarkKind,
  type LineMarksByEpic,
  type TrendlineHit,
  type TrendlineSegment,
} from "../lib/indicators/trendlineMarks";
import { LONG_PRESS_MS, TAP_MOVE_PX, TAP_MS } from "./touchTap";

interface Picked {
  paneId: string;
  name: string;
  key: string;
}

/** The picked and the hovered line per chart, so each only writes (and
 * repaints) when it changes. */
const PICKED = new WeakMap<object, Picked | null>();
const HOVERED = new WeakMap<object, Picked | null>();

function markLine(
  map: WeakMap<object, Picked | null>,
  field: "selectedLine" | "hoveredLine",
  chart: Chart,
  next: Picked | null,
): void {
  const cur = map.get(chart) ?? null;
  if (
    cur?.key === next?.key &&
    cur?.paneId === next?.paneId &&
    cur?.name === next?.name
  )
    return;
  // null, not undefined: klinecharts' merge skips undefined, so only null
  // actually clears the key on the live instance.
  if (cur) overrideExtend(chart, cur.paneId, cur.name, { [field]: null });
  if (next) overrideExtend(chart, next.paneId, next.name, { [field]: next.key });
  map.set(chart, next);
}

export function pickTrendline(chart: Chart, next: Picked | null): void {
  markLine(PICKED, "selectedLine", chart, next);
  applyEmphasis(chart);
}

/** The line under the mouse, from the crosshair's move handler. */
export function hoverTrendline(chart: Chart, next: Picked | null): void {
  markLine(HOVERED, "hoveredLine", chart, next);
}

/** The TRENDLINES instances drawn emphasized (every line glowing) per chart,
 * and the selection / legend hover last asked for, so a pick can re-apply. */
const EMPHASIZED = new WeakMap<object, Set<string>>();
const WANTED = new WeakMap<object, { selected?: string | null; hovered?: string | null }>();

function applyEmphasis(chart: Chart): void {
  const { selected, hovered } = WANTED.get(chart) ?? {};
  // A line pick selects its instance too, but only that line should glow:
  // the all-lines glow belongs to the legend row (a click or a hover on it).
  const picked = PICKED.get(chart)?.name;
  const next = new Set<string>();
  for (const name of [selected !== picked ? selected : null, hovered]) {
    if (!name) continue;
    const ind = chart.getIndicators({ paneId: "candle_pane", name })[0];
    if (ind && indTypeOf(ind) === "TRENDLINES") next.add(name);
  }
  const cur = EMPHASIZED.get(chart) ?? new Set<string>();
  for (const name of cur)
    if (!next.has(name)) overrideExtend(chart, "candle_pane", name, { emphasized: null });
  for (const name of next)
    if (!cur.has(name)) overrideExtend(chart, "candle_pane", name, { emphasized: true });
  EMPHASIZED.set(chart, next);
}

/** Emphasize the selected indicator and the hovered legend row, when they
 * are a candle-pane TRENDLINES (anything else is ignored, so the caller can
 * pass whatever is selected). A selection made by picking one of its lines
 * is not emphasized. Writes only what changed. */
export function emphasizeTrendlines(
  chart: Chart,
  selected: string | null | undefined,
  hovered: string | null | undefined,
): void {
  WANTED.set(chart, { selected, hovered });
  applyEmphasis(chart);
}

/** Flip one mark and write it to BOTH the saved config (persist + backend
 * mirror) and the live instance (repaint). Returns the new marks. */
export function toggleTrendlineMark(
  chart: Chart,
  scope: string,
  epic: string,
  paneId: string,
  name: string,
  kind: LineMarkKind,
  key: string,
): LineMarksByEpic | undefined {
  const saved = loadIndicatorConfigs(scope)[name] ?? {};
  const ext = { ...(saved.extendData ?? {}) } as Record<string, unknown>;
  const next = toggleMark(ext.lineMarks as LineMarksByEpic | undefined, epic, kind, key);
  if (next) ext.lineMarks = next;
  else delete ext.lineMarks;
  saveIndicatorConfig(scope, name, {
    ...saved,
    extendData: Object.keys(ext).length ? ext : undefined,
  });
  overrideExtend(chart, paneId, name, { lineMarks: next ?? null });
  return next;
}

/** Place a drawing that reproduces the line's shape (same tool and points),
 * styled like one the user drew by hand: their saved default for that tool,
 * not the indicator's line style. Returns the new drawing id, or null when the
 * line could not be resolved to two distinct bars. */
export function trendlineToDrawing(
  overlays: OverlayManager,
  seg: TrendlineSegment,
): string | null {
  const c = seg.clone();
  if (!c) return null;
  return overlays.placeFreshDrawing(c.tool, c.points);
}

interface Args {
  chartRef: React.MutableRefObject<Chart | null>;
  containerRef: React.RefObject<HTMLElement | null>;
  overlays: OverlayManager;
  scope: string;
  epicRef: React.MutableRefObject<string>;
}

interface MenuState {
  x: number;
  y: number;
  hit: TrendlineHit;
}

export function useTrendlineMenu({ chartRef, containerRef, overlays, scope, epicRef }: Args): {
  /** Right-click entry, for ChartCore's contextmenu handler: opens the menu
   * when a line is under the pointer and says so, so the caller yields. */
  openAt: (clientX: number, clientY: number) => boolean;
  menu: ReactNode;
} {
  const [menu, setMenu] = useState<MenuState | null>(null);

  const hitAt = useCallback(
    (clientX: number, clientY: number, touch: boolean): TrendlineHit | null => {
      const chart = chartRef.current;
      const el = containerRef.current;
      if (!chart || !el) return null;
      const r = el.getBoundingClientRect();
      return hitTrendline(
        chart,
        clientX - r.left,
        clientY - r.top,
        touch ? TL_LINE_HIT_TOUCH : TL_LINE_HIT,
      );
    },
    [chartRef, containerRef],
  );

  const open = useCallback((clientX: number, clientY: number, hit: TrendlineHit) => {
    const chart = chartRef.current;
    if (!chart) return;
    pickTrendline(chart, { paneId: hit.paneId, name: hit.name, key: hit.seg.key });
    setMenu({ x: clientX, y: clientY, hit });
  }, [chartRef]);

  const openAt = useCallback(
    (clientX: number, clientY: number): boolean => {
      const hit = hitAt(clientX, clientY, false);
      if (!hit) return false;
      open(clientX, clientY, hit);
      return true;
    },
    [hitAt, open],
  );

  // Pick on click / tap, and the touch hold on the picked line. Pointer
  // events, not mouse ones: on a phone the canvas swallows the synthetic
  // mouse sequence (see touchTap.ts). Capture phase and never prevented, so
  // panning, drawings and the end-handle pins all see the press as before.
  const holdRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let press: { x: number; y: number; t: number; touch: boolean; moved: boolean; fingers: number } | null = null;
    const clearHold = () => {
      if (holdRef.current != null) clearTimeout(holdRef.current);
      holdRef.current = null;
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const touch = e.pointerType === "touch";
      if (press && touch) {
        // A second finger: a pinch, never a pick or a hold.
        press = { ...press, moved: true, fingers: press.fingers + 1 };
        clearHold();
        return;
      }
      press = { x: e.clientX, y: e.clientY, t: e.timeStamp, touch, moved: false, fingers: 1 };
      clearHold();
      if (!touch) return;
      const { clientX, clientY } = e;
      // After the drawing long-press (same delay) has had its turn: a hold a
      // drawing claimed is that drawing's, not the line's under it.
      holdRef.current = setTimeout(() => {
        holdRef.current = null;
        const chart = chartRef.current;
        if (!chart || !press || press.moved || overlays.isDrawing()) return;
        if (overlays.peekOverlayRightClick()) return;
        const hit = hitAt(clientX, clientY, true);
        const picked = PICKED.get(chart);
        if (!hit || !picked || picked.key !== hit.seg.key || picked.name !== hit.name) return;
        // The hold is spent: its release is not a tap.
        press = { ...press, moved: true };
        open(clientX, clientY, hit);
      }, LONG_PRESS_MS + 30);
    };
    const onMove = (e: PointerEvent) => {
      if (!press || press.moved) return;
      const slop = press.touch ? TAP_MOVE_PX : 4;
      if (Math.abs(e.clientX - press.x) > slop || Math.abs(e.clientY - press.y) > slop) {
        press = { ...press, moved: true };
        clearHold();
      }
    };
    const onUp = (e: PointerEvent) => {
      const p = press;
      if (!p) return;
      if (p.touch && p.fingers > 1) {
        // Wait for the last finger before starting over.
        press = { ...p, fingers: p.fingers - 1 };
        return;
      }
      press = null;
      clearHold();
      const chart = chartRef.current;
      if (!chart || p.moved || overlays.isDrawing()) return;
      if (p.touch && e.timeStamp - p.t > TAP_MS) return;
      const hit = hitAt(e.clientX, e.clientY, p.touch);
      pickTrendline(chart, hit ? { paneId: hit.paneId, name: hit.name, key: hit.seg.key } : null);
    };
    const onCancel = () => {
      press = null;
      clearHold();
    };
    el.addEventListener("pointerdown", onDown, true);
    el.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    el.addEventListener("pointercancel", onCancel, true);
    return () => {
      clearHold();
      el.removeEventListener("pointerdown", onDown, true);
      el.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      el.removeEventListener("pointercancel", onCancel, true);
    };
  }, [chartRef, containerRef, overlays, hitAt, open]);

  let node: ReactNode = null;
  if (menu) {
    const { hit } = menu;
    const epic = epicRef.current;
    const saved = loadIndicatorConfigs(scope)[hit.name]?.extendData as
      | { lineMarks?: LineMarksByEpic }
      | undefined;
    const marks = marksFor(saved?.lineMarks, epic);
    const key = hit.seg.key;
    const toggle = (kind: LineMarkKind) => {
      const chart = chartRef.current;
      if (chart) toggleTrendlineMark(chart, scope, epic, hit.paneId, hit.name, kind, key);
    };
    const bold = marks.bold.has(key);
    const hidden = marks.hidden.has(key);
    const items: MenuItem[] = [
      { label: bold ? "Unhighlight" : "Highlight", icon: MenuIcons.highlight, onClick: () => toggle("bold") },
      { label: hidden ? "Unhide" : "Hide", icon: hidden ? MenuIcons.show : MenuIcons.hide, onClick: () => toggle("hidden") },
      { label: "To drawing", icon: MenuIcons.pencil, onClick: () => void trendlineToDrawing(overlays, hit.seg) },
    ];
    node = <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />;
  }
  return { openAt, menu: node };
}
