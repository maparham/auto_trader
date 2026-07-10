import type { MutableRefObject } from "react";
import { toast } from "../lib/notify";
import { requestConfirm, setTradeSelected, discardPendingEdit, discardPendingField, type PendingEdit, type TradeLineField } from "../lib/signals";
import { tradeLabel, mergeTradeLevels, applyEditedLevels, closePosition, cancelWorkingOrder, refreshTrades, getTradesAccount, type TradeView, type OrderSide } from "../lib/trading";

export interface TradePillItem {
  tradeId: string;
  field: TradeLineField;
  y: number;
  kind: "position" | "order";
  side: OrderSide;
  qty: number;
  level: number;
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
  tradePillLeft: number;
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
  focusedPillKey,
  tradePillLeft,
}: TradePillsProps) {
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
        const priceText = p.level.toFixed(prec);
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
            <span className="tp-price">
              {isEntry && <span className="tp-at">@</span>}{priceText}
            </span>
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
    </>
  );
}
