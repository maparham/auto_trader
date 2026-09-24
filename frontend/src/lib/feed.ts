// Data layer for the klinecharts-core chart: history fetch, live stream, and
// instrument search, wired to our FastAPI backend. We own the chart instance,
// so these just return data the caller pushes through the chart data facade
// (setBars for a full load, pushBar for a realtime tick).
//
// This file is the public barrel: the code lives under feed/ (periods, common,
// candles, instruments, live), and importers keep using this path.

export {
  PERIODS,
  PERIOD_GROUPS,
  ALL_PERIODS,
  isBuiltinResolution,
  DEFAULT_RESOLUTIONS,
  periodByResolution,
  customPeriods,
  periodGroups,
  pinnableTimeframes,
  pinBelowChart,
  RESOLUTION_SECONDS,
  nominalBarHours,
  declaredIntervalMs,
  quickBarPeriods,
  quickBarWithActive,
  oneTfLower,
} from "./feed/periods";
export type { Period, PeriodGroup } from "./feed/periods";
export { DEFAULT_BROKER } from "./feed/common";
export {
  fetchRecentWithStatus,
  fetchRecent,
  CandlesFetchError,
  fetchRangeStrict,
  fetchRangeWithStatus,
  fetchRange,
} from "./feed/candles";
export type { FillProgress, CandlesResult } from "./feed/candles";
export {
  logoCandidates,
  searchInstruments,
  fetchAllMarkets,
  bareInstrument,
  resolveInstrument,
  fetchFavorites,
  addFavorite,
  removeFavorite,
  fetchMarketDetail,
  fetchCandleCacheStats,
  fetchCandleCacheGlobalStats,
  fetchMarketMeta,
} from "./feed/instruments";
export type {
  Instrument,
  MarketMeta,
  MarketDetail,
  CandleCacheStats,
  CandleCacheGlobalStats,
} from "./feed/instruments";
export { isFeedStale, openLive } from "./feed/live";
export type { LiveStatus, LiveHandle } from "./feed/live";
