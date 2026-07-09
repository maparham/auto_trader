// Per-cell chart content + preferences: drawings, backtest results, active
// indicators + their configs, price-axis/legend flags, favourites, recent
// symbols, and AVWAP anchors.

import type { DeepPartial, OverlayStyle, LineType } from "klinecharts";
import type { VisibilityModel } from "../visibility";
import type { FibConfig } from "../fibConfig";
import type { BacktestResult } from "../../api";
import type { BacktestPeriod } from "../backtestPeriods";
import { PREFIX, ns, root, load, save, saveLocal, removeKeyEverywhere } from "./core";
import { emitLayoutChanged } from "./layoutEvents";

// --- drawings (overlays the user drew) ---------------------------------------

export interface SavedOverlay {
  name: string;
  points: Array<{ timestamp?: number; value?: number; dataIndex?: number }>;
  styles?: DeepPartial<OverlayStyle> | null;
  lock?: boolean;
  // TV-style edit state. All optional → older saved drawings (which lack them)
  // rehydrate unchanged: visible defaults true, zLevel 0, extendData absent.
  visible?: boolean;
  zLevel?: number;
  extendData?: unknown;
}

const drawingsKey = (scope: string, epic: string) => ns(scope, `drawings.${epic}`);

export function loadDrawings(scope: string, epic: string): SavedOverlay[] {
  return load<SavedOverlay[]>(drawingsKey(scope, epic), []);
}
export function saveDrawings(scope: string, epic: string, list: SavedOverlay[]): void {
  save(drawingsKey(scope, epic), list);
  emitLayoutChanged(scope);
}

// --- backtest result (per cell, per epic) ------------------------------------
//
// The last backtest a cell ran, persisted so its markers/equity/trades survive a
// timeframe switch AND a full reload — cleared only by the toolbar ✕ or a re-run.
// Keyed like drawings (scope + epic): a cell owns its own backtest, and per-epic
// so switching symbol away and back restores the right result. The bulky
// `candles` array is stripped before saving — redraw attaches markers/equity to
// whatever bars are loaded by absolute timestamp, so the candles aren't needed.
// The persisted result also carries the trading `period` (window + resolved
// mask) so the on-chart period shading rehydrates like the markers do — it is a
// frontend-derived field (not returned by the backend), attached at save time.
export type StoredBacktestResult = Omit<BacktestResult, "candles"> & {
  period?: BacktestPeriod;
  // Whether the equity curve should be drawn for this result. Travels with the
  // saved run (like `period`) so a reload / timeframe-switch rehydrate honors the
  // choice the run was made with. Absent (old results) → hidden.
  showEquity?: boolean;
};

const backtestKey = (scope: string, epic: string) => ns(scope, `backtest.${epic}`);

export function loadBacktestResult(scope: string, epic: string): StoredBacktestResult | null {
  return load<StoredBacktestResult | null>(backtestKey(scope, epic), null);
}
export function saveBacktestResult(
  scope: string,
  epic: string,
  result: BacktestResult,
  period?: BacktestPeriod,
  showEquity?: boolean,
): void {
  // Strip the bulky candle array before persisting — redraw doesn't need it
  // (markers/equity/periods attach to whatever bars are loaded by absolute
  // timestamp).
  const stored: StoredBacktestResult = { ...result, period, showEquity };
  delete (stored as Partial<BacktestResult>).candles;
  save(backtestKey(scope, epic), stored);
}
export function clearBacktestResult(scope: string, epic: string): void {
  removeKeyEverywhere(backtestKey(scope, epic));
}

// --- active indicators (per cell) --------------------------------------------

// One active indicator INSTANCE. `id` is the unique klinecharts name (e.g.
// "EMA#a1b2"); `type` is the real indicator type (EMA/MA/AVWAP/RSI/…). Multiple
// instances of the same type can coexist — that's the whole point. (Was a bare
// `string[]` of type-names back when only one instance per type was allowed.)
export interface IndicatorInstance {
  id: string;
  type: string;
}

const indicatorsKey = (scope: string) => ns(scope, "indicators");

// Load the active instance list, MIGRATING the old `string[]` (one instance per
// name) shape: each old name becomes an instance whose id === type === name. Using
// the name as the id is deliberate — the per-indicator config map was ALSO keyed by
// name, so a name-as-id instance keeps reading its existing saved config with zero
// config migration.
export function loadIndicators(scope: string): IndicatorInstance[] {
  const raw = load<Array<string | IndicatorInstance>>(indicatorsKey(scope), []);
  return raw.map((e) =>
    typeof e === "string" ? { id: e, type: e } : { id: e.id, type: e.type },
  );
}
export function saveIndicators(scope: string, list: IndicatorInstance[]): void {
  save(indicatorsKey(scope), list);
  emitLayoutChanged(scope);
}

