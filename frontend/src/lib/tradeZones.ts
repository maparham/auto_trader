// Pure risk/reward geometry for a single backtest trade — feeds both the
// trades-panel selection state and (Phase 2 Task 2) the chart's windowed
// zone overlay. Side-agnostic: percentages are unsigned magnitudes off the
// entry price (mirrors positionLines.ts's bracketLabels), so shorts and
// longs read the same way.
//
// A trade does NOT need a hard stop or target to have risked and offered
// something: a rule-exit strategy (close on the opposite cross) carries no
// bracket at all, and gating the whole drawing on stop_initial/target left
// those trades as a bare entry line that read as a broken overlay. So each
// band falls back to what the trade ACTUALLY did — MAE for the risk side, MFE
// for the reward side — and says so via riskRealized/rewardRealized, which the
// overlay renders differently (dashed edge, tagged pill) so a realized
// excursion is never mistaken for a level the strategy planned.
import type { BacktestResult } from "../api";

type Trade = BacktestResult["trades"][number];

export interface TradeZones {
  hasRisk: boolean;
  hasReward: boolean;
  riskPct: number | null;
  rewardPct: number | null;
  rr: number | null;
  stopMoved: boolean;
  /** Price the risk band reaches: the initial stop, else the worst excursion.
   *  Null when the trade has neither (a same-price entry/exit). */
  riskLevel: number | null;
  /** Price the reward band reaches: the target, else the best excursion. */
  rewardLevel: number | null;
  /** riskLevel came from MAE rather than a stop the strategy set. */
  riskRealized: boolean;
  /** rewardLevel came from MFE rather than a target the strategy set. */
  rewardRealized: boolean;
}

const pct = (from: number, to: number) => (Math.abs(to - from) / from) * 100;

export function tradeZones(t: Trade): TradeZones {
  // Excursions are unsigned distances off the entry (engine convention), so
  // the leg decides which way each one lies. Old cached results predate the
  // fields entirely, hence the ?? 0 — which simply collapses the band.
  const away = t.leg === "short" ? 1 : -1;
  const mae = t.mae ?? 0;
  const mfe = t.mfe ?? 0;
  const riskRealized = t.stop_initial == null && mae > 0;
  const rewardRealized = t.target == null && mfe > 0;
  const riskLevel = t.stop_initial ?? (riskRealized ? t.entry_price + away * mae : null);
  const rewardLevel = t.target ?? (rewardRealized ? t.entry_price - away * mfe : null);
  const hasRisk = riskLevel != null;
  const hasReward = rewardLevel != null;
  const riskPct = hasRisk ? pct(t.entry_price, riskLevel as number) : null;
  const rewardPct = hasReward ? pct(t.entry_price, rewardLevel as number) : null;
  const rr = riskPct && rewardPct && riskPct > 0 ? rewardPct / riskPct : null;
  const stopMoved = t.stop_initial != null && t.stop_final != null && t.stop_final !== t.stop_initial;
  return { hasRisk, hasReward, riskPct, rewardPct, rr, stopMoved,
           riskLevel, rewardLevel, riskRealized, rewardRealized };
}

/** The overlay's three pill texts. A realized band names its source so the
 *  chart still tells you whether the strategy had a bracket. */
export function zoneLabels(z: TradeZones): { risk: string | null; reward: string | null; rr: string | null } {
  return {
    risk: z.riskPct == null ? null : `-${z.riskPct.toFixed(1)}%${z.riskRealized ? " MAE" : ""}`,
    reward: z.rewardPct == null ? null : `+${z.rewardPct.toFixed(1)}%${z.rewardRealized ? " MFE" : ""}`,
    rr: z.rr == null ? null
      : `${z.riskRealized || z.rewardRealized ? "MAE/MFE" : "R:R"} 1:${z.rr.toFixed(2)}`,
  };
}
