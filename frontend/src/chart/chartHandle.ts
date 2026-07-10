// The shared imperative handle passed into every extracted ChartCore hook. It
// bundles the refs + controller objects that the one-time init effect and the
// later callbacks/hooks share, so an extracted hook reaches every piece of
// cross-boundary state through `handle.*` (identity-stable for the mount).
//
// Kept as an interface (not `ReturnType<>`) so each hook file can import the
// type without importing ChartCore itself. ChartCore annotates its handle
// useMemo with `ChartHandle`, so TS verifies the object matches this shape.
import type { Chart } from "klinecharts";
import type { ChartController } from "../lib/chartController";
import type { OverlayManager } from "../lib/overlays";
import type { PositionLines } from "../lib/positionLines";
import type { TradeView } from "../lib/trading";
import type { PendingEdit, DraftOrder, TradeLineUi } from "../lib/signals";
import type { LiveHandle } from "../lib/feed";
import type { CrosshairStyle, PriceSide } from "../theme";
import type { BacktestAggMarkersHandle } from "../BacktestAggMarkers";
import type { TradeExitAggMarkersHandle } from "../TradeExitAggMarkers";

// The in-flight quick-range request (resolution + window + the series identity
// it was issued for). Acts as an ownership token: ensureCoverageAndFit bails if
// a newer pick replaces it OR the epic/broker/side drifts from what it captured.
export type RangeReq = {
  resolution: string;
  fromTs: number;
  toTs: number;
  epic: string;
  broker: string;
  side: PriceSide;
};

export interface ChartHandle {
  controller: ChartController;
  overlays: OverlayManager;
  chartRef: React.MutableRefObject<Chart | null>;
  redrawRef: React.MutableRefObject<() => void>;
  posDrawRef: React.MutableRefObject<() => void>;
  posLinesRef: React.MutableRefObject<PositionLines | null>;
  tradesRef: React.MutableRefObject<TradeView[]>;
  pendingRef: React.MutableRefObject<Record<string, PendingEdit>>;
  draftRef: React.MutableRefObject<DraftOrder | null>;
  tradeUiRef: React.MutableRefObject<TradeLineUi>;
  resRef: React.MutableRefObject<string>;
  crosshairRef: React.MutableRefObject<CrosshairStyle>;
  aggMarkersRef: React.RefObject<BacktestAggMarkersHandle | null>;
  exitAggMarkersRef: React.RefObject<TradeExitAggMarkersHandle | null>;
  paintBracketRef: React.MutableRefObject<() => void>;
  paintSeparatorRef: React.MutableRefObject<() => void>;
  // Live-data + range-navigation shared refs.
  wsRef: React.MutableRefObject<LiveHandle | null>;
  bidRef: React.MutableRefObject<number | null>;
  askRef: React.MutableRefObject<number | null>;
  epicRef: React.MutableRefObject<string>;
  brokerIdRef: React.MutableRefObject<string>;
  priceSideRef: React.MutableRefObject<PriceSide>;
  loadingRef: React.MutableRefObject<boolean>;
  exhaustedRef: React.MutableRefObject<boolean>;
  cursorSecRef: React.MutableRefObject<number>;
  emptyStreakRef: React.MutableRefObject<number>;
  pendingRangeRef: React.MutableRefObject<RangeReq | null>;
  launchedTokenRef: React.MutableRefObject<RangeReq | null>;
  cappedAnchorRef: React.MutableRefObject<Map<string, { target: number; reached: number }>>;
  separatorTsRef: React.MutableRefObject<number | null>;
  programmaticMoveRef: React.MutableRefObject<boolean>;
  pendingTradeRestoreRef: React.MutableRefObject<number | null>;
  snapMarkerIdRef: React.MutableRefObject<string | null>;
  tradeMarkersDrawRef: React.MutableRefObject<() => void>;
  // Cross-boundary call bridges to useRangeNavigation.
  ensureCoverageAndFitRef: React.MutableRefObject<(token: RangeReq) => Promise<void>>;
  ensureAnchorCoverageRef: React.MutableRefObject<() => Promise<void>>;
}
