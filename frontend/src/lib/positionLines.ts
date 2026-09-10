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
import { tradeLabel, isBreakeven, isBreakevenTarget, type TradeView } from "./trading";
import { isReplayTradeId } from "./replayLedger";
import type { PendingEdit, DraftOrder } from "./signals";

export interface LineSpec {
  key: string; // stable per line, e.g. `${tradeId}:stop`
  level: number;
  color: string;
  label: string;
  // Set only on ENTRY/limit lines (never SL/TP): the trade's direction, drawn as a
  // small ∧/∨ chevron prefixed inside the pill so a buy and a sell limit (identical
  // blue pills otherwise) read apart at a glance. Absent → no chevron.
  side?: "buy" | "sell";
  draggable: boolean;
  // Drawn emphasised (dashed, thicker) — set while the trade is hovered (panel row
  // or the line itself).
  highlight?: boolean;
  // Drawn click-selected (solid, sticky) — a stronger emphasis than hover. When both
  // are true, selected wins.
  selected?: boolean;
  // Pill anchor x (px from the pane's left edge); unset → far-left (6). Draft lines
  // set it (chartGeometry draftLabelX) so their pills sit with the bracket spine,
  // which now tracks the right price axis rather than a fixed left column (real
  // trades blank canvas labels and render DOM pills there instead).
  labelX?: number;
  // Fully revealed (full width + end marker suppressed) — hover, click-select, or an
  // active drag of this trade. Precomputed by the caller since drag state lives there.
  emphasized?: boolean;
  onDragEnd?: (newLevel: number) => void;
}

// Role-based colours (not side-based): neutral slate = your entry/limit level, red = stop,
// green = target. Colour carries only profit/loss meaning; the entry is de-hued (its side is
// conveyed by the label — Long / Short / Limit buy…) so it stops competing with the red/green.
const PRICE_COLOR = "#6b7280";
const STOP_COLOR = "#f23645";
const TP_COLOR = "#089981";

const PILL_FAMILY = "-apple-system, system-ui, sans-serif";
// Side marker prefixed INSIDE the entry/limit pill: an up chevron for buy/long, a
// down chevron for sell/short, so a buy and a sell limit (identical blue pills
// otherwise) read apart at a glance. SL/TP lines carry no side, so no chevron.
// Use ∧/∨ (logical and/or) — a true mirror-image PAIR that renders at the same size
// and vertical position, unlike ⌃/⌄ (keyboard arrowheads), whose metrics differ.
export const SIDE_CHEVRON = { buy: "∧", sell: "∨" } as const;

type LineField = "price" | "stop" | "takeProfit";

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
  // The trade whose line is being actively dragged (SL/TP/limit). Like hover/select
  // it fully reveals that trade's lines — so a dragged SL doesn't jump as a stub in
  // no-confirm mode, where a drag doesn't select. Null when nothing is dragging.
  dragging?: string | null;
  // The focused LINE of the selected trade (the one whose DOM pill is showing). That
  // line's own canvas label is blanked so the richer pill can take its place WITHOUT
  // doubling the text — the label "grows" into the pill at the same spot.
  selectedField?: "price" | "stop" | "tp" | null;
  // A new order being staged on this epic. Its lines are always draggable and
  // report under the id "draft".
  draft?: DraftOrder | null;
  // Is the cell these lines belong to inside a chart-replay session? REQUIRED,
  // and deliberately not defaulted: it decides whether a real broker draft may
  // be drawn and dragged over replayed bars (see the draft block below), and a
  // caller that forgets to answer should fail to compile rather than fail open.
  replaying: boolean;
  // Blank every position/order line's canvas label (the entry/SL/TP text pill), leaving
  // just the line — used when the always-on DOM pills render those labels instead, so
  // the two don't double up. Draft labels are unaffected (the draft has no DOM pill).
  hideTradeLabels?: boolean;
  // Pill anchor x for the DRAFT lines, from chartGeometry draftLabelX (needs the
  // live pane width, which only the chart knows). Omitted → the far-left fallback.
  draftLabelX?: number;
}