// --- price-axis scale source (per cell) --------------------------------------
//
// TradingView-style "Scale price chart only": when true, the candle-pane price
// axis auto-fits to the candle OHLC only and overlay indicators no longer expand
// it (so adding an overlay never shrinks the candles). Default true.
const scalePriceOnlyKey = (scope: string) => ns(scope, "scalePriceOnly");

export function loadScalePriceOnly(scope: string): boolean {
  return load<boolean>(scalePriceOnlyKey(scope), true);
}
export function saveScalePriceOnly(scope: string, value: boolean): void {
  save(scalePriceOnlyKey(scope), value);
}

// --- legend collapsed (per cell) ----------------------------------------------
//
// TradingView-style legend chevron: when true, the candle-pane legend hides its
// indicator rows and shows only the symbol/OHLC row. Default false (expanded).
const legendCollapsedKey = (scope: string) => ns(scope, "legendCollapsed");

export function loadLegendCollapsed(scope: string): boolean {
  return load<boolean>(legendCollapsedKey(scope), false);
}
export function saveLegendCollapsed(scope: string, value: boolean): void {
  save(legendCollapsedKey(scope), value);
}

// --- favourite indicators (global preference) --------------------------------
//
// Which indicator TYPES the user has starred in the menu — a personal preference,
// NOT chart state, so it is global (no scope) rather than per-cell. The per-cell
// `indicators` store above is the ACTIVE set on one chart; this is just the
// "shortlist" shown in the menu's Favorites section. Stored as an ordered list of
// type codes (e.g. ["EMA", "RSI"]); order = the order they were starred.
const FAVORITE_INDICATORS_KEY = `${PREFIX}.indicatorFavorites`;

export function loadFavoriteIndicators(): string[] {
  return load<string[]>(FAVORITE_INDICATORS_KEY, []);
}
export function saveFavoriteIndicators(list: string[]): void {
  save(FAVORITE_INDICATORS_KEY, list);
}

// --- drawing-tool preferences (left sidebar) ---------------------------------
//
// Starred drawing tools (GLOBAL preference, star order) — mirrors the
// indicator favorites idiom above. And the last-used tool per sidebar family
// (device-local), so each family button re-arms what you used last.
const FAVORITE_DRAWINGS_KEY = `${PREFIX}.drawingFavorites`;
export function loadFavoriteDrawings(): string[] {
  return load<string[]>(FAVORITE_DRAWINGS_KEY, []);
}
export function saveFavoriteDrawings(list: string[]): void {
  save(FAVORITE_DRAWINGS_KEY, list);
}

const LAST_DRAW_TOOLS_KEY = `${PREFIX}.lastDrawTools`;
export function loadLastDrawTools(): Record<string, string> {
  return load<Record<string, string>>(LAST_DRAW_TOOLS_KEY, {});
}
export function saveLastDrawTools(map: Record<string, string>): void {
  saveLocal(LAST_DRAW_TOOLS_KEY, map);
}

// Favorite timeframes (GLOBAL preference) — resolution keys the user pinned onto
// the quick-access bar, on top of the fixed defaults. Order here is just the pin
// set; the bar itself always renders in duration order. Mirrors the indicator /
// drawing favorites idiom above.
const FAVORITE_RESOLUTIONS_KEY = `${PREFIX}.favoriteResolutions`;
export function loadFavoriteResolutions(): string[] {
  return load<string[]>(FAVORITE_RESOLUTIONS_KEY, []);
}
export function saveFavoriteResolutions(list: string[]): void {
  save(FAVORITE_RESOLUTIONS_KEY, list);
}

// --- recently opened symbols (PER BROKER, mirrored) --------------------------
//
// A personal MRU list: the epics of symbols the user recently opened from the
// symbol-search modal, most-recent-first, capped. Stores epics only (not Instrument
// snapshots) so the rendered name/status/type stay fresh off the catalogue, and
// resolves to nothing for an epic that left the catalogue. PER BROKER because epics
// are broker-specific (a Capital MRU is meaningless on IG) — keyed via root().
const recentSymbolsKey = () => root("recentSymbols");
const RECENT_SYMBOLS_MAX = 12;

export function loadRecentSymbols(): string[] {
  return load<string[]>(recentSymbolsKey(), []);
}
export function pushRecentSymbol(epic: string): void {
  const next = [epic, ...loadRecentSymbols().filter((e) => e !== epic)].slice(
    0,
    RECENT_SYMBOLS_MAX,
  );
  save(recentSymbolsKey(), next);
}

// --- per-indicator / per-drawing settings snapshots (per cell) ---------------

