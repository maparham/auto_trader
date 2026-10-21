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
import { toggleHistoryTrade, type ClosedTradeView } from "./accountHistory";
import { isReplayTradeId } from "./replayLedger";
import {
  MARKER_OVERLAY,
  ensureMarkerOverlayRegistered,
  barIndexForTs,
  setMarkerHoverCursor,
} from "./backtest";
import { tradeMarkerHoverSignal, selectTradeLine } from "./signals";

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
  // Open-position id for ENTRY markers only — lets a click select the matching
  // dock row (same id as tradeLineUiSignal.selected). Exit markers leave it unset:
  // a closed trade has no row in the positions list to select.
  tradeId?: string;
  // Broker-history close behind a History marker (entry or exit): a click
  // selects it like its History row does, and a second click deselects.
  closed?: ClosedTradeView;
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
  // Is the cell these markers belong to inside a chart-replay session? REQUIRED
  // and undefaulted, like SpecBuildOpts.replaying in lib/positionLines, so a
  // caller that forgets to answer fails to compile rather than fails open.
  //
  // It decides two things, both below: the account JOURNAL contributes no exit
  // markers at all (it is the user's own real closed trades, and recognising one
  // on a blind chart tells you when the window is), and the entry markers are
  // filtered to the replay ledger's own ids.
  replaying: boolean;
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
    // A replaying cell marks up its own ledger and nothing else. Fail closed on
    // the id for the same reason lib/positionLines does: an account position
    // that reached here is a bug in a gate upstream, and its entry sits at
    // today's price on a chart built to hide today.
    if (o.replaying && !isReplayTradeId(t.id)) continue;
    if (t.openedAt == null || !drawableAt(t.openedAt, o.oldestLoadedMs)) continue;
    specs.push({
      key: `entry:${t.id}`,
      tradeId: t.id,
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
  // The journal is the ACCOUNT's closed trades and has no replay counterpart
  // (the ledger's closes go to the report card, never to journalSignal), so a
  // replaying cell shows none of it. Note this is not reachable only through a
  // journal UPDATE: ChartCore seeds its journal ref at mount and redraws the
  // markers after every load, replay loads included.
  if (o.replaying) return specs;
  for (const j of o.journal) {
    if (j.epic !== o.epic) continue;
    const ms = j.ts * 1000;
    if (!drawableAt(ms, o.oldestLoadedMs)) continue;
    const win = j.pnl >= 0;
    // pnlIsMoney === false: the figure is a price-units estimate (no matched
    // broker TRADE row), good for the win/loss color above but not for a
    // printed amount, so the label carries no number.
    const label = j.pnlIsMoney === false ? "" : `${win ? "+" : ""}${j.pnl.toFixed(2)}`;
    specs.push({
      key: `exit:${journalKey(j)}`,
      timestamp: ms,
      price: j.exit,
      label,
      win,
      placement: j.leg === "long" ? "below" : "above",
      ...(j.closed ? { closed: j.closed } : {}),
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
  net: number; // sum of MONEY exits only (JournalTrade.pnlIsMoney !== false)
  // How many of `exits` are confirmed money, so a renderer can tell a cluster of
  // all-estimate closes (pnl is a price-units guess, see pnlIsMoney) from one
  // with a real net to print. 0 means every exit in the bucket is an estimate.
  moneyCount: number;
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
  // REQUIRED, for the reason on TradeMarkerSpecOpts.replaying: this is the OTHER
  // route the account journal takes onto the chart (the DOM pill layer rather
  // than the arrow overlays), so gating exitMarkerSpecs alone would leave the
  // coarse view leaking.
  replaying: boolean,
): ExitCluster[] {
  if (replaying) return [];
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
      cl = { barTs: bars[idx].timestamp, high: bars[idx].high, exits: [], net: 0, moneyCount: 0 };
      byBar.set(idx, cl);
    }
    cl.exits.push(j);
    // Only a confirmed-money exit contributes to the printed net — an estimate
    // (pnlIsMoney === false, lib/liveJournal) is price-units, not an amount.
    if (j.pnlIsMoney !== false) {
      cl.net += j.pnl;
      cl.moneyCount += 1;
    }
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

/** Broker-reported closes (lib/accountHistory) as journal rows, so exits flow
 * through the SAME path as journal exits: per-fill arrows via exitMarkerSpecs and
 * coarse-view pills via aggregateExitsByBar. Each partial close has its own close
 * time, so journalKey stays unique across partials. A close with no broker P&L
 * gets (exit - entry) x direction x size, the journal's own pnl unit. */
export function historyAsJournal(trades: ClosedTradeView[]): JournalTrade[] {
  return trades.map((t) => {
    const dir = t.side === "buy" ? 1 : -1;
    return {
      ts: t.closedAt / 1000,
      epic: t.epic,
      leg: t.side === "buy" ? "long" : "short",
      entry: t.entry,
      exit: t.exit,
      quantity: t.size,
      pnl: t.pnl ?? (t.exit - t.entry) * dir * t.size,
      pnlIsMoney: t.pnl != null,
      closed: t,
    };
  });
}

/** ENTRY markers for broker-closed trades: one per deal (partials share it, size
 * summed), at the matched open. Skipped while any part of the deal is still open
 * (the position book's own `entry:<id>` marker covers it), when the open fell
 * before the fetched range, off the loaded window, or while replaying. Keyed
 * `hentry:` so it never collides with an open position's `entry:`. */
export function historyEntrySpecs(history: ClosedTradeView[], o: TradeMarkerSpecOpts): TradeMarkerSpec[] {
  if (o.replaying) return [];
  const open = new Set(o.trades.filter((t) => t.kind === "position").map((t) => t.id));
  const byDeal = new Map<string, { first: ClosedTradeView; size: number }>();
  for (const t of history) {
    if (t.epic !== o.epic || t.openedAt == null || open.has(t.dealId)) continue;
    const seen = byDeal.get(t.dealId);
    if (seen) seen.size += t.size;
    else byDeal.set(t.dealId, { first: t, size: t.size });
  }
  const specs: TradeMarkerSpec[] = [];
  for (const [dealId, { first, size }] of byDeal) {
    const at = first.openedAt as number;
    if (!drawableAt(at, o.oldestLoadedMs)) continue;
    specs.push({
      key: `hentry:${dealId}`,
      timestamp: at,
      price: first.entry,
      label: `${tradeLabel("position", first.side)} ${size} @ ${first.entry.toFixed(o.precision)}`,
      win: null,
      placement: first.side === "buy" ? "below" : "above",
      closed: first,
    });
  }
  return specs;
}

interface DrawnMarker {
  overlayId: string;
  sig: string;
  // Latest label/win, read by the (create-time) hover handler so a reconciled
  // update is reflected in the DOM label without re-attaching the handler.
  label: string;
  win: boolean | null;
  // Latest closed trade, read by the (create-time) click handler.
  closed?: ClosedTradeView;
}

/** Per-cell drawer for live trade markers. Reconciles a flat TradeMarkerSpec[] by
 * `key` (reusing the backtest MARKER_OVERLAY) so an update only adds/moves/removes
 * what changed — no redraw-all flicker. Timestamp-anchored overlays reproject
 * themselves on pan/zoom, so there is no per-frame projection loop. */
export class TradeMarkers {
  private chart: Chart;
  private markers = new Map<string, DrawnMarker>();
  // When true, marker clicks are inert — the owning cell is in a mode where a
  // chart click means something else (e.g. AVWAP anchor placement), so a click
  // that happens to land on a marker must not also toggle the trade selection.
  private ignoreClicks: () => boolean;

  constructor(chart: Chart, ignoreClicks: () => boolean = () => false) {
    this.chart = chart;
    this.ignoreClicks = ignoreClicks;
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
        // Outside the sig check: the same key can carry a refreshed trade
        // object (a 60s poll) without moving, and the click must select it.
        existing.closed = spec.closed;
        continue;
      }
      // The glyph is a compact arrow; its full label is a DOM pill shown only
      // while hovered (tradeMarkerHoverSignal → App), so it never covers candles.
      // The hover signal also carries the ENTRY marker's tradeId: ChartCore's DOM
      // click handlers read it to know the click landed on a marker (skip the
      // line hit-test and the empty-space deselect — same idiom as the drawings'
      // getHoveredDrawingId guard) and to open the editor on double-click.
      // tradeId is stable per key, so capturing it at create time is safe across
      // reconciles. Journal exits have none and stay non-interactive; History
      // markers carry `closed` instead and click to select that close.
      const drawn: DrawnMarker = { overlayId: "", sig, label: spec.label, win: spec.win, closed: spec.closed };
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
            tradeId: spec.tradeId,
          });
          setMarkerHoverCursor(this.chart, true);
          return false;
        },
        onMouseLeave: () => {
          tradeMarkerHoverSignal.set(null);
          setMarkerHoverCursor(this.chart, false);
          return false;
        },
        // Clicking an ENTRY marker selects/deselects its open position in the
        // dock — same call as single-clicking the position's chart lines
        // (highlight only, no edit ticket). Inert while the owning cell is in a
        // click-means-something-else mode (ignoreClicks).
        onClick: () => {
          const tid = spec.tradeId;
          if (this.ignoreClicks()) return false;
          if (tid) selectTradeLine(tid, "price", false);
          else if (drawn.closed) toggleHistoryTrade(drawn.closed);
          return false;
        },
        // v10 deletes an overlay on right-click unless the handler calls
        // e.preventDefault() — without this a right-click on a marker silently
        // removed it until the next reconcile.
        onRightClick: (e) => {
          e.preventDefault?.();
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