export const DRAFT_ID = "draft";

// Where a DRAFT line's canvas pill anchors when the caller cannot measure the pane:
// the far-left default. The real value comes from the caller as `draftLabelX` and
// tracks the bracket spine at the right price axis (chartGeometry draftLabelX) —
// the same slot the always-on DOM pills occupy for real trades. The bracket's %/R:R
// badges live LEFT of the spine on a canvas above this one, so a draft pill parked
// away from that column would sit under them and show only a clipped sliver.
export const DRAFT_LABEL_X_FALLBACK = 6;

/** Build the flat LineSpec list for all trades on `epic`, merging pending drags
 *  over server levels (so a dragged line doesn't snap back on the next poll). */
export function tradeLineSpecs(o: SpecBuildOpts): LineSpec[] {
  const specs: LineSpec[] = [];
  const fmt = (n: number) => n.toFixed(o.precision);
  for (const t of o.trades) {
    if (t.epic !== o.epic) continue;
    // A REPLAYING cell draws its ledger and nothing else. ChartCore already
    // withholds the account trades poll from such a cell (cellTradeBook), but
    // that is a single inline check inside a subscription no test can mount, so
    // this is what makes losing it harmless rather than expensive: a real
    // position drawn here would show today's levels on a chart that hides today
    // and hand them pills that deal against the account.
    if (o.replaying && !isReplayTradeId(t.id)) continue;
    const selected = o.selected === t.id;
    const highlight = o.hovered === t.id;
    // Any of hover / click-select / active-drag fully reveals this trade's lines.
    const emphasized = highlight || selected || o.dragging === t.id;
    // The focused line whose pill is up (only for the selected trade) — its label is
    // suppressed so the pill replaces it in place rather than overlapping it.
    const focusedField = selected ? o.selectedField ?? null : null;
    // Hidden lines are skipped — unless this trade is hovered or selected, in which
    // case it's temporarily revealed.
    if (o.hidden?.has(t.id) && !highlight && !selected) continue;
    const pend = o.pending[t.id] ?? {};
    // Merge by PRESENCE (not `??`): a pending field set to `null` means "removed".
    const price = pend.price !== undefined ? pend.price : t.priceLevel;
    const stop = pend.stop !== undefined ? pend.stop : t.stop;
    const tp = pend.takeProfit !== undefined ? pend.takeProfit : t.takeProfit;
    const word = tradeLabel(t.kind, t.side);
    // A position whose SL or TP sits at its entry (within a tick) is at BREAKEVEN:
    // that level's line and the entry line would render on the same row. Collapse
    // them into ONE '· BE'-tagged entry line — red when it's the stop, green when
    // it's the take-profit — and drop the separate SL/TP line. Orders never merge.
    // Both can't be validly true at once (SL-at-entry needs price above entry, TP-at-
    // entry below), but stop wins if they ever both compute true.
    const stopBE = t.kind === "position" && isBreakeven(price, stop, o.precision);
    const tpBE = t.kind === "position" && isBreakevenTarget(price, tp, o.precision);
    const breakeven = stopBE || tpBE;
    if (price != null) {
      // Show unrealized P/L on the entry label for open positions (not orders).
      const pnlStr =
        t.kind === "position" && t.upnl != null
          ? ` (${t.upnl >= 0 ? "+" : ""}${t.upnl.toFixed(2)})`
          : "";
      specs.push({
        key: `${t.id}:price`,
        level: price,
        // At breakeven the one line IS the merged level: red for the stop, green for
        // the take-profit; otherwise neutral entry.
        color: stopBE ? STOP_COLOR : tpBE ? TP_COLOR : PRICE_COLOR,
        side: t.side,
        label:
          o.hideTradeLabels || focusedField === "price"
            ? ""
            : `${word} ${t.quantity} @ ${fmt(price)}${pnlStr}${breakeven ? " · BE" : ""}`,
        // A resting order's price line is draggable to reprice it; a filled
        // position's entry is fixed (you can't change a fill), so never draggable.
        draggable: t.kind === "order",
        highlight,
        selected,
        emphasized,
        onDragEnd: (lvl) => o.onDrag(t.id, "price", lvl),
      });
    }
    if (stop != null && !stopBE) {
      specs.push({
        key: `${t.id}:stop`,
        level: stop,
        color: STOP_COLOR,
        label: o.hideTradeLabels || focusedField === "stop" ? "" : `SL ${fmt(stop)}`,
        draggable: o.levelsDraggable,
        highlight,
        selected,
        emphasized,
        onDragEnd: (lvl) => o.onDrag(t.id, "stop", lvl),
      });
    }
    if (tp != null && !tpBE) {
      specs.push({
        key: `${t.id}:tp`,
        level: tp,
        color: TP_COLOR,
        label: o.hideTradeLabels || focusedField === "tp" ? "" : `TP ${fmt(tp)}`,
        draggable: o.levelsDraggable,
        highlight,
        selected,
        emphasized,
        onDragEnd: (lvl) => o.onDrag(t.id, "takeProfit", lvl),
      });
    }
  }
  // Draft (new, un-submitted) order lines — always draggable. A market draft has
  // no entry line (fills at market); a limit draft does.
  //
  // Never on a REPLAYING cell. The draft is a real broker order waiting on
  // Submit, and these specs carry onDragEnd — the same specs the pixel pass
  // behind the drag hit-test is built from — so drawing it there would let a
  // user set a live order's entry/SL/TP by dragging them onto bars from years
  // ago, then submit at those levels. That is the failure lib/chartOrderMenu.ts
  // was lifted out of ChartCore to prevent for the axis menu; the menu got the
  // gate and the drawn lines did not. Gated HERE rather than at the two
  // ChartCore call sites because both of them (drawing and hit-testing) go
  // through this function, and `replaying` is REQUIRED so neither can silently
  // stop asking.
  const d = o.replaying ? null : o.draft;
  if (d && d.epic === o.epic) {
    const verb = d.side === "buy" ? "Buy" : "Sell";
    if (d.type === "limit" && d.price != null) {
      specs.push({
        key: `${DRAFT_ID}:price`,
        level: d.price,
        color: PRICE_COLOR,
        side: d.side,
        label: `${verb} limit ${d.quantity} @ ${fmt(d.price)}`,
        draggable: true,
        // ALWAYS emphasized: the declutter rule (draw only what you are engaged
        // with) is about resting positions, which have an axis pill and an entry
        // glyph to speak for them. A draft has neither — it is the order you are
        // currently placing, and its canvas label is the only place its levels
        // are stated. Unemphasized it would render nothing at all.
        emphasized: true,
        labelX: o.draftLabelX ?? DRAFT_LABEL_X_FALLBACK,
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
        // ALWAYS emphasized: the declutter rule (draw only what you are engaged
        // with) is about resting positions, which have an axis pill and an entry
        // glyph to speak for them. A draft has neither — it is the order you are
        // currently placing, and its canvas label is the only place its levels
        // are stated. Unemphasized it would render nothing at all.
        emphasized: true,
        labelX: o.draftLabelX ?? DRAFT_LABEL_X_FALLBACK,
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
        // ALWAYS emphasized: the declutter rule (draw only what you are engaged
        // with) is about resting positions, which have an axis pill and an entry
        // glyph to speak for them. A draft has neither — it is the order you are
        // currently placing, and its canvas label is the only place its levels
        // are stated. Unemphasized it would render nothing at all.
        emphasized: true,
        labelX: o.draftLabelX ?? DRAFT_LABEL_X_FALLBACK,
        onDragEnd: (lvl) => o.onDrag(DRAFT_ID, "takeProfit", lvl),
      });
    }
  }
  return specs;
}

