// On-chart trade lines: entry/limit price, stop-loss, and take-profit for every
// open position and resting order. READ-ONLY data-wise (server-owned, never
// persisted) and kept OUT of OverlayManager, but individual lines can be made
// draggable so the user can adjust SL/TP/limit by dragging — the drawer reports
// the new level via each line's `onDragEnd`; the caller decides whether to stage
// a pending edit (with confirmation) or apply immediately.
//
// Ownership is PER CELL: each ChartCore owns a PositionLines bound to its chart,
// rebuilt on chart (re)init and on every trades/pending update, filtered to the
// cell's epic. The renderer takes a flat list of LineSpecs from any source
// (position / working order / new-order draft) and reconciles by `key`.

import { registerOverlay } from "klinecharts";
import type {
  Chart,
  OverlayTemplate,
  OverlayFigure,
  OverlayEvent,
} from "klinecharts";
import { tradeLabel, type TradeView } from "./trading";
import type { PendingEdit, DraftOrder } from "./signals";

export interface LineSpec {
  key: string; // stable per line, e.g. `${tradeId}:stop`
  level: number;
  color: string;
  label: string;
  draggable: boolean;
  // Drawn emphasised (dashed, thicker) — set while the trade is hovered (panel row
  // or the line itself).
  highlight?: boolean;
  // Drawn click-selected (solid, sticky) — a stronger emphasis than hover. When both
  // are true, selected wins.
  selected?: boolean;
  onDragEnd?: (newLevel: number) => void;
}

// Role-based colours (not side-based): blue = your entry/limit level, red = stop,
// green = target. Side is conveyed by the label (Long / Short / Limit buy…).
const PRICE_COLOR = "#2962ff";
const STOP_COLOR = "#f23645";
const TP_COLOR = "#089981";

export type LineField = "price" | "stop" | "takeProfit";

export interface SpecBuildOpts {
  trades: TradeView[];
  pending: Record<string, PendingEdit>;
  epic: string;
  precision: number;
  // Whether SL/TP lines are draggable (off in read-only Stage 2; on otherwise).
  levelsDraggable: boolean;
  onDrag: (id: string, field: LineField, level: number) => void;
  // Trade ids whose lines the user hid (eye icon). Their lines are skipped unless
  // that trade is also `hovered` (hover temporarily reveals a hidden trade).
  hidden?: Set<string>;
  // The hovered trade id (panel row or chart line): its lines render highlighted.
  hovered?: string | null;
  // The click-selected trade id: its lines render solid (sticky emphasis).
  selected?: string | null;
  // A new order being staged on this epic. Its lines are always draggable and
  // report under the id "draft".
  draft?: DraftOrder | null;
}

export const DRAFT_ID = "draft";

/** Build the flat LineSpec list for all trades on `epic`, merging pending drags
 *  over server levels (so a dragged line doesn't snap back on the next poll). */