// Full per-indicator settings snapshot, keyed by instance id (per cell, like the
// active set). Survives reload so Inputs (length / source / offset / smoothing /
// MTF timeframe via extendData), Style (line color/size), Visibility, and the
// "hide value in legend" toggle all stick. Applied when the indicator is
// (re)created. NOTE: AVWAP's anchor (calcParams[0]) is intentionally NOT stored
// here — it's per-instance (see avwapAnchor). extendData stores only config, never
// the bulky computed MTF series (recomputed on load by the MTF coordinator). Old
// configs were keyed by type-name; a migrated instance's id === its old name, so
// those entries are found unchanged.
export interface SavedIndicatorConfig {
  calcParams?: number[];
  visible?: boolean;
  // klinecharts persists indicator.styles.lines verbatim; entries carry the FULL
  // line style (style/dashedValue/smooth) so a restored line never crashes the
  // drawer. `style`/`dashedValue` is what the Style-tab line-style picker writes.
  styles?: { lines: Array<{ color?: string; size?: number; style?: string; dashedValue?: number[] }> };
  extendData?: Record<string, unknown>;
}

// The drawing settings modal's reusable style snapshot (no points/text/extend —
// see the per-drawing defaults block). `visibility` absent = show on all intervals
// (the VisibilityModel default). This is the same per-timeframe model the Visibility
// tab edits (lib/visibility.ts) — a plain JSON object, safe to persist.
export interface SavedDrawingConfig {
  line?: { color?: string; size?: number; style?: LineType };
  // Rectangle fill + border (klinecharts polygon styles). Only rect drawings set it.
  polygon?: { color?: string; borderColor?: string; borderSize?: number };
  // Fib retracement level/extend/… config. Only fibonacciLine drawings set it.
  fib?: FibConfig;
  showMiddle?: boolean;
  priceLabels?: boolean;
  visibility?: VisibilityModel;
}

const indicatorCfgKey = (scope: string) => ns(scope, "indicatorConfig");

export function loadIndicatorConfigs(scope: string): Record<string, SavedIndicatorConfig> {
  return load<Record<string, SavedIndicatorConfig>>(indicatorCfgKey(scope), {});
}
// Full replace — the settings modal always supplies a complete snapshot. `id` is
// the instance id.
export function saveIndicatorConfig(scope: string, id: string, cfg: SavedIndicatorConfig): void {
  const all = loadIndicatorConfigs(scope);
  all[id] = cfg;
  save(indicatorCfgKey(scope), all);
  emitLayoutChanged(scope);
}
// Patch only the `visible` flag, preserving the rest of the snapshot. Used by the
// legend / tooltip eye toggle, which (unlike the settings modal) doesn't have a
// full config to write. Also patches extendData.userVisible to the same value —
// applyIndicatorIntervalVisibility (lib/indicators.ts) reads intent from THAT field
// on every period change, so leaving it stale here would make the eye toggle appear
// to self-revert on the next reload (the top-level `visible` patched above only
// seeds the initial creation flag, per applyIndicator's `cfg?.visible === false` check).
export function saveIndicatorVisible(scope: string, id: string, visible: boolean): void {
  const all = loadIndicatorConfigs(scope);
  const prev = all[id];
  all[id] = { ...prev, visible, extendData: { ...prev?.extendData, userVisible: visible } };
  save(indicatorCfgKey(scope), all);
  emitLayoutChanged(scope);
}
// Drop a removed instance's config so it doesn't leak storage (instances are now
// unbounded; the old one-per-name model never needed cleanup).
export function deleteIndicatorConfig(scope: string, id: string): void {
  const all = loadIndicatorConfigs(scope);
  if (id in all) {
    delete all[id];
    save(indicatorCfgKey(scope), all);
    emitLayoutChanged(scope);
  }
}

// --- AVWAP anchor timestamp (per epic, per instance, ms) ---------------------
// Per-instance now (was one anchor per epic) so multiple AVWAPs on one symbol each
// keep their own anchor. Legacy single-anchor entries (`avwap.<epic>`) are read as
// a fallback so a pre-multi-instance AVWAP (whose instance id === "AVWAP") keeps
// its placed anchor across the upgrade.
const avwapKey = (scope: string, epic: string, id: string) =>
  ns(scope, `avwap.${epic}.${id}`);
const legacyAvwapKey = (scope: string, epic: string) => ns(scope, `avwap.${epic}`);

export function loadAvwapAnchor(scope: string, epic: string, id: string): number {
  const v = load<number>(avwapKey(scope, epic, id), 0);
  if (v) return v;
  // Migration fallback: the old per-epic anchor, claimed by the bare "AVWAP" id.
  if (id === "AVWAP") return load<number>(legacyAvwapKey(scope, epic), 0);
  return 0;
}
export function saveAvwapAnchor(scope: string, epic: string, id: string, anchorMs: number): void {
  save(avwapKey(scope, epic, id), anchorMs);
  emitLayoutChanged(scope);
}
