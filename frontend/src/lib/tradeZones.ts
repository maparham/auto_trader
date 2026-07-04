// Pure risk/reward geometry for a single backtest trade — feeds both the
// trades-panel selection state and (Phase 2 Task 2) the chart's windowed
// zone overlay. Side-agnostic: percentages are unsigned magnitudes off the
// entry price (mirrors positionLines.ts's bracketLabels), so shorts and
// longs read the same way.
import type { BacktestResult } from "../api";

type Trade = BacktestResult["trades"][number];

export interface TradeZones {
  hasRisk: boolean;
  hasReward: boolean;
  riskPct: number | null;
  rewardPct: number | null;
  rr: number | null;
  stopMoved: boolean;
}

const pct = (from: number, to: number) => (Math.abs(to - from) / from) * 100;

export function tradeZones(t: Trade): TradeZones {
  const hasRisk = t.stop_initial != null;
  const hasReward = t.target != null;
  const riskPct = hasRisk ? pct(t.entry_price, t.stop_initial as number) : null;
  const rewardPct = hasReward ? pct(t.entry_price, t.target as number) : null;
  const rr = riskPct && rewardPct && riskPct > 0 ? rewardPct / riskPct : null;
  const stopMoved = t.stop_initial != null && t.stop_final != null && t.stop_final !== t.stop_initial;
  return { hasRisk, hasReward, riskPct, rewardPct, rr, stopMoved };
}
