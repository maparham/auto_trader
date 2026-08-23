// The trade-review tour card: a floating, draggable panel for stepping through
// one cohort of the active backtest's trades (losses by default) and studying
// each in context — the goal is conjecture ("why did these fail? what did the
// winners share?"), so alongside outcome/prices it surfaces the strategy's OWN
// view of the entry: the rule terms that fired (marker `terms`) and the
// recorded per-trade `context`. Rendered once at App level, driven by
// tradeReviewSignal; each step publishes selectedTradeSignal, which the owning
// chart already answers with the sticky risk/reward zone + pan/zoom. With the
// drill toggle on, a step first asks the chart to switch to the run's native
// timeframe (backtestDrillRequestSignal). ←/→ step, Esc exits.

import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  backtestDrillRequestSignal,
  backtestResultSignal,
  selectedTradeSignal,
  tradeReviewSignal,
  type TradeReviewState,
} from "./lib/signals";
import { entryMarkerFor, fmtTradeDuration, realizedR, reviewOrder, type ReviewCohort } from "./lib/tradeReview";
import { termLabel, opSymbol } from "./lib/signalGlyphs";
import Tooltip from "./components/Tooltip";
import { useBarTimeLabel } from "./lib/useMaskedReplay";
import { periodByResolution } from "./lib/feed";

const subscribeReview = (cb: () => void) => tradeReviewSignal.subscribe(cb);
const subscribeResult = (cb: () => void) => backtestResultSignal.subscribe(cb);

const fmtNum = (n: number | null): string =>
  n == null ? "—" : Number.isInteger(n) ? String(n) : String(Number(n.toFixed(5)));
