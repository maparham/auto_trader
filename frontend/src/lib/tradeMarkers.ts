// On-chart markers for LIVE / paper trades: where a trade entered (open
// position) and where it exited (journaled close), so the chart shows the same
// fill-marker visual language the backtest uses — but driven by the live trading
// book instead of a backtest result.
//
// Two independent sources feed one overlay type, and a trade is in exactly one of
// them at a time (open → position book; closed → journal), so entry and exit
// markers never double up:
//   - Entry markers  ← open positions (tradesSignal, kind "position").
//   - Exit  markers  ← journaled closes (journalSignal), P&L-inferred win/loss.
//
// Placement is keyed to the position's DIRECTION (not the candle body, unlike the
// backtest's markerPlacement): long hangs BELOW, short sits ABOVE — applied to
// both a trade's entry and its exit.
//
// Ownership is PER CELL, mirroring PositionLines: each ChartCore owns a
// TradeMarkers bound to its chart, filtered to the cell's epic, rebuilt on every
// trades/journal update and on epic switch. It REUSES the backtest fill-marker
// overlay (backtest.ts MARKER_OVERLAY) rather than defining a new glyph, and
// reconciles a flat spec list by a stable `key` so an update only adds/moves/
// removes what changed.

import type { Chart } from "klinecharts";
import { tradeLabel, type TradeView } from "./trading";
import type { JournalTrade } from "./liveJournal";
import {
  MARKER_OVERLAY,
  ensureMarkerOverlayRegistered,
  barIndexForTs,
  setMarkerHoverCursor,
} from "./backtest";
import { tradeMarkerHoverSignal } from "./signals";

/** One live trade marker, ready to hand to the backtest MARKER_OVERLAY. The
 * `timestamp` is the RAW fill/close time in ms; the drawer anchors it to the bar
 * that contains it. `win` null → neutral (entry) blue pill; true/false → green /
 * red (exit). */
export interface TradeMarkerSpec {
  key: string; // `entry:<tradeId>` | `exit:<journalKey>`
  timestamp: number; // ms
  price: number;
  label: string;
  win: boolean | null;
  placement: "above" | "below";
}

export interface TradeMarkerSpecOpts {
  trades: TradeView[];
  journal: JournalTrade[];
  epic: string;
  precision: number;
  // Oldest loaded bar time (ms), or null when no bars are loaded. A marker whose
  // anchor time is older than this is culled — it would otherwise clamp onto the
  // left-edge bar into a pile (the same off-window cull the backtest markers use).
  // Paging history back to reach an older bar is deferred (see the spec).
  oldestLoadedMs: number | null;
}

/** Stable key for a journal exit. JournalTrade carries no id, so mint a
 * deterministic one from its fields — an unchanged close reconciles to the same
 * marker instead of churning. */
export function journalKey(j: JournalTrade): string {
  return `${j.ts}:${j.epic}:${j.leg}:${j.entry}:${j.exit}:${j.pnl}`;
}

/** Older than the oldest loaded bar (or nothing loaded) → not drawable here. */
function drawableAt(ms: number, oldestLoadedMs: number | null): boolean {
  return oldestLoadedMs != null && ms >= oldestLoadedMs;
}

/** ENTRY markers — one per OPEN position on `epic` (netted to at most one per
 * epic; resting limit orders excluded). A position with no open time can't be
 * anchored, so it's skipped. Pure + exported for tests. */
export function entryMarkerSpecs(o: TradeMarkerSpecOpts): TradeMarkerSpec[] {
  const specs: TradeMarkerSpec[] = [];
  for (const t of o.trades) {
    if (t.epic !== o.epic || t.kind !== "position") continue;
    if (t.openedAt == null || !drawableAt(t.openedAt, o.oldestLoadedMs)) continue;
    specs.push({
      key: `entry:${t.id}`,
      timestamp: t.openedAt, // already ms (Date.parse of created_at)
      price: t.priceLevel,
      label: `${tradeLabel(t.kind, t.side)} ${t.quantity} @ ${t.priceLevel.toFixed(o.precision)}`,
      win: null,
      placement: t.side === "buy" ? "below" : "above",
    });
  }
  return specs;
}

