import { useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import { createPortal } from "react-dom";
import { formatExpiryLong, formatExpiryShort } from "../lib/alertUi";
import { toast } from "../lib/notify";
import { requestConfirm, setTradeSelected, discardPendingEdit, discardPendingField, type PendingEdit, type TradeLineField } from "../lib/signals";
import { tradeLabel, mergeTradeLevels, applyEditedLevels, closePosition, cancelWorkingOrder, refreshTrades, getTradesAccount, type TradeView, type OrderSide } from "../lib/trading";
import { computePlacement, type Placed } from "../components/tooltipPosition";

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
  hoveredPillRectKey: string | null;
  focusedPillKey: string | null;
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

/**
 * Full-details popover for the pill under the cursor. Anchored to the pill's DOM node
 * and placed with the shared `computePlacement`; styled with the shared `.tooltip`
 * classes so it reads as one system with every other tooltip. It's `pointer-events:
 * none` (inherited from `.tooltip`) so it never blocks a line grab beneath it. Keyed by
 * the hovered pill in the parent, so switching pills remounts it and re-runs the
 * measure-then-reveal that keeps the enter animation crisp.
 */
function PillDetailsPopover({ anchor, trade, prec }: { anchor: HTMLElement; trade: TradeView; prec: number }) {
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<Placed | null>(null);
  const [shown, setShown] = useState(false);

  useLayoutEffect(() => {
    const b = bubbleRef.current;
    if (!b) return;
    const tr = anchor.getBoundingClientRect();
    setPlaced(
      computePlacement(
        { left: tr.left, top: tr.top, width: tr.width, height: tr.height },
        { width: b.offsetWidth, height: b.offsetHeight },
        "top",
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, [anchor, trade]);

  const rows = tradeDetailRows(trade, prec);
  return createPortal(
    <div
      ref={bubbleRef}
      role="tooltip"
      className={`tooltip pill-tip${shown ? " show" : ""}`}
      data-side={placed?.side ?? "top"}
      style={{ left: placed?.left ?? 0, top: placed?.top ?? 0 }}
    >
      <div className="tooltip-title">{tradeLabel(trade.kind, trade.side)} · {trade.epic}</div>
      <dl className="pill-tip-grid">
        {rows.map((r) => (
          <div className="pill-tip-row" key={r.label}>
            <dt>{r.label}</dt>
            <dd className={r.tone ? `pill-tip-${r.tone}` : undefined}>{r.value}</dd>
          </div>
        ))}
      </dl>
    </div>,
    document.body,
  );
}

/**
 * The ACTIVE line's pill (entry / SL / TP — only one shows). It carries the
 * symbol + level; the entry pill adds uPnL + close, the SL/TP pills add the P/L
 * that level would realise if hit + remove. ANY pill shows Apply/Discard when
 * ITS OWN line has a staged drag. Anchored at the line's y, frozen x.
 * Pure props-in — all mutable trade state stays in ChartCore via refs.
 */
export default function TradePills({
  pills,
  precisionRef,
  tradesRef,
  pendingRef,
  tradePillNodesRef,
  hoveredPillKey,
  hoveredPillRectKey,
  focusedPillKey,
  tradePillLeft,
}: TradePillsProps) {
  // Details popover opens only when the cursor is over the pill's rect (hoveredPillRectKey),
  // not on a bare line-hover. Suppressed while that pill has a staged drag (it's showing
  // Apply/Discard then — a details card on top would be noise).
  const hoveredPill = hoveredPillRectKey ? pills.find((p) => `${p.tradeId}:${p.field}` === hoveredPillRectKey) : null;
  const anchorNode = hoveredPillRectKey ? tradePillNodesRef.current.get(hoveredPillRectKey) ?? null : null;
  const hoveredTrade = hoveredPill ? tradesRef.current.find((t) => t.id === hoveredPill.tradeId) ?? null : null;
  const showDetails = hoveredPill != null && !hoveredPill.changed;
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
          <div
            key={`${p.tradeId}:${p.field}`}
            ref={(node) => {
              const key = `${p.tradeId}:${p.field}`;
              if (node) tradePillNodesRef.current.set(key, node);
              else tradePillNodesRef.current.delete(key);
            }}
            className={`trade-pill tp-line-${p.field}${`${p.tradeId}:${p.field}` === hoveredPillKey ? " hovering" : ""}${`${p.tradeId}:${p.field}` === focusedPillKey ? " focused" : ""}`}
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
            {p.changed && (
              <>
                <button
                  className="tp-btn tp-apply"
                  title="Apply changes"
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
                <button
                  className="tp-btn tp-discard"
                  title="Discard changes"
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
              </>
            )}
            {/* Close (entry) / remove (SL·TP) only when the line ISN'T mid-edit — while
                a drag is staged the pill shows just Apply (✓) / Discard (✕). */}
            {!p.changed && (isEntry ? (
              <button
                className="tp-btn tp-close"
                title={p.kind === "order" ? "Cancel order" : "Close position"}
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
            ) : (
              <button
                className="tp-btn tp-remove"
                title={p.field === "stop" ? "Remove stop loss" : "Remove take profit"}
                onClick={removeLevel}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            ))}
          </div>
        );
      })}
      {showDetails && anchorNode && hoveredTrade && (
        <PillDetailsPopover
          key={hoveredPillRectKey}
          anchor={anchorNode}
          trade={hoveredTrade}
          prec={precisionRef.current}
        />
      )}
    </>
  );
}
