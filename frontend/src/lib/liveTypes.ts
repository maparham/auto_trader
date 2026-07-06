import type { RuleGroup, RiskConfig } from "./backtestConfig";
import type { Candle } from "../api";

export interface LiveAction {
  kind: "open" | "close";
  leg: "long" | "short";
  side: "buy" | "sell";
  reason: string;
  stop_level?: number | null;
  take_profit_level?: number | null;
}

export interface PositionState {
  side: "buy" | "sell";
  quantity: number;
  open_level: number;
  // Epoch seconds the position opened. Needed for counted exits ("Nth time since
  // entry") so the engine can locate the entry bar; omit when unknown.
  open_time?: number;
}

export interface EvaluateRequest {
  epic: string;
  resolution: string;
  candles: Candle[];
  series: Record<string, Array<number | null>>;
  longEntry: RuleGroup;
  longExit: RuleGroup;
  shortEntry: RuleGroup;
  shortExit: RuleGroup;
  longEnabled: boolean;
  shortEnabled: boolean;
  longRisk?: RiskConfig | null;
  shortRisk?: RiskConfig | null;
  position: PositionState | null;
}

export interface EvaluateResult {
  actions: LiveAction[];
}
