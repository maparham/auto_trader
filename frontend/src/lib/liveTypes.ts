import type { RiskConfig } from "./backtestConfig";
import type { ExprInstancePayload } from "./exprInstances";
import type { Candle, ParamValues } from "../api";

export interface LiveAction {
  kind: "open" | "close";
  leg: "long" | "short";
  side: "buy" | "sell";
  reason: string;
  stop_level?: number | null;
  take_profit_level?: number | null;
  // Author-specified size from a coded strategy's ctx.buy(qty=)/ctx.sell(qty=).
  // null/undefined = caller's default sizing (the live panel's quantity).
  quantity?: number | null;
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
  longEnabled: boolean;
  shortEnabled: boolean;
  longRisk?: RiskConfig | null;
  shortRisk?: RiskConfig | null;
  position: PositionState | null;
  codedStrategy?: string; // coded strategy filename — when set, rule groups are ignored (Strategy tab)
  // Broker/price side for backend-side HTF fetches (coded strategies' tf= calls).
  broker?: string;
  priceSide?: string;
  codedParams?: ParamValues; // panel-tuned ctx.param() overrides for `codedStrategy`
  // Expression-rule live decision (main groups). When exprMode is true the
  // backend builds an expression strategy from these rows and ignores the
  // structured groups + series above. Never sent together with codedStrategy.
  exprMode?: boolean;
  exprLongEntry?: Array<{ expr: string; enabled: boolean }>;
  exprLongExit?: Array<{ expr: string; enabled: boolean }>;
  exprShortEntry?: Array<{ expr: string; enabled: boolean }>;
  exprShortExit?: Array<{ expr: string; enabled: boolean }>;
  // Chart pane settings for every `SLOPE.slope0`-style reference the rows make,
  // keyed by instance id — the same map the backtest request carries, and the
  // same one the backend resolves (schemas.py EvaluateRequest.indicators).
  //
  // A rule names an OUTPUT and restates none of the pane's parameters, so
  // without this the backend resolves {} and `validate` raises
  // unknown_indicator_ref: the route 422s and the cycle logs "evaluate failed"
  // EVERY BAR — including, for an open position, the exit rules. Frozen into
  // the armed snapshot at arm time (liveState.ArmedSnapshot.indicators), never
  // re-read per cycle: the chart can be unmounted or retuned while armed, and a
  // running strategy must not silently change under it.
  indicators?: Record<string, ExprInstancePayload>;
}

export interface EvaluateResult {
  actions: LiveAction[];
}
