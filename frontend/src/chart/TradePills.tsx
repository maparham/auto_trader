import { Fragment, useLayoutEffect, useRef, type MutableRefObject } from "react";
import { formatExpiryLong, formatExpiryShort } from "../lib/alertUi";
import { toast } from "../lib/notify";
import { requestConfirm, setTradeSelected, discardPendingEdit, discardPendingField, type PendingEdit, type TradeLineField } from "../lib/signals";
import { tradeLabel, mergeTradeLevels, applyEditedLevels, closePosition, cancelWorkingOrder, refreshTrades, getTradesAccount, type TradeView, type OrderSide } from "../lib/trading";
import { isCellReplaying } from "../lib/chartSync";
import { cellTradeBook } from "../lib/replayLedger";
import { useMaskedReplayFor, type MaskedReplay } from "../lib/useMaskedReplay";
import { maskedTimeLabel } from "../lib/timeFormat";
import Tooltip from "../components/Tooltip";

export interface TradePillItem {
  tradeId: string;
  field: TradeLineField;
  y: number;
  kind: "position" | "order";
  side: OrderSide;
  qty: number;
  level: number;
  expiresAt: number | null; // resting order: good-till-date epoch ms; null = GTC
  pl: number | null; // entry: uPnL; SL/TP: P/L if that level is hit
  // SL/TP only: side-aware % price move from entry to this level (TP in profit is
  // positive). The COMPACT face shows this instead of the money figure; null on
  // entry pills (and on a zero entry level, where no percent is computable).
  pct: number | null;
  changed: boolean; // this line has an un-applied drag → show Apply/Discard
  // entry pill only: which level merged into the entry at breakeven (SL or TP sits
  // at entry) → show a "BE" chip; the field says which pending edit Discard clears.
  breakevenField?: "stop" | "takeProfit";
}

interface TradePillsProps {
  /** Which chart cell these pills belong to. Only used to look up THIS cell's
   * masked-replay session (a pill belongs to exactly one cell, so a live sibling
   * keeps its real dates and the day number counts from its own anchor). */
  cellId: string;
  pills: TradePillItem[];
  precisionRef: MutableRefObject<number>;
  tradesRef: MutableRefObject<TradeView[]>;
  pendingRef: MutableRefObject<Record<string, PendingEdit>>;
  tradePillNodesRef: MutableRefObject<Map<string, HTMLDivElement>>;
  hoveredPillKey: string | null;
  focusedPillKey: string | null;
  // The click-SELECTED trade (not hover): its whole pill group carries a persistent
  // selected style, tying the spine/bracket to its pills when neighbours overlap.
  selectedTradeId: string | null;
  /** Width of the price-axis column: the pills dock right-edge flush against it. */
  axisWidth: number;
  /** Called after every layout pass, once the pill faces have their final widths.
   *  The bracket spine is placed by measuring those faces, but selection repaints it
   *  synchronously from a signal subscriber — before React commits the expanded face
   *  — so without this the spine would keep the compact width and end up underneath
   *  its own pill. */
  onFacesLaidOut?: () => void;
  /** Where Apply / Close / Cancel go. Defaults to the account's HTTP dealing
   * calls; a replaying cell passes ledger-backed implementations instead. */
  actions?: {
    apply(t: TradeView, merged: { price: number | null; stop: number | null; takeProfit: number | null }): Promise<void>;
    close(t: TradeView): Promise<void>;
    cancel(t: TradeView): Promise<void>;
  };
}

const PILL_H = 22; // .trade-pill height (App.css)
const ROW = 24; // vertical pitch inside a spread column

// Transitive collision chaining over y-sorted pills: each pill within a pill
// height of the previous one joins the cluster. Used twice — at render time to
// decide which clusters COLLAPSE into a summary pill, and by the layout pass to
// spread whatever actually rendered.
function chainClusters<T extends { y: number }>(sorted: T[]): T[][] {
  const clusters: T[][] = [];
  let cluster: T[] = [];
  for (const e of sorted) {
    if (cluster.length && e.y - cluster[cluster.length - 1].y >= PILL_H) {
      clusters.push(cluster);
      cluster = [];
    }
    cluster.push(e);
  }
  if (cluster.length) clusters.push(cluster);
  return clusters;
}

