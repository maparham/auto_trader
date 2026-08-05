import { Fragment, useLayoutEffect, useRef, type MutableRefObject } from "react";
import { formatExpiryLong, formatExpiryShort } from "../lib/alertUi";
import { toast } from "../lib/notify";
import { requestConfirm, setTradeSelected, discardPendingEdit, discardPendingField, type PendingEdit, type TradeLineField } from "../lib/signals";
import { tradeLabel, mergeTradeLevels, applyEditedLevels, closePosition, cancelWorkingOrder, refreshTrades, getTradesAccount, type TradeView, type OrderSide } from "../lib/trading";
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
  changed: boolean; // this line has an un-applied drag → show Apply/Discard
  // entry pill only: which level merged into the entry at breakeven (SL or TP sits
  // at entry) → show a "BE" chip; the field says which pending edit Discard clears.
  breakevenField?: "stop" | "takeProfit";
}

interface TradePillsProps {
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
  tradePillLeft: number;
}

const cash = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
const signed = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}`;
const fmtDateTime = (ms: number) => new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

interface DetailRow {
  label: string;
  value: string;
  tone?: "pos" | "neg";
}

// Every detail of the position / order behind a pill, in the reading order the dock
// uses. Conditioned by kind: uPnL is a position's alone, the expiry an order's; the
// price the order pill dropped from its face resurfaces here in full.
function tradeDetailRows(t: TradeView, prec: number): DetailRow[] {
  const px = (n: number) => n.toFixed(prec);
  const rows: DetailRow[] = [];
  rows.push({ label: "Quantity", value: String(t.quantity) });
  rows.push({ label: t.kind === "order" ? "Limit" : "Avg fill", value: px(t.priceLevel) });
  if (t.stop != null) rows.push({ label: "Stop loss", value: px(t.stop) });
  if (t.takeProfit != null) rows.push({ label: "Take profit", value: px(t.takeProfit) });
  if (t.kind === "position" && t.upnl != null)
    rows.push({ label: "Unrealised P/L", value: signed(t.upnl), tone: t.upnl >= 0 ? "pos" : "neg" });
  if (t.leverage != null) rows.push({ label: "Leverage", value: `${t.leverage}:1` });
  if (t.margin != null) rows.push({ label: "Margin", value: cash(t.margin) });
  if (t.openedAt != null)
    rows.push({ label: t.kind === "order" ? "Placed" : "Opened", value: fmtDateTime(t.openedAt) });
  if (t.kind === "order")
    rows.push({ label: "Expires", value: t.expiresAt != null ? fmtDateTime(t.expiresAt) : "GTC" });
  if (t.source === "strategy") rows.push({ label: "Source", value: "Strategy" });
  return rows;
}

// The details grid the pill's ⓘ tooltip shows — the same shared-tooltip idiom as
// every other ⓘ in the app, so the card only appears when the icon is hovered
// instead of ambushing the whole pill.
function detailsContent(trade: TradeView, prec: number) {
  return (
    <dl className="pill-tip-grid">
      {tradeDetailRows(trade, prec).map((r) => (
        <div className="pill-tip-row" key={r.label}>
          <dt>{r.label}</dt>
          <dd className={r.tone ? `pill-tip-${r.tone}` : undefined}>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
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
  pills,
  precisionRef,
  tradesRef,
  pendingRef,
  tradePillNodesRef,
  hoveredPillKey,
  focusedPillKey,
  selectedTradeId,
  tradePillLeft,
}: TradePillsProps) {
  // The trades whose WHOLE pill group rises above resting pills: the focused trade
  // (selection wins in focusedPillKey upstream) and the hovered pill's trade — so
  // hovering an SL/TP raises its entry sibling too. Keys are "tradeId:field"; the
  // trade id may itself contain colons, so split on the LAST one.
  const tradeIdOf = (key: string | null) => (key ? key.slice(0, key.lastIndexOf(":")) : null);
  const focusedTradeId = tradeIdOf(focusedPillKey);
  const hoveredTradeId = tradeIdOf(hoveredPillKey);
  // Leader-tick nodes keyed like the pills; geometry is written by the layout pass.
  const leaderNodesRef = useRef(new Map<string, HTMLDivElement>());
  // Overlap declutter — vertical spread: pills whose 22px bodies collide vertically form
  // a cluster and spread into a one-per-row column (24px pitch) centred on the cluster's
  // mean y, all at the shared anchor x. No horizontal run, every pill fully readable.
  // Each displaced pill gets a thin leader tick just left of its edge tying it back to
  // its true line y. Written to the DOM after every render (React re-renders reset
  // `top`, then this pass reapplies); a sweep over the y-sorted pills chains clusters
  // transitively: each pill within a pill-height of the previous one joins the cluster.
  useLayoutEffect(() => {
    const PILL_H = 22; // .trade-pill height (App.css)
    const HALF = PILL_H / 2;
    const ROW = 24; // vertical pitch inside a spread column
    type Entry = { key: string; y: number };
    const sorted: Entry[] = pills
      .map((p) => ({ key: `${p.tradeId}:${p.field}`, y: p.y }))
      .sort((a, b) => a.y - b.y);
    const clusters: Entry[][] = [];
    let cluster: Entry[] = [];
    for (const e of sorted) {
      if (cluster.length && e.y - cluster[cluster.length - 1].y >= PILL_H) {
        clusters.push(cluster);
        cluster = [];
      }
      cluster.push(e);
    }
    if (cluster.length) clusters.push(cluster);
    // Keep the column on the pane: clamp its top edge, and its bottom edge when the
    // clip container's height is known (jsdom has no layout — offsetParent is null).
    const paneH = sorted.length
      ? tradePillNodesRef.current.get(sorted[0].key)?.offsetParent?.clientHeight ?? 0
      : 0;
    const startOf = (c: Entry[]) => {
      if (c.length === 1) return c[0].y;
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
    for (const c of clusters) {
      const start = startOf(c);
      c.forEach((e, i) => {
        const rowY = c.length === 1 ? e.y : start + i * ROW;
        const node = tradePillNodesRef.current.get(e.key);
        if (node) node.style.top = `${rowY}px`;
        // Leader tick: pill edge → true line y, shown only when the line falls OUTSIDE
        // the pill's own 22px body (a line still under the pill needs no pointer).
        const leader = leaderNodesRef.current.get(e.key);
        if (leader) {
          const d = Math.abs(rowY - e.y);
          if (d <= HALF + 2) {
            leader.style.display = "none";
          } else {
            leader.style.display = "";
            leader.style.left = `${tradePillLeft - 5}px`;
            leader.style.top = `${rowY < e.y ? rowY + HALF : e.y}px`;
            leader.style.height = `${d - HALF}px`;
          }
        }
      });
    }
  });
  return (
    <>
      {pills.map((p) => {
        const prec = precisionRef.current;
        const isEntry = p.field === "price";
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
        const expiryText = p.expiresAt != null ? formatExpiryShort(p.expiresAt) : "";
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
            await applyEditedLevels(t, merged, getTradesAccount());
            discardPendingEdit(t.id);
            refreshTrades();
            setTradeSelected(t.id, "price");
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
            className={`trade-pill tp-line-${p.field}${p.tradeId === selectedTradeId ? " selected" : ""}${selectedTradeId != null && p.tradeId !== selectedTradeId ? " dimmed" : ""}${p.tradeId === focusedTradeId || p.tradeId === hoveredTradeId ? " raised" : ""}${`${p.tradeId}:${p.field}` === hoveredPillKey ? " hovering" : ""}${`${p.tradeId}:${p.field}` === focusedPillKey ? " focused" : ""}`}
            style={{
              top: p.y,
              left: tradePillLeft,
              "--pill": roleColor,
              // Entry P/L number is coloured by sign; SL/TP body falls back to the frame.
              ...(isEntry && pnlColor ? { "--pnl": pnlColor } : {}),
            } as React.CSSProperties}
          >
            <span className="tp-label">{labelText}</span>
            {isEntry && <span className="tp-qty">{p.qty}</span>}
            {isOrderEntry ? (
              p.expiresAt != null ? (
                <span className="tp-expiry" title={`Order expires ${formatExpiryLong(p.expiresAt)}`}>
                  <svg className="tp-exp-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="9" />
                    <polyline points="12 7 12 12 15 14" />
                  </svg>
                  {expiryText}
                </span>
              ) : (
                <span className="tp-gtc" title="Good till cancelled">GTC</span>
              )
            ) : (
              <span className="tp-price">
                {isEntry && <span className="tp-at">@</span>}{priceText}
              </span>
            )}
            {p.breakevenField && (
              <span
                className="tp-be"
                title={p.breakevenField === "stop" ? "Stop at breakeven" : "Target at breakeven"}
              >
                BE
              </span>
            )}
            {bodyPnl != null && (
              <span className="tp-pnl" title="Unrealised P&L">{bodyPnl}</span>
            )}
            {!isEntry && p.pl != null && (
              <span className="tp-plhint" title="P&L if this level is hit">{sign(p.pl)}</span>
            )}
            {/* ⓘ — the full details card, shown only while the icon itself is hovered
                (the shared-tooltip idiom) instead of ambushing the whole pill. */}
            {(() => {
              const t = tradesRef.current.find((x) => x.id === p.tradeId);
              return t ? (
                <Tooltip title={`${tradeLabel(t.kind, t.side)} · ${t.epic}`} content={detailsContent(t, prec)}>
                  <button
                    type="button"
                    className="tp-btn tp-info"
                    aria-label="Trade details"
                    // The rest of the pill selects on click (canvas hit-test); the ⓘ is
                    // its own DOM target, so mirror that instead of swallowing the click.
                    onClick={() => setTradeSelected(p.tradeId, p.field)}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="9" />
                      <line x1="12" y1="11" x2="12" y2="16" />
                      <line x1="12" y1="7.5" x2="12.01" y2="7.5" />
                    </svg>
                  </button>
                </Tooltip>
              ) : null;
            })()}
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
                      await applyEditedLevels(t, merged, getTradesAccount());
                      discardPendingEdit(t.id); // committed → clear the staged copy
                      refreshTrades();
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
                        if (isOrder) await cancelWorkingOrder(t.id, getTradesAccount());
                        else await closePosition(t.id, getTradesAccount());
                        setTradeSelected(null);
                        refreshTrades();
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
          </div>
          </Fragment>
        );
      })}
    </>
  );
}