export function tradeLineSpecs(o: SpecBuildOpts): LineSpec[] {
  const specs: LineSpec[] = [];
  const fmt = (n: number) => n.toFixed(o.precision);
  for (const t of o.trades) {
    if (t.epic !== o.epic) continue;
    const selected = o.selected === t.id;
    const highlight = o.hovered === t.id;
    // Hidden lines are skipped — unless this trade is hovered or selected, in which
    // case it's temporarily revealed.
    if (o.hidden?.has(t.id) && !highlight && !selected) continue;
    const pend = o.pending[t.id] ?? {};
    // Merge by PRESENCE (not `??`): a pending field set to `null` means "removed".
    const price = pend.price !== undefined ? pend.price : t.priceLevel;
    const stop = pend.stop !== undefined ? pend.stop : t.stop;
    const tp = pend.takeProfit !== undefined ? pend.takeProfit : t.takeProfit;
    const word = tradeLabel(t.kind, t.side);
    if (price != null) {
      // Show unrealized P/L on the entry label for open positions (not orders).
      const pnlStr =
        t.kind === "position" && t.upnl != null
          ? ` (${t.upnl >= 0 ? "+" : ""}${t.upnl.toFixed(2)})`
          : "";
      specs.push({
        key: `${t.id}:price`,
        level: price,
        color: PRICE_COLOR,
        label: `${word} ${t.quantity} @ ${fmt(price)}${pnlStr}`,
        // A resting order's price line is draggable to reprice it; a filled
        // position's entry is fixed (you can't change a fill), so never draggable.
        draggable: t.kind === "order",
        highlight,
        selected,
        onDragEnd: (lvl) => o.onDrag(t.id, "price", lvl),
      });
    }
    if (stop != null) {
      specs.push({
        key: `${t.id}:stop`,
        level: stop,
        color: STOP_COLOR,
        label: `SL ${fmt(stop)}`,
        draggable: o.levelsDraggable,
        highlight,
        selected,
        onDragEnd: (lvl) => o.onDrag(t.id, "stop", lvl),
      });
    }
    if (tp != null) {
      specs.push({
        key: `${t.id}:tp`,
        level: tp,
        color: TP_COLOR,
        label: `TP ${fmt(tp)}`,
        draggable: o.levelsDraggable,
        highlight,
        selected,
        onDragEnd: (lvl) => o.onDrag(t.id, "takeProfit", lvl),
      });
    }
  }
  // Draft (new, un-submitted) order lines — always draggable. A market draft has
  // no entry line (fills at market); a limit draft does.
  const d = o.draft;
  if (d && d.epic === o.epic) {
    const verb = d.side === "buy" ? "Buy" : "Sell";
    if (d.type === "limit" && d.price != null) {
      specs.push({
        key: `${DRAFT_ID}:price`,
        level: d.price,
        color: PRICE_COLOR,
        label: `${verb} limit ${d.quantity} @ ${fmt(d.price)}`,
        draggable: true,
        onDragEnd: (lvl) => o.onDrag(DRAFT_ID, "price", lvl),
      });
    }
    if (d.stop != null) {
      specs.push({
        key: `${DRAFT_ID}:stop`,
        level: d.stop,
        color: STOP_COLOR,
        label: `SL ${fmt(d.stop)}`,
        draggable: true,
        onDragEnd: (lvl) => o.onDrag(DRAFT_ID, "stop", lvl),
      });
    }
    if (d.takeProfit != null) {
      specs.push({
        key: `${DRAFT_ID}:tp`,
        level: d.takeProfit,
        color: TP_COLOR,
        label: `TP ${fmt(d.takeProfit)}`,
        draggable: true,
        onDragEnd: (lvl) => o.onDrag(DRAFT_ID, "takeProfit", lvl),
      });
    }
  }
  return specs;
}

interface LineExtra {
  label: string;
  color: string;
  highlight?: boolean;
  selected?: boolean;
}

function asLineExtra(v: unknown): LineExtra {
  return v && typeof v === "object"
    ? (v as LineExtra)
    : { label: "", color: "#888", highlight: false, selected: false };
}

// One-point horizontal line spanning the chart width, with a left-anchored label
// just above it. The single point fixes the y (price); x runs edge to edge.
const tradeLine: OverlayTemplate = {
  name: "tradeLine",
  totalStep: 2,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: true, // price tag on the y-axis
  createPointFigures: (params) => {
    const { coordinates, bounding, overlay } = params;
    if (coordinates.length < 1) return [];
    const y = coordinates[0].y;
    const extra = asLineExtra(overlay.extendData);
    // The line must RECEIVE pointer events to be grabbable when unlocked (we draw
    // no default point handles). When locked it ignores events so it can't be
    // selected/dragged or steal clicks from the chart underneath.
    const grabbable = overlay.lock === false;
    const figures: OverlayFigure[] = [
      {
        type: "line",
        attrs: { coordinates: [{ x: 0, y }, { x: bounding.width, y }] },
        // Emphasised (hovered OR selected) lines stay dashed but draw thicker (2px)
        // so the row↔line link reads at a glance; the rest are thin (1px). Selection
        // looks identical to hover on the chart — it just persists after the cursor
        // leaves (the dock row carries the distinct sticky-selected styling).
        styles: {
          style: "dashed",
          dashedValue: [4, 4],
          color: extra.color,
          size: extra.selected || extra.highlight ? 2 : 1,
        },
        ignoreEvent: !grabbable,
      },
    ];
    if (extra.label) {
      figures.push({
        type: "text",
        // Centre the pill ON the line (far left), like an alert's hover pill —
        // its solid fill sits over the dashed line.
        attrs: { x: 6, y, text: extra.label, align: "left", baseline: "middle" },
        styles: {
          color: "#ffffff",
          backgroundColor: extra.color,
          size: 11,
          family: "-apple-system, system-ui, sans-serif",
          paddingLeft: 6,
          paddingRight: 6,
          paddingTop: 3,
          paddingBottom: 3,
          borderRadius: 3,
        },
        ignoreEvent: true,
      });
    }
    return figures;
  },
};

let registered = false;
export function registerPositionLine(): void {
  if (registered) return;
  registered = true;
  registerOverlay(tradeLine);
}