const signed = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}`;
const fmtDateTime = (ms: number) => new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

// A trade's timestamps are BAR timestamps once its cell is replaying, so during a
// masked session printing them here would hand back the exact date the session
// exists to hide — the one number the whole feature rests on. Route every
// time-bearing label through the cell's own session when it has one.
//
// Per-cell, never the any-cell read: these pills belong to one chart, so a live
// sibling cell must keep its real dates, and the day number has to count from
// THIS cell's anchor rather than a neighbour's.
function timeLabelFor(masked: MaskedReplay): (ms: number) => string {
  if (!masked) return fmtDateTime;
  return (ms: number) => maskedTimeLabel(masked.startMs, ms, masked.clock, masked.timezone);
}

/**
 * The ACTIVE line's pill (entry / SL / TP — only one shows). It carries the
 * symbol + level; the entry pill adds uPnL + close, the SL/TP pills add the P/L
 * that level would realise if hit + remove. ANY pill shows Apply/Discard when
 * ITS OWN line has a staged drag. Anchored at the line's y (vertically spread with a
 * leader tick when pills overlap — see the layout pass below), frozen x.
 * Pure props-in — all mutable trade state stays in ChartCore via refs.
 */
export default function TradePills({
  cellId,
  pills,
  precisionRef,
  tradesRef,
  pendingRef,
  tradePillNodesRef,
  hoveredPillKey,
  focusedPillKey,
  selectedTradeId,
  axisWidth,
  onFacesLaidOut,
  actions,
}: TradePillsProps) {
  // Is THIS cell replaying? Asked at CLICK time (a Set lookup), not captured at
  // render: the two questions below are about what a button press may do, and the
  // answer must be the one that holds when it is pressed.
  const replaying = () => isCellReplaying(cellId);
  // Whether a chart-side selection may open the app's real OrderTicket. It may
  // not while this cell is replaying: a pill there belongs to the cell's local
  // ledger, that id is in no account book, and the ticket therefore falls back to
  // its LIVE new-order form — a real-money submit one click from a practice
  // trade, on today's quote, inside a session whose whole point is not knowing
  // where price ended up. Selecting still happens (the pills ARE the replay
  // trade UI: drag to move a level, then Apply / Close / Cancel); only the panel
  // is withheld, which is exactly what a single click on the line already does.
  const opensTicket = () => !replaying();
  // Dealing defaulted ONCE, so the three call sites below read the same object
  // whether the trade lives in the account or in a replay ledger. The default
  // branch keeps the refreshTrades that follows each account write; the replay
  // branch has nothing to refresh (its book publishes itself).
  //
  // The default FAILS CLOSED. A replaying cell is supposed to pass `actions`
  // (ChartCore does), but that is one ternary at one call site with nothing in
  // the type system holding it there: lose it and every pill on a practice trade
  // would deal against the user's real account. So when the cell is replaying and
  // no ledger actions arrived, refuse and say so rather than reach for the
  // broker.
  const mayDealOnAccount = () => {
    if (cellTradeBook(replaying()).dealing === "account") return true;
    toast("Replay session: practice trades are not sent to your account.");
    return false;
  };
  const act = actions ?? {
    apply: async (t: TradeView, merged: { price: number | null; stop: number | null; takeProfit: number | null }) => {
      if (!mayDealOnAccount()) return;
      await applyEditedLevels(t, merged, getTradesAccount());
      refreshTrades();
    },
    close: async (t: TradeView) => {
      if (!mayDealOnAccount()) return;
      await closePosition(t.id, getTradesAccount());
      refreshTrades();
    },
    cancel: async (t: TradeView) => {
      if (!mayDealOnAccount()) return;
      await cancelWorkingOrder(t.id, getTradesAccount());
      refreshTrades();
    },
  };
  // This cell's blind session, if it has one — every timestamp the pills render
  // goes through it (see timeLabelFor). The expiry labels get the same treatment
  // rather than their alert-UI formatters: a resting order's good-till-date is a
  // real calendar date like any other. Today they can only ever carry an account
  // order's expiry (a replay view's expiresAt is always null), but the mask fails
  // CLOSED here on purpose — over-masking costs a label, under-masking costs the
  // session.
  const masked = useMaskedReplayFor(cellId);
  const fmtTime = timeLabelFor(masked);
  const fmtExpiry = (ms: number, long: boolean) =>
    masked ? fmtTime(ms) : long ? formatExpiryLong(ms) : formatExpiryShort(ms);
  // The trades whose WHOLE pill group rises above resting pills: the focused trade
  // (selection wins in focusedPillKey upstream) and the hovered pill's trade — so
  // hovering an SL/TP raises its entry sibling too. Keys are "tradeId:field"; the
  // trade id may itself contain colons, so split on the LAST one.
  const tradeIdOf = (key: string | null) => (key ? key.slice(0, key.lastIndexOf(":")) : null);
  const focusedTradeId = tradeIdOf(focusedPillKey);
  const hoveredTradeId = tradeIdOf(hoveredPillKey);
  // Leader-tick nodes keyed like the pills; geometry is written by the layout pass.
  const leaderNodesRef = useRef(new Map<string, HTMLDivElement>());
  // A pill is ENGAGED — its cluster expands into the spread column — only while
  // it is hovered or a drag is staged on its line (Apply/Discard must stay
  // reachable without a hover). Selection/focus deliberately do NOT engage:
  // pills hold their exact price levels at rest, so a selected trade inside a
  // cluster stays merged in the aggregate until the pointer visits it; the
  // aggregate carries the selected style instead (see the summary below).
  const pillEngaged = (p: TradePillItem) => {
    const key = `${p.tradeId}:${p.field}`;
    return key === hoveredPillKey || p.changed;
  };
  // Colliding pills collapse into ONE summary pill (count + net P/L) unless the
  // cluster is engaged — then its members render individually and the layout pass
  // spreads them. Clustered at render (not in the effect) because collapsing
  // changes WHAT renders, not just where.
  const renderClusters = chainClusters([...pills].sort((a, b) => a.y - b.y));
  const visible: Array<
    | { kind: "pill"; pill: TradePillItem }
    | { kind: "summary"; members: TradePillItem[]; key: string; y: number }
  > = [];
  for (const c of renderClusters) {
    if (c.length > 1 && !c.some(pillEngaged)) {
      const mean = c.reduce((s2, e) => s2 + e.y, 0) / c.length;
      visible.push({ kind: "summary", members: c, key: `${c[0].tradeId}:${c[0].field}`, y: mean });
    } else {
      for (const m of c) visible.push({ kind: "pill", pill: m });
    }
  }
  // Overlap declutter — vertical spread: pills whose 22px bodies collide vertically form
  // a cluster and spread into a one-per-row column (24px pitch) centred on the cluster's
  // mean y, all at the shared anchor x. No horizontal run, every pill fully readable.
  // Each displaced pill gets a thin leader tick just inside the axis, at its right
  // edge (the pills dock there), tying it back to
  // its true line y. Written to the DOM after every render (React re-renders reset
  // `top`, then this pass reapplies); a sweep over the y-sorted pills chains clusters
  // transitively: each pill within a pill-height of the previous one joins the cluster.
  useLayoutEffect(() => {
    const HALF = PILL_H / 2;
    type Entry = { key: string; y: number };
    // Already y-sorted: `visible` is built from y-sorted render clusters, and a
    // collapsed summary's mean lies inside its members' span.
    const sorted: Entry[] = visible.map((v) =>
      v.kind === "pill" ? { key: `${v.pill.tradeId}:${v.pill.field}`, y: v.pill.y } : { key: v.key, y: v.y },
    );
    const clusters = chainClusters(sorted);
    // Keep the column on the pane: clamp its top edge, and its bottom edge when the
    // clip container's height is known (jsdom has no layout — offsetParent is null).
    const paneH = sorted.length
      ? tradePillNodesRef.current.get(sorted[0].key)?.offsetParent?.clientHeight ?? 0
      : 0;
    // Also the singleton path (mean = its own y, zero rows of spread): a lone row
    // still clamps, so a collapsed summary near the pane edge stays fully on it.
    const startOf = (c: Entry[]) => {
      const mean = c.reduce((s, e) => s + e.y, 0) / c.length;
      let start = mean - ((c.length - 1) * ROW) / 2;
      if (paneH > 0) start = Math.min(start, paneH - HALF - (c.length - 1) * ROW);
      return Math.max(start, HALF);
    };
    // A spread column is taller than the price span it covers, so it can collide with a
    // neighbour the true-y pass kept separate (and clamping can push it into one) —
    // merge adjacent clusters until every column clears the next by a pill height.
    for (let merged = true; merged; ) {
      merged = false;
      for (let i = 0; i + 1 < clusters.length; i++) {
        const endI = startOf(clusters[i]) + (clusters[i].length - 1) * ROW;
        if (startOf(clusters[i + 1]) - endI < PILL_H) {
          clusters.splice(i, 2, [...clusters[i], ...clusters[i + 1]]);
          merged = true;
          break;
        }
      }
    }
    // Measure BEFORE writing: the leader tick needs each face's width, and reading
    // offsetWidth after a style write forces a synchronous layout — interleaved, that
    // is one reflow per pill, on an effect that runs every render (so every tick).
    const faceW = new Map<string, number>();
    for (const c of clusters) {
      for (const e of c) faceW.set(e.key, tradePillNodesRef.current.get(e.key)?.offsetWidth ?? 0);
    }
    for (const c of clusters) {
      const start = startOf(c);
      c.forEach((e, i) => {
        const rowY = start + i * ROW;
        const node = tradePillNodesRef.current.get(e.key);
        if (node) node.style.top = `${rowY}px`;
        // Leader tick: pill edge → true line y, shown only when the line falls OUTSIDE
        // the pill's own 22px body (a line still under the pill needs no pointer).
        // It stands just clear of the pill's LEFT edge: the faces are opaque and dock
        // flush to the axis, so a tick at the axis would hide behind its own pill and
        // tie nothing to anything. The face is measured because compact and expanded
        // widths differ (and change as a pill engages).
        const leader = leaderNodesRef.current.get(e.key);
        if (leader) {
          const d = Math.abs(rowY - e.y);
          const w = faceW.get(e.key) ?? 0;
          // No measured face means no known left edge — a tick placed by guess would
          // land back under the pill, tying nothing to anything, so draw none.
          if (d <= HALF + 2 || w <= 0) {
            leader.style.display = "none";
          } else {
            leader.style.display = "";
            leader.style.right = `${axisWidth + w + 2}px`;
            leader.style.top = `${rowY < e.y ? rowY + HALF : e.y}px`;
            leader.style.height = `${d - HALF}px`;
          }
        }
      });
    }
    // Faces are final now: let the bracket re-measure them.
    onFacesLaidOut?.();
  });
  return (
    <>
      {visible.map((v) => {
        if (v.kind === "summary") {
          const withPl = v.members.filter((m) => m.pl != null);
          const net = withPl.length ? withPl.reduce((s2, m) => s2 + (m.pl as number), 0) : null;
          // Selection no longer expands the cluster, so the aggregate itself wears
          // the selected style when it holds the selected trade's pill — the bracket
          // spine has to visibly tie to SOMETHING while the group is merged. Other
          // trades' aggregates dim like resting pills do.
          const holdsSelected = selectedTradeId != null && v.members.some((m) => m.tradeId === selectedTradeId);
          return (
            <div
              key={`cluster:${v.key}`}
              // Registered under the FIRST member's key: ChartCore's rect hit-test
              // then hovers/selects that member, which engages the cluster and
              // expands it into its individual pills.
              ref={(node) => {
                if (node) tradePillNodesRef.current.set(v.key, node);
                else tradePillNodesRef.current.delete(v.key);
              }}
              className={`trade-pill tp-cluster${holdsSelected ? " selected raised" : selectedTradeId != null ? " dimmed" : ""}`}
              style={{
                top: v.y,
                right: axisWidth,
                "--pill": "#5d6673", // mixed roles → neutral frame
                ...(net != null ? { "--pnl": net >= 0 ? "#089981" : "#f23645" } : {}),
              } as React.CSSProperties}
            >
              <span className="tp-label">{v.members.length}×</span>
              {net != null && <span className="tp-pnl">{signed(net)}</span>}
            </div>
          );
        }
        const p = v.pill;
        const prec = precisionRef.current;
        const isEntry = p.field === "price";
        const pillKey = `${p.tradeId}:${p.field}`;
        // Compact by default (axis-docked summary: side+qty and P/L only). The FULL
        // face — price, BE chip, details ⓘ and the action buttons — appears while the
        // pill is engaged: its trade selected, the pill hovered/focused, or a drag
        // staged (Apply/Discard must stay reachable without a hover).
        const expanded =
          p.tradeId === selectedTradeId || pillKey === hoveredPillKey || pillKey === focusedPillKey || p.changed;
        const pendKey = p.field === "tp" ? "takeProfit" : p.field; // pendingEdits key
        const sign = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}`;
        // A hairline chip with a hierarchy inside the line (see App.css): a small uppercase
        // role tag (the side word + qty on the entry — "Long 100" / "Sell limit 100" — or
        // SL/TP for the exits), then the price as the hero in tabular mono, then the signed
        // P/L. --pill is the role colour: it tints the border and the tag only. Colour carries
        // ONE meaning — profit/loss: SL red, TP green; the position (entry/order) is de-hued to
        // a neutral slate, since its direction is already in the tag word and its sign in the P/L.
        const roleColor =
          p.field === "stop" ? "#f23645"
          : p.field === "tp" ? "#089981"
          : "#5d6673"; // entry / resting order → neutral
        // The P/L NUMBER is coloured independently of the frame — green in profit, red at
        // a loss — so a short (red frame) in profit still shows a green figure.
        const pnlColor = p.pl == null ? null : p.pl >= 0 ? "#089981" : "#f23645";
        // Eyebrow tag: the side word on the entry (Long / Short / Sell limit…), SL/TP on
        // the exits. Quantity rides alongside the entry tag; the price is the hero readout.
        const labelText = isEntry ? tradeLabel(p.kind, p.side) : p.field === "stop" ? "SL" : "TP";
        // A resting order's entry pill shows WHEN it expires in place of the price — the
        // price already reads off the line it's anchored to. A dated order gets a clock +
        // short time; an open-ended one gets a plain "GTC" status word (no deadline to
        // point a clock at). Positions and the SL/TP pills keep their level readout.
        const isOrderEntry = isEntry && p.kind === "order";
        const priceText = p.level.toFixed(prec);
        const expiryText = p.expiresAt != null ? fmtExpiry(p.expiresAt, false) : "";
        const bodyPnl = isEntry && p.pl != null ? sign(p.pl) : null;
        // Remove this SL/TP line: commit the level cleared right away (an explicit
        // action, like delete), then focus the entry pill since this line is gone.
        const removeLevel = async () => {
          const t = tradesRef.current.find((x) => x.id === p.tradeId);
          if (!t) return;
          const merged = mergeTradeLevels(t, pendingRef.current[t.id] ?? {});
          if (p.field === "stop") merged.stop = null;
          else merged.takeProfit = null;
          try {
            await act.apply(t, merged);
            discardPendingEdit(t.id);
            setTradeSelected(t.id, "price", opensTicket());
          } catch (err) {
            toast(err instanceof Error ? err.message : "Remove failed");
          }
        };
        return (
          <Fragment key={`${p.tradeId}:${p.field}`}>
          {/* Leader tick: a hairline from a displaced pill back to its true line y.
              Hidden/positioned by the layout pass; dims with its pill. */}
          <div
            className={`tp-leader${selectedTradeId != null && p.tradeId !== selectedTradeId ? " dimmed" : ""}`}
            style={{ display: "none" }}
            ref={(node) => {
              const key = `${p.tradeId}:${p.field}`;
              if (node) leaderNodesRef.current.set(key, node);
              else leaderNodesRef.current.delete(key);
            }}
          />
          <div
            ref={(node) => {
              const key = `${p.tradeId}:${p.field}`;
              if (node) tradePillNodesRef.current.set(key, node);
              else tradePillNodesRef.current.delete(key);
            }}
            className={`trade-pill tp-line-${p.field}${expanded ? "" : " compact"}${p.tradeId === selectedTradeId ? " selected" : ""}${selectedTradeId != null && p.tradeId !== selectedTradeId ? " dimmed" : ""}${p.tradeId === focusedTradeId || p.tradeId === hoveredTradeId ? " raised" : ""}${`${p.tradeId}:${p.field}` === hoveredPillKey ? " hovering" : ""}${`${p.tradeId}:${p.field}` === focusedPillKey ? " focused" : ""}`}
            style={{
              top: p.y,
              right: axisWidth,
              "--pill": roleColor,
              // Entry P/L number is coloured by sign; SL/TP body falls back to the frame.
              ...(isEntry && pnlColor ? { "--pnl": pnlColor } : {}),
            } as React.CSSProperties}
          >
            {!expanded ? (
              /* Compact face: the price is readable off the axis right beside the
                 pill, so only the role and the money show — "L5 +39.30" on an entry,
                 "SL −12.40" on an exit, the expiry/GTC on a resting order. */
              <>
                <span className="tp-label">{isEntry ? `${p.side === "buy" ? "L" : "S"}${p.qty}` : labelText}</span>
                {isOrderEntry ? (
                  p.expiresAt != null ? (
                    <span className="tp-expiry">{expiryText}</span>
                  ) : (
                    <span className="tp-gtc">GTC</span>
                  )
                ) : isEntry ? (
                  bodyPnl != null && <span className="tp-pnl">{bodyPnl}</span>
                ) : p.pct != null ? (
                  /* Percent move from entry: the compact face answers "how far is this
                     level" — the money-if-hit stays on the expanded face. */
                  <span className="tp-plhint">{sign(p.pct)}%</span>
                ) : (
                  p.pl != null && <span className="tp-plhint">{sign(p.pl)}</span>
                )}
              </>
            ) : (
              <>
            <span className="tp-label">{labelText}</span>
            {isEntry && <span className="tp-qty">{p.qty}</span>}
            {isOrderEntry ? (
              p.expiresAt != null ? (
                <Tooltip asChild content={`Order expires ${fmtExpiry(p.expiresAt, true)}`}>
                  <span className="tp-expiry">
                    <svg className="tp-exp-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="9" />
                      <polyline points="12 7 12 12 15 14" />
                    </svg>
                    {expiryText}
                  </span>
                </Tooltip>
              ) : (
                <Tooltip asChild content="Good till cancelled">
                  <span className="tp-gtc">GTC</span>
                </Tooltip>
              )
            ) : (
              <span className="tp-price">
                {isEntry && <span className="tp-at">@</span>}{priceText}
              </span>
            )}
            {p.breakevenField && (
              <Tooltip asChild content={p.breakevenField === "stop" ? "Stop at breakeven" : "Target at breakeven"}>
                <span className="tp-be">BE</span>
              </Tooltip>
            )}
            {bodyPnl != null && (
              <Tooltip asChild content="Unrealised P&L">
                <span className="tp-pnl">{bodyPnl}</span>
              </Tooltip>
            )}
            {!isEntry && p.pl != null && (
              <Tooltip asChild content="P&L if this level is hit">
                <span className="tp-plhint">{sign(p.pl)}</span>
              </Tooltip>
            )}
            {p.changed && (
              <>
                <Tooltip content="Apply changes">
                <button
                  className="tp-btn tp-apply"
                  onClick={async () => {
                    const t = tradesRef.current.find((x) => x.id === p.tradeId);
                    if (!t) return;
                    const merged = mergeTradeLevels(t, pendingRef.current[t.id] ?? {});
                    try {
                      await act.apply(t, merged);
                      discardPendingEdit(t.id); // committed → clear the staged copy
                    } catch (err) {
                      toast(err instanceof Error ? err.message : "Apply failed");
                    }
                  }}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </button>
                </Tooltip>
                <Tooltip content="Discard changes">
                <button
                  className="tp-btn tp-discard"
                  onClick={() => {
                    discardPendingField(p.tradeId, pendKey);
                    // Entry pendKey is "price"; at breakeven the merged SL/TP also rides
                    // this pill (its own pill is suppressed), so discard it too or it strands.
                    if (p.breakevenField) discardPendingField(p.tradeId, p.breakevenField);
                  }}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
                </Tooltip>
              </>
            )}
            {/* Close (entry) / remove (SL·TP) only when the line ISN'T mid-edit — while
                a drag is staged the pill shows just Apply (✓) / Discard (✕). */}
            {!p.changed && (isEntry ? (
              <Tooltip content={p.kind === "order" ? "Cancel order" : "Close position"}>
              <button
                className="tp-btn tp-close"
                onClick={() => {
                  const t = tradesRef.current.find((x) => x.id === p.tradeId);
                  if (!t) return;
                  const isOrder = t.kind === "order";
                  const f = (n: number) => n.toFixed(prec);
                  const details: NonNullable<Parameters<typeof requestConfirm>[0]["details"]> = [
                    { label: "Symbol", value: t.epic },
                    { label: "Side", value: tradeLabel(t.kind, t.side) },
                    { label: "Quantity", value: String(t.quantity) },
                    { label: isOrder ? "Limit" : "Avg fill", value: f(t.priceLevel) },
                  ];
                  if (t.takeProfit != null) details.push({ label: "Take profit", value: f(t.takeProfit) });
                  if (t.stop != null) details.push({ label: "Stop loss", value: f(t.stop) });
                  if (!isOrder && t.upnl != null) {
                    details.push({
                      label: "Realized P&L",
                      value: sign(t.upnl),
                      tone: t.upnl >= 0 ? "pos" : "neg",
                    });
                  }
                  requestConfirm({
                    title: isOrder ? "Cancel order" : "Close position",
                    message: isOrder
                      ? `Cancel this ${tradeLabel(t.kind, t.side)} order on ${t.epic}?`
                      : `Close this ${tradeLabel(t.kind, t.side)} position on ${t.epic} at market?`,
                    confirmLabel: isOrder ? "Cancel order" : "Close position",
                    details,
                    onConfirm: async () => {
                      try {
                        if (isOrder) await act.cancel(t);
                        else await act.close(t);
                        setTradeSelected(null);
                      } catch (err) {
                        toast(err instanceof Error ? err.message : "Action failed");
                      }
                    },
                  });
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
              </Tooltip>
            ) : (
              <Tooltip content={p.field === "stop" ? "Remove stop loss" : "Remove take profit"}>
              <button
                className="tp-btn tp-remove"
                onClick={removeLevel}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
              </Tooltip>
            ))}
              </>
            )}
          </div>
          </Fragment>
        );
      })}
    </>
  );
}