/** EXIT markers as per-fill arrows — one per journaled close on `epic`. Used on
 * the native/finer view; a coarser view aggregates these into per-bar pills
 * instead (see aggregateExitsByBar). `ts` is unix SECONDS. Pure + exported. */
export function exitMarkerSpecs(o: TradeMarkerSpecOpts): TradeMarkerSpec[] {
  const specs: TradeMarkerSpec[] = [];
  for (const j of o.journal) {
    if (j.epic !== o.epic) continue;
    const ms = j.ts * 1000;
    if (!drawableAt(ms, o.oldestLoadedMs)) continue;
    const win = j.pnl >= 0;
    specs.push({
      key: `exit:${journalKey(j)}`,
      timestamp: ms,
      price: j.exit,
      label: `${win ? "+" : ""}${j.pnl.toFixed(2)}`,
      win,
      placement: j.leg === "long" ? "below" : "above",
    });
  }
  return specs;
}

/** Build the flat marker-spec list for `epic`: one ENTRY marker per open position
 * and one EXIT marker per journaled close (per-fill arrows). The native/finer-view
 * path; coarser views route exits through aggregateExitsByBar instead. Pure +
 * exported for tests. */
export function tradeMarkerSpecs(o: TradeMarkerSpecOpts): TradeMarkerSpec[] {
  return [...entryMarkerSpecs(o), ...exitMarkerSpecs(o)];
}

/** One loaded chart bar's worth of journaled exits, ready to draw as a single
 * pill (exit count + net P&L). `barTs`/`high` anchor the pill; `exits` backs the
 * hover list. Pure output of aggregateExitsByBar. */
export interface ExitCluster {
  barTs: number;
  high: number;
  exits: JournalTrade[];
  net: number;
}

/** Bucket `epic`'s journaled exits into the loaded chart bar that CONTAINS each
 * close (by the shared barIndexForTs rule), for a view COARSER than the exits'
 * cadence — where per-fill arrows would collapse onto the same bar. Exits older
 * than the oldest loaded bar are CULLED (not clamped to the edge — that's the
 * off-window pile the cull exists to avoid; page-back is deferred in v1). Pure +
 * exported for tests. */
export function aggregateExitsByBar(
  journal: JournalTrade[],
  epic: string,
  bars: { timestamp: number; high: number }[],
): ExitCluster[] {
  if (bars.length === 0) return [];
  const barTimes = bars.map((b) => b.timestamp);
  const oldest = barTimes[0];
  const byBar = new Map<number, ExitCluster>();
  for (const j of journal) {
    if (j.epic !== epic) continue;
    const ms = j.ts * 1000;
    if (ms < oldest) continue; // off-window: culled, not clamped
    const idx = barIndexForTs(barTimes, ms);
    if (idx < 0) continue;
    let cl = byBar.get(idx);
    if (!cl) {
      cl = { barTs: bars[idx].timestamp, high: bars[idx].high, exits: [], net: 0 };
      byBar.set(idx, cl);
    }
    cl.exits.push(j);
    cl.net += j.pnl;
  }
  return [...byBar.values()].sort((a, b) => a.barTs - b.barTs);
}

/** Whether exits COLLIDE on the current view — any loaded bar holds ≥2 closes.
 * The live analog of backtestRenderFlags' native/aggregate decision: since live
 * markers have no fixed "native" timeframe (the journal records no strategy TF,
 * and closes outlive the armed session), the mode is driven by the data — arrows
 * while every bar has at most one exit, aggregate pills once a bar packs several.
 * Reload-stable (the loaded, culled bucket set doesn't shift on scroll in v1). */
export function exitsCollide(clusters: ExitCluster[]): boolean {
  return clusters.some((c) => c.exits.length >= 2);
}

interface DrawnMarker {
  overlayId: string;
  sig: string;
  // Latest label/win, read by the (create-time) hover handler so a reconciled
  // update is reflected in the DOM label without re-attaching the handler.
  label: string;
  win: boolean | null;
}

