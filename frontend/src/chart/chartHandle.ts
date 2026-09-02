// The shared imperative handle passed into every extracted ChartCore hook. It
// bundles the refs + controller objects that the one-time init effect and the
// later callbacks/hooks share, so an extracted hook reaches every piece of
// cross-boundary state through `handle.*` (identity-stable for the mount).
//
// Kept as an interface (not `ReturnType<>`) so each hook file can import the
// type without importing ChartCore itself. ChartCore annotates its handle
// useMemo with `ChartHandle`, so TS verifies the object matches this shape.
import type { Chart, KLineData } from "klinecharts";
import type { ChartDataFacade } from "./chartDataFacade";
import type { ChartController } from "../lib/chartController";
import type { OverlayManager } from "../lib/overlays";
import type { PositionLines } from "../lib/positionLines";
import type { TradeView } from "../lib/trading";
import type { PendingEdit, DraftOrder, TradeLineUi } from "../lib/signals";
import type { LiveHandle } from "../lib/feed";
import type { PageResult } from "../lib/historyPaging";
import type { CrosshairStyle, PriceSide } from "../theme";
import type { BacktestAggMarkersHandle } from "../BacktestAggMarkers";
import type { TradeExitAggMarkersHandle } from "../TradeExitAggMarkers";
import type { BacktestTradeDashesHandle } from "../BacktestTradeDashes";

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
  // Page budget for the coverage walk, when this request needs a deeper one than
  // the quick-range default (see ensureCoverageAndFit). Optional so the tokens
  // the quick-range picker builds keep the default. Reference identity is what
  // pendingRangeRef/launchedTokenRef compare, so an extra field is inert there.
  maxPages?: number;
  // Set by the backtest drill-in when its trade span sits behind the fresh
  // recent-only load by more than the sequential walk's 16-page budget (but
  // inside the detach threshold): consumption must run the parallel cover
  // (coverBacktestTradeTo) before ensureCoverageAndFit, the same recipe
  // goToRange uses for match jumps.
  deepCover?: boolean;
  // The UNPADDED left edge of what the request is actually about (the first
  // trade of a drill-in span). fromTs carries symmetric context padding, and
  // padding routinely lands inside a closed-market gap (weekend) no broker
  // has bars for — "history doesn't reach" warnings must measure against
  // this, not fromTs, or every span starting on a Monday warns spuriously.
  targetFromTs?: number;
  // What the coverage walk does with the viewport once it settles. "range" (the
  // default, and what every caller that omits this gets) fits [fromTs, toTs] to
  // the viewport, which changes zoom. "center" keeps the user's current zoom and
  // only scrolls, putting the range's midpoint in the middle of the pane — what
  // a jump to a pattern match wants, since re-zooming on every row click makes
  // the chart unreadable.
  fit?: "range" | "center";
};

// A parked "drop one timeframe and center here" request from the zoom-to-range
// tool. Consumed by useLiveMarketData after the lower-TF bars load: it forces
// the view to center on centerTs (winning over keepCenter and the
// reset-on-TF-change setting), then redraws the band from bandStart/EndTs. Only
// fires when its resolution matches the incoming load; an epic change clears it
// (via the epicChanged flag), so it carries no epic/broker/side of its own.
export type CenterReq = {
  resolution: string;
  centerTs: number;
  bandStartTs: number;
  bandEndTs: number;
};

/** What the OTHER hooks need from the replaying cell. The load effect asks for
 * the bars to paint; the MTF coordinator asks for the cursor so a higher-
 * timeframe series cannot look ahead. Null when this cell has never replayed. */
export interface ReplayHandle {
  isActive(): boolean;
  masked(): boolean;
  /** "Known through" instant (see lib/replayBars). 0 when not replaying. */
  cursorMs(): number;
  /** Session start cursor — the masking anchor. 0 when not replaying. */
  startMs(): number;
  /** Bars to paint for `resolution` at the current cursor: fetches the window
   * (context + forward buffer) and returns only the closed ones. */
  barsFor(resolution: string): Promise<KLineData[]>;
}

export interface ChartHandle {
  controller: ChartController;
  overlays: OverlayManager;
  chartRef: React.MutableRefObject<Chart | null>;
  dataFacadeRef: React.MutableRefObject<ChartDataFacade | null>;
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
  tradeDashesRef: React.RefObject<BacktestTradeDashesHandle | null>;
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
  pendingCenterRef: React.MutableRefObject<CenterReq | null>;
  // A restored pattern-search selection band waiting for the series load:
  // rehydrate tears down every overlay, so the band is repainted from this
  // AFTER it (same timing as pendingCenterRef's zoom band, minus the centering).
  pendingPatternBandRef: React.MutableRefObject<{ fromMs: number; toMs: number } | null>;
  /** Cross-tab pattern jump's match/aftermath bands, painted after the first
   *  load (rehydrate wipes overlays painted any earlier). */
  pendingMatchBandsRef: React.MutableRefObject<{
    fromMs: number;
    toMs: number;
    fwd: { fromTs: number; toTs: number } | null;
  } | null>;
  launchedTokenRef: React.MutableRefObject<RangeReq | null>;
  cappedAnchorRef: React.MutableRefObject<Map<string, { target: number; reached: number }>>;
  separatorTsRef: React.MutableRefObject<number | null>;
  programmaticMoveRef: React.MutableRefObject<boolean>;
  pendingTradeRestoreRef: React.MutableRefObject<number | null>;
  snapMarkerIdRef: React.MutableRefObject<string | null>;
  tradeMarkersDrawRef: React.MutableRefObject<() => void>;
  // Replay (null until the cell first enters replay; see chart/useReplay.ts).
  // Assigned during RENDER, not in an effect, so useLiveMarketData's load effect
  // — which runs after this hook's — always sees a current handle.
  replayRef: React.MutableRefObject<ReplayHandle | null>;
  // Cross-boundary call bridges to useRangeNavigation.
  ensureCoverageAndFitRef: React.MutableRefObject<(token: RangeReq) => Promise<PageResult>>;
  ensureAnchorCoverageRef: React.MutableRefObject<() => Promise<void>>;
}