const fmtPnl = (n: number): string => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}`;
const fmtR = (r: number | null): string => (r == null ? "" : ` (${r >= 0 ? "+" : "−"}${Math.abs(r).toFixed(2)}R)`);

// Plain-language help for every row of the card. The entry-context keys are the
// backend's own field names (context_features.py), so they get their own tips:
// nobody reads "dist_swing_high" and knows it is measured in ATRs.
const ROW_TIPS: Record<string, string> = {
  Entry: "When the trade was filled, and at what price.",
  Exit: "When the trade closed, and at what price.",
  Reason: "What closed the trade: the stop, the target, an exit rule, or the session ending.",
  Held: "Time from entry to exit.",
  "MAE / MFE": "Worst and best the trade ever got, in R. MAE is how far it went against you before closing, MFE how far it went your way.",
};

const CONTEXT_TIPS: Record<string, string> = {
  trend: "Direction of the 50-bar average at entry: up, down, or flat.",
  vol_regime: "How volatile the market was at entry, against the rest of the run: low, mid, or high third.",
  session: "Trading session at entry: Asia, London, New York, or the London and New York overlap.",
  hour_utc: "Hour of the entry bar, in UTC (0 to 23).",
  day_of_week: "Weekday of the entry: 0 is Monday, 4 is Friday.",
  dist_swing_high: "Distance from entry up to the recent 20-bar high, in ATRs. Small means the trade started right under resistance.",
  dist_swing_low: "Distance from entry down to the recent 20-bar low, in ATRs. Small means the trade started right above support.",
  candle_pattern: "Shape of the signal candle, such as a pin bar or an engulfing candle.",
};

// A row label with its tip, or the bare label when no tip is written for it.
function RowLabel({ name, tips }: { name: string; tips: Record<string, string> }) {
  const tip = tips[name];
  if (!tip) return <span>{name}</span>;
  return (
    <Tooltip content={tip} title={name}>
      {name}
    </Tooltip>
  );
}

const COHORTS: Array<{ key: ReviewCohort; label: string }> = [
  { key: "losses", label: "Losses" },
  { key: "wins", label: "Wins" },
  { key: "all", label: "All" },
];

// Steps: publish the new position, optionally drill the chart to the run's
// native timeframe around the trade, then select (zone + scroll). Module-level
// (not component) so the keyboard handler and buttons share one code path.
function goTo(review: TradeReviewState, pos: number) {
  const result = backtestResultSignal.value;
  if (!result) return;
  const idx = review.order[pos];
  const t = result.trades[idx];
  if (!t) return;
  tradeReviewSignal.set({ ...review, pos });
  if (review.drill) {
    backtestDrillRequestSignal.set({
      resolution: result.resolution,
      fromMs: t.entry_time * 1000,
      toMs: (t.exit_time_exact ?? t.exit_time) * 1000,
    });
  }
  selectedTradeSignal.set(idx);
}

export default function TradeReviewCard() {
  const review = useSyncExternalStore(subscribeReview, () => tradeReviewSignal.value);
  const result = useSyncExternalStore(subscribeResult, () => backtestResultSignal.value);
  const barTime = useBarTimeLabel();
  // Dragging: null = default anchor (top-right); set on first header drag.
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const dragFrom = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  // The result the active tour belongs to, captured while the tour runs.
  const tourResultRef = useRef<typeof result>(null);
  useEffect(() => {
    tourResultRef.current = review ? backtestResultSignal.value : null;
  }, [review]);

  // A result swap (re-run, panel switching shown result, clear) invalidates the
  // tour's trade indices — exit rather than review the wrong run's trades.
  // Identity-compared: rehydrates (e.g. a drill-in's timeframe switch) re-fire
  // the signal with the SAME object, and that must not end the tour.
  useEffect(
    () =>
      backtestResultSignal.subscribe((v) => {
        if (tradeReviewSignal.value !== null && v !== tourResultRef.current) {
          tradeReviewSignal.set(null);
        }
      }),
    [],
  );

  // Keyboard while the tour is active: ←/→ step, Esc exits. Skipped when the
  // focus is in an editable control (the user is typing, not touring).
  useEffect(() => {
    if (!review) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable))
        return;
      if (e.key === "Escape") {
        tradeReviewSignal.set(null);
      } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const cur = tradeReviewSignal.value;
        if (!cur) return;
        const next = Math.min(Math.max(cur.pos + (e.key === "ArrowRight" ? 1 : -1), 0), cur.order.length - 1);
        if (next !== cur.pos) goTo(cur, next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [review]);

  if (!review || !result) return null;

  const { order, pos, cohort } = review;
  const idx = order[pos];
  const trade = idx != null ? result.trades[idx] : undefined;

  const pickCohort = (c: ReviewCohort) => {
    const nextOrder = reviewOrder(result.trades, c);
    // Built fresh (not spread) so a custom cohort's `label` is dropped.
    const next: TradeReviewState = { cohort: c, order: nextOrder, pos: 0, drill: review.drill };
    if (nextOrder.length > 0) goTo(next, 0);
    else {
      tradeReviewSignal.set(next);
      selectedTradeSignal.set(null);
    }
  };

  const onHeaderPointerDown = (e: React.PointerEvent) => {
    const cur = drag ?? { x: window.innerWidth - 336, y: 88 };
    dragFrom.current = { px: e.clientX, py: e.clientY, x: cur.x, y: cur.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onHeaderPointerMove = (e: React.PointerEvent) => {
    const f = dragFrom.current;
    if (!f) return;
    setDrag({ x: f.x + e.clientX - f.px, y: f.y + e.clientY - f.py });
  };
  const onHeaderPointerUp = () => {
    dragFrom.current = null;
  };

  const style: React.CSSProperties = drag
    ? { left: drag.x, top: drag.y, right: "auto" }
    : { right: 16, top: 88 };

  const outcome = trade ? (trade.pnl > 0 ? "Win" : trade.pnl < 0 ? "Loss" : "BE") : "";
  const r = trade ? realizedR(trade) : null;
  const marker = trade ? entryMarkerFor(trade, result.markers ?? []) : null;
  const terms = marker?.terms ?? [];
  const context = trade?.context ?? null;

  return createPortal(
    <div className="bt-review-card" style={style} role="dialog" aria-label="Trade review">
      <div
        className="bt-review-head"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
      >
        <span className="bt-review-title">Review</span>
        <div className="seg" role="tablist" aria-label="Review cohort">
          {review.label != null && (
            <button role="tab" aria-selected className="seg-on bt-review-custom">
              {review.label}
            </button>
          )}
          {COHORTS.map((c) => (
            <button
              key={c.key}
              role="tab"
              aria-selected={review.label == null && cohort === c.key}
              className={review.label == null && cohort === c.key ? "seg-on" : ""}
              onClick={() => pickCohort(c.key)}
            >
              {c.label}
            </button>
          ))}
        </div>
        <button className="bt-review-close" aria-label="Close review" onClick={() => tradeReviewSignal.set(null)}>
          ✕
        </button>
      </div>

      {trade == null ? (
        <div className="bt-review-empty">No {cohort === "all" ? "" : cohort} trades in this run.</div>
      ) : (
        <>
          <div className="bt-review-nav">
            <button aria-label="Previous trade" disabled={pos <= 0} onClick={() => goTo(review, pos - 1)}>
              ‹
            </button>
            <span className={`bt-review-outcome ${trade.pnl > 0 ? "pos" : trade.pnl < 0 ? "neg" : ""}`}>
              {outcome} {pos + 1}/{order.length} · {trade.leg === "long" ? "Long" : "Short"} · {fmtPnl(trade.pnl)}
              {fmtR(r)}
            </span>
            <button
              aria-label="Next trade"
              disabled={pos >= order.length - 1}
              onClick={() => goTo(review, pos + 1)}
            >
              ›
            </button>
          </div>

          <div className="bt-review-grid">
            <RowLabel name="Entry" tips={ROW_TIPS} />
            <span>
              {barTime(trade.entry_time * 1000)} @ {fmtNum(trade.entry_price)}
            </span>
            <RowLabel name="Exit" tips={ROW_TIPS} />
            <span>
              {barTime((trade.exit_time_exact ?? trade.exit_time) * 1000)} @ {fmtNum(trade.exit_price)}
            </span>
            <RowLabel name="Reason" tips={ROW_TIPS} />
            <span>{trade.reason}</span>
            <RowLabel name="Held" tips={ROW_TIPS} />
            <span>{fmtTradeDuration(trade.entry_time, trade.exit_time_exact ?? trade.exit_time)}</span>
            {(trade.mae_r != null || trade.mfe_r != null) && (
              <>
                <RowLabel name="MAE / MFE" tips={ROW_TIPS} />
                <span>
                  {trade.mae_r != null ? `−${Math.abs(trade.mae_r).toFixed(2)}R` : "—"} /{" "}
                  {trade.mfe_r != null ? `+${Math.abs(trade.mfe_r).toFixed(2)}R` : "—"}
                </span>
              </>
            )}
          </div>

          {terms.length > 0 && (
            <div className="bt-review-section">
              <Tooltip
                content="The strategy's own entry conditions, with the values they had on the signal bar."
                title="Entry rules"
              >
                <div className="bt-review-section-title">Entry rules</div>
              </Tooltip>
              <table className="bt-cluster-pop-table">
                <tbody>
                  {terms.map((t, i) =>
                    t.op === "" ? (
                      <tr key={i}>
                        <td className="bt-signal-pop-op">{termLabel(t.left, t.leftTf)}</td>
                        <td className="bt-cluster-pop-num">{fmtNum(t.lval)}</td>
                      </tr>
                    ) : (
                      <tr key={i}>
                        <td className="bt-signal-pop-op">{termLabel(t.left, t.leftTf)}</td>
                        <td className="bt-cluster-pop-num">{fmtNum(t.lval)}</td>
                        <td className="bt-signal-pop-cmp">{opSymbol(t.op)}</td>
                        <td className="bt-signal-pop-op">{termLabel(t.right, t.rightTf)}</td>
                        <td className="bt-cluster-pop-num">{fmtNum(t.rval)}</td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
          )}

          {context && Object.keys(context).length > 0 && (
            <div className="bt-review-section">
              <Tooltip
                content="What the market looked like on the signal bar. Compare these across losses to spot what they share."
                title="Entry context"
              >
                <div className="bt-review-section-title">Entry context</div>
              </Tooltip>
              <div className="bt-review-grid">
                {Object.entries(context).map(([k, v]) => (
                  <React.Fragment key={k}>
                    <RowLabel name={k} tips={CONTEXT_TIPS} />
                    <span>{v == null ? "—" : typeof v === "number" ? fmtNum(v) : String(v)}</span>
                  </React.Fragment>
                ))}
              </div>
            </div>
          )}

          <label className="bt-review-drill">
            <input
              type="checkbox"
              checked={review.drill}
              onChange={(e) => {
                const drillOn = e.target.checked;
                tradeReviewSignal.set({ ...review, drill: drillOn });
                if (drillOn && trade) {
                  backtestDrillRequestSignal.set({
                    resolution: result.resolution,
                    fromMs: trade.entry_time * 1000,
                    toMs: (trade.exit_time_exact ?? trade.exit_time) * 1000,
                  });
                }
              }}
            />
            <Tooltip content="Each step switches the chart to the run's own timeframe and zooms to that trade. Off, the chart stays where you are.">
              <span>
                Drill to {periodByResolution(result.resolution)?.label ?? result.resolution} on step
              </span>
            </Tooltip>
          </label>
        </>
      )}
    </div>,
    document.body,
  );
}