/** Per-cell drawer for live trade markers. Reconciles a flat TradeMarkerSpec[] by
 * `key` (reusing the backtest MARKER_OVERLAY) so an update only adds/moves/removes
 * what changed — no redraw-all flicker. Timestamp-anchored overlays reproject
 * themselves on pan/zoom, so there is no per-frame projection loop. */
export class TradeMarkers {
  private chart: Chart;
  private markers = new Map<string, DrawnMarker>();

  constructor(chart: Chart) {
    this.chart = chart;
    ensureMarkerOverlayRegistered();
  }

  private sig(s: TradeMarkerSpec, anchorTs: number, anchorValue: number): string {
    return `${anchorTs}|${anchorValue}|${s.label}|${s.win}|${s.placement}`;
  }

  /** Reconcile drawn markers to `specs`, anchoring each to the bar that contains
   * its fill/close time. Specs older than the loaded window are already culled by
   * the builder; the empty-chart guard here (idx < 0) keeps a pre-data render a
   * no-op. */
  render(specs: TradeMarkerSpec[]): void {
    const bars = this.chart.getDataList() ?? [];
    const barTimes = bars.map((k) => k.timestamp);
    const seen = new Set<string>();
    for (const spec of specs) {
      const idx = barIndexForTs(barTimes, spec.timestamp);
      if (idx < 0) continue;
      const anchorTs = barTimes[idx];
      // Anchor at the candle's EXTREME (low for a below-marker, high for an
      // above one) rather than the entry price, so the overlay's fixed pixel gap
      // reads off the wick and the glyph always clears the candle — the entry
      // price can sit mid-body and leave the glyph inside a tall candle.
      const anchorValue = spec.placement === "below" ? bars[idx].low : bars[idx].high;
      seen.add(spec.key);
      const sig = this.sig(spec, anchorTs, anchorValue);
      const extendData = {
        label: spec.label,
        win: spec.win,
        placement: spec.placement,
        style: "live" as const,
      };
      const existing = this.markers.get(spec.key);
      if (existing) {
        if (existing.sig !== sig) {
          this.chart.overrideOverlay({
            id: existing.overlayId,
            points: [{ timestamp: anchorTs, value: anchorValue }],
            extendData,
          });
          existing.sig = sig;
          existing.label = spec.label;
          existing.win = spec.win;
        }
        continue;
      }
      // The glyph is a compact arrow; its full label is a DOM pill shown only
      // while hovered (tradeMarkerHoverSignal → App), so it never covers candles.
      const drawn: DrawnMarker = { overlayId: "", sig, label: spec.label, win: spec.win };
      const id = this.chart.createOverlay({
        name: MARKER_OVERLAY,
        points: [{ timestamp: anchorTs, value: anchorValue }],
        lock: true, // read-only live artifact, never a user drawing
        extendData,
        onMouseEnter: (e) => {
          tradeMarkerHoverSignal.set({
            label: drawn.label,
            win: drawn.win,
            x: e.pageX ?? 0,
            y: e.pageY ?? 0,
          });
          setMarkerHoverCursor(this.chart, true);
          return false;
        },
        onMouseLeave: () => {
          tradeMarkerHoverSignal.set(null);
          setMarkerHoverCursor(this.chart, false);
          return false;
        },
      });
      if (typeof id === "string") {
        drawn.overlayId = id;
        this.markers.set(spec.key, drawn);
      }
    }
    for (const [key, m] of this.markers) {
      if (!seen.has(key)) {
        this.chart.removeOverlay({ id: m.overlayId });
        this.markers.delete(key);
      }
    }
  }

  clear(): void {
    for (const m of this.markers.values()) this.chart.removeOverlay({ id: m.overlayId });
    this.markers.clear();
    // Removing a hovered glyph won't fire its onMouseLeave — drop any stale label.
    tradeMarkerHoverSignal.set(null);
    setMarkerHoverCursor(this.chart, false);
  }
}