interface LineExtra {
  label: string;
  color: string;
  side?: "buy" | "sell";
  highlight?: boolean;
  selected?: boolean;
  emphasized?: boolean;
  labelX?: number;
}

function asLineExtra(v: unknown): LineExtra {
  return v && typeof v === "object"
    ? (v as LineExtra)
    : { label: "", color: "#888", highlight: false, selected: false };
}

/** The span a trade line occupies (px from the pane's left edge), or null when it
 *  must not be drawn at all. The SINGLE source of that decision, shared by the canvas
 *  overlay (what's drawn) and ChartCore's click hit-test (what's clickable) so the two
 *  can't drift.
 *
 *  A line is ink for a trade you are ENGAGED with — hovered, click-selected, or being
 *  dragged. At rest there is nothing to draw: the axis-docked pill already states the
 *  level and the entry glyph already marks the candle the position opened on, so a
 *  line per level would be pure clutter across the chart body. Engaged, it spans the
 *  pane so the pill's row reads all the way across. */
export function tradeLineSpanX(o: {
  emphasized: boolean;
  width: number;
}): { startX: number; endX: number } | null {
  return o.emphasized ? { startX: 0, endX: o.width } : null;
}

// One-point horizontal line spanning the chart width, drawn only while its trade is
// engaged (tradeLineSpanX). The single point fixes the y (price); x runs edge to edge.
// Only a DRAFT carries a label here — real trades pass hideTradeLabels and let their
// axis-docked pill say it (chart/TradePills.tsx).
const tradeLine: OverlayTemplate = {
  name: "tradeLine",
  totalStep: 2,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  // NO y-axis price tag: klinecharts only draws it while the overlay is hovered, and
  // its padding makes it a hair wider than the tick labels — the axis auto-width then
  // flips (e.g. 53↔55px) on every hover in/out and the whole candle pane reflows
  // ("chart nudges right"). The DOM pill on the line already shows the exact price.
  needDefaultYAxisFigure: false,
  createPointFigures: (params) => {
    const { coordinates, bounding, overlay } = params;
    if (coordinates.length < 1) return [];
    // Point[0] is value-only (x defaults to 0) → its y is the price row and always
    // resolves. A bar-anchored line adds point[1] at the entry candle; take whichever
    // y is present so ordering can't strand us with a null.
    const y = coordinates[0].y ?? coordinates[1]?.y ?? 0;
    const extra = asLineExtra(overlay.extendData);
    // The line must RECEIVE pointer events to be grabbable when unlocked (we draw
    // no default point handles). When locked it ignores events so it can't be
    // selected/dragged or steal clicks from the chart underneath.
    const grabbable = overlay.lock === false;
    const width = bounding.width;
    // Declutter: nothing is drawn unless the trade is engaged (see tradeLineSpanX).
    const span = tradeLineSpanX({ emphasized: extra.emphasized ?? false, width });
    if (!span) return [];
    const { startX, endX } = span;
    const figures: OverlayFigure[] = [
      {
        type: "line",
        attrs: { coordinates: [{ x: startX, y }, { x: endX, y }] },
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
      // A ∧/∨ chevron prefixed inside the pill marks the side on entry/limit lines
      // (buy = up, sell = down); SL/TP lines carry no side, so no chevron.
      const text = extra.side ? `${SIDE_CHEVRON[extra.side]} ${extra.label}` : extra.label;
      figures.push({
        type: "text",
        // Centre the pill ON the line (far left), like an alert's hover pill —
        // its solid fill sits over the dashed line.
        attrs: { x: extra.labelX ?? 6, y, text, align: "left", baseline: "middle" },
        styles: {
          color: "#ffffff",
          backgroundColor: extra.color,
          size: 11,
          family: PILL_FAMILY,
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
    return `${s.level}|${s.label}|${s.color}|${s.side ?? ""}|${s.draggable}|${s.highlight ?? false}|${s.selected ?? false}|${s.emphasized ?? false}|${s.labelX ?? ""}`;
  }

  private onMoveEnd = (e: OverlayEvent<unknown>): boolean => {
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
      // ONE value-only point: it fixes the price row and drives drag/hit-test, and the
      // line spans the pane from it. (There used to be a second, bar-anchored point so
      // a resting line could truncate at its entry candle — that truncation is gone
      // now that lines draw only while engaged, and with it the per-render bar scan.)
      const points = [{ value: spec.level }];
      const extendData = {
        label: spec.label,
        color: spec.color,
        side: spec.side,
        highlight: spec.highlight ?? false,
        selected: spec.selected ?? false,
        emphasized: spec.emphasized ?? false,
        labelX: spec.labelX,
      };
      const existing = this.lines.get(spec.key);
      if (existing) {
        existing.onDragEnd = spec.onDragEnd; // always use the latest closure
        existing.level = spec.level; // track where the line now sits (drop-vs-click)
        if (existing.sig !== sig) {
          this.chart.overrideOverlay({
            id: existing.overlayId,
            points,
            lock: !spec.draggable,
            needDefaultPointFigure: spec.draggable,
            extendData,
          });
          existing.sig = sig;
        }
        continue;
      }
      const overlayId = this.chart.createOverlay({
        name: "tradeLine",
        points,
        lock: !spec.draggable,
        // The default point figure is klinecharts' drag handle — only show/enable
        // it for a draggable line (a locked line has none, can't be moved).
        needDefaultPointFigure: spec.draggable,
        extendData,
        styles: { line: { color: spec.color } },
        // Suppress klinecharts' default delete-on-right-click. v10 only honors
        // e.preventDefault() — the return value lost that meaning (a bare
        // `() => true` let a right-click silently remove a draggable trade line).
        onRightClick: (e) => {
          e.preventDefault?.();
          return true;
        },
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

// ── H bracket: split-color spine grouping SL/TP to the entry, cursor-tracked ──────
//
// A sleek visual link between a trade's entry line and its SL/TP, drawn on a dedicated
// overlay canvas in ChartCore (NOT a klinecharts overlay) so it can follow the cursor's
// x cheaply on every mousemove. Shown only for the SELECTED trade or the staged draft,
// and only when an SL or TP exists — with neither, the plain lines render exactly as
// before. Percentages are unsigned MAGNITUDES (colour carries the gain/loss meaning,
// like TradingView's position tool), so they read correctly for shorts too: the TP leg
// is always green, the SL leg always red, regardless of which sits above the entry.

export interface BracketGeom {
  // Entry/anchor price: a position's open level, an order/limit-draft's price, or the
  // live price for a market draft (which has no entry line of its own).
  entry: number | null;
  stop: number | null;
  tp: number | null;
}

export interface BracketLabelData {
  tpPct: number | null; // |TP − entry| / entry, %
  slPct: number | null; // |SL − entry| / entry, %
  rr: number | null; // reward / risk (only when both legs are present)
}

/** Distance of each leg from the entry as an unsigned percentage, plus reward/risk.
 *  Side-agnostic by design (magnitudes), so a short reads the same as a long. */
export function bracketLabels(g: BracketGeom): BracketLabelData {
  const { entry, stop, tp } = g;
  const pctOf = (lvl: number | null) =>
    entry != null && entry !== 0 && lvl != null
      ? Math.abs((lvl - entry) / entry) * 100
      : null;
  const rr =
    entry != null && stop != null && tp != null && Math.abs(entry - stop) > 0
      ? Math.abs(tp - entry) / Math.abs(entry - stop)
      : null;
  return { tpPct: pctOf(tp), slPct: pctOf(stop), rr };
}