interface DrawnLine {
  overlayId: string;
  sig: string;
  // The level the line currently sits at (server/pending), so a drop that didn't
  // actually move the line reports nothing — see onMoveEnd.
  level: number;
  onDragEnd?: (newLevel: number) => void;
}

/** Per-cell drawer for trade lines. Reconciles a flat LineSpec[] by `key` so an
 *  update only adds/moves/removes what changed — no redraw-all flicker. */
export class PositionLines {
  private chart: Chart;
  private precision: number;
  // Called when the cursor enters/leaves a DRAGGABLE line, so the caller can show
  // an ns-resize (up/down) cursor while a line can be grabbed.
  private onHoverDraggable: (hovering: boolean) => void;

  private lines = new Map<string, DrawnLine>();

  constructor(
    chart: Chart,
    precision = 2,
    onHoverDraggable: (hovering: boolean) => void = () => {},
  ) {
    this.chart = chart;
    this.precision = precision;
    this.onHoverDraggable = onHoverDraggable;
  }

  setPrecision(precision: number): void {
    this.precision = precision;
  }

  private round(level: number): number {
    return Number(level.toFixed(this.precision));
  }

  private sig(s: LineSpec): string {
    return `${s.level}|${s.label}|${s.color}|${s.draggable}|${s.highlight ?? false}|${s.selected ?? false}`;
  }

  private onMoveEnd = (e: OverlayEvent): boolean => {
    // Find the line by overlay id, quantize the dropped level, report it. We snap
    // the overlay back to the server/spec level on the next render (the caller's
    // pending state drives where it actually sits), so dragging never silently
    // commits — it just reports intent. A plain CLICK on a draggable line also fires
    // this (klinecharts ends a zero-distance press), so we report only when the
    // level actually CHANGED — otherwise selecting a line would stage a no-op edit.
    const entry = [...this.lines.entries()].find(
      ([, l]) => l.overlayId === e.overlay.id,
    );
    const raw = e.overlay.points?.[0]?.value;
    if (entry && raw != null && entry[1].onDragEnd) {
      const dropped = this.round(raw);
      if (dropped !== this.round(entry[1].level)) entry[1].onDragEnd(dropped);
    }
    return false;
  };

  /** Reconcile drawn lines to `specs`. */
  render(specs: LineSpec[]): void {
    const seen = new Set<string>();
    for (const spec of specs) {
      seen.add(spec.key);
      const sig = this.sig(spec);
      const existing = this.lines.get(spec.key);
      if (existing) {
        existing.onDragEnd = spec.onDragEnd; // always use the latest closure
        existing.level = spec.level; // track where the line now sits (drop-vs-click)
        if (existing.sig !== sig) {
          this.chart.overrideOverlay({
            id: existing.overlayId,
            points: [{ value: spec.level }],
            lock: !spec.draggable,
            needDefaultPointFigure: spec.draggable,
            extendData: { label: spec.label, color: spec.color, highlight: spec.highlight ?? false, selected: spec.selected ?? false },
          });
          existing.sig = sig;
        }
        continue;
      }
      const overlayId = this.chart.createOverlay({
        name: "tradeLine",
        points: [{ value: spec.level }],
        lock: !spec.draggable,
        // The default point figure is klinecharts' drag handle — only show/enable
        // it for a draggable line (a locked line has none, can't be moved).
        needDefaultPointFigure: spec.draggable,
        extendData: { label: spec.label, color: spec.color, highlight: spec.highlight ?? false, selected: spec.selected ?? false },
        styles: { line: { color: spec.color } },
        onRightClick: () => true, // suppress klinecharts' default delete menu
        onPressedMoveEnd: this.onMoveEnd,
        // ns-resize cursor while hovering a grabbable line.
        onMouseEnter: (e) => {
          if (e.overlay.lock === false) this.onHoverDraggable(true);
          return false;
        },
        onMouseLeave: () => {
          this.onHoverDraggable(false);
          return false;
        },
      });
      if (typeof overlayId === "string") {
        this.lines.set(spec.key, { overlayId, sig, level: spec.level, onDragEnd: spec.onDragEnd });
      }
    }
    for (const [key, line] of this.lines) {
      if (!seen.has(key)) {
        this.chart.removeOverlay({ id: line.overlayId });
        this.lines.delete(key);
      }
    }
  }

  clear(): void {
    for (const line of this.lines.values()) {
      this.chart.removeOverlay({ id: line.overlayId });
    }
    this.lines.clear();
  }
}
