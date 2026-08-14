// Illustrated guides for the shipped built-in strategies, keyed by strategy
// filename. Strategies without an entry (user-authored files) show no Guide
// button in StrategyPicker.

import type { StrategyGuide } from "./types";
import { bbRegimeBreakout } from "./bbRegimeBreakout";
import { simConsensus } from "./simConsensus";
import { slopeAcceleration } from "./slopeAcceleration";
import { trendPullback } from "./trendPullback";

export type { StrategyGuide, GuideSection } from "./types";

export const strategyGuides: Record<string, StrategyGuide> = {
  "bb_regime_breakout.py": bbRegimeBreakout,
  "sim_consensus.py": simConsensus,
  "slope_acceleration.py": slopeAcceleration,
  "trend_pullback.py": trendPullback,
};
