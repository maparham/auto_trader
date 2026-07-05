// Global defaults / presets / templates: per-type indicator defaults & presets,
// per-name drawing defaults & presets, backtest configs, and symbol / default
// chart templates.

import type { BacktestConfig } from "../backtestConfig";
import { PREFIX, root, load, save, saveLocal, mirrorDelete } from "./core";
import type {
  IndicatorInstance,
  SavedOverlay,
  SavedIndicatorConfig,
  SavedDrawingConfig,
} from "./artifacts";

// --- per-indicator presets (global, keyed by indicator TYPE) -----------------
//
// TradingView's indicator settings "Defaults" menu. GLOBAL (not per-cell, not
// per-symbol) — a personal preference like the favourites list above — so a tuned
// EMA setup is available on every chart. Two layers, both keyed by indicator TYPE
// (EMA/MA/RSI/…), both holding the SAME SavedIndicatorConfig snapshot the settings
// modal already produces (currentConfig) — no new serialization:
//  - default : ONE config per type. Freshly-ADDED instances of that type seed from
//              it (see applyIndicator). Never touches existing/rehydrated instances.
//  - presets : named configs per type ("Fast EMA", …), applied on demand.
// The AVWAP anchor is intentionally absent from SavedIndicatorConfig, so a preset is
// anchorless — correct, since a fresh AVWAP is unplaced regardless.
const indicatorDefaultKey = (type: string) => `${PREFIX}.indicatorDefault.${type}`;
const indicatorPresetsKey = (type: string) => `${PREFIX}.indicatorPresets.${type}`;

export function loadIndicatorDefault(type: string): SavedIndicatorConfig | null {
  return load<SavedIndicatorConfig | null>(indicatorDefaultKey(type), null);
}
export function saveIndicatorDefault(type: string, cfg: SavedIndicatorConfig): void {
  save(indicatorDefaultKey(type), cfg);
}
export function clearIndicatorDefault(type: string): void {
  const key = indicatorDefaultKey(type);
  try {
    localStorage.removeItem(key);
  } catch {
    /* non-fatal */
  }
  mirrorDelete(key);
}

export function loadIndicatorPresets(type: string): Record<string, SavedIndicatorConfig> {
  return load<Record<string, SavedIndicatorConfig>>(indicatorPresetsKey(type), {});
}
export function saveIndicatorPreset(
  type: string,
  name: string,
  cfg: SavedIndicatorConfig,
): void {
  const all = loadIndicatorPresets(type);
  all[name] = cfg;
  save(indicatorPresetsKey(type), all);
}
export function deleteIndicatorPreset(type: string, name: string): void {
  const all = loadIndicatorPresets(type);
  if (name in all) {
    delete all[name];
    save(indicatorPresetsKey(type), all);
  }
}

// --- per-drawing defaults + templates (global, keyed by overlay NAME) --------
//
// The drawing analogue of the indicator "Defaults" menu above. GLOBAL (not
// per-cell, not per-symbol) — a personal style preference — keyed by the
// klinecharts overlay NAME (segment/rayLine/straightLine/…). Two layers holding
// the SAME SavedDrawingConfig the drawing settings modal produces:
//  - default : ONE config per name. Freshly-DRAWN overlays of that name seed from
//              it (see OverlayManager.addDrawing). Never touches rehydrated draws.
//  - presets : named configs per name ("Red", …), applied on demand.
// Extend is NOT a stored field: the trend family (segment/rayLine/straightLine)
// is three separate names, so extend is captured by which name you save under.
const drawingDefaultKey = (name: string) => `${PREFIX}.drawingDefault.${name}`;
const drawingPresetsKey = (name: string) => `${PREFIX}.drawingPresets.${name}`;

export function loadDrawingDefault(name: string): SavedDrawingConfig | null {
  return load<SavedDrawingConfig | null>(drawingDefaultKey(name), null);
}
export function saveDrawingDefault(name: string, cfg: SavedDrawingConfig): void {
  save(drawingDefaultKey(name), cfg);
}
export function clearDrawingDefault(name: string): void {
  const key = drawingDefaultKey(name);
  try {
    localStorage.removeItem(key);
  } catch {
    /* non-fatal */
  }
  mirrorDelete(key);
}

export function loadDrawingPresets(name: string): Record<string, SavedDrawingConfig> {
  return load<Record<string, SavedDrawingConfig>>(drawingPresetsKey(name), {});
}
export function saveDrawingPreset(name: string, presetName: string, cfg: SavedDrawingConfig): void {
  const all = loadDrawingPresets(name);
  all[presetName] = cfg;
  save(drawingPresetsKey(name), all);
}
export function deleteDrawingPreset(name: string, presetName: string): void {
  const all = loadDrawingPresets(name);
  if (presetName in all) {
    delete all[presetName];
    save(drawingPresetsKey(name), all);
  }
}

// --- backtest configs (global) ------------------------------------------------
//
// Same shape as the indicator-preset pair above: named presets (Save/load/Delete
// in the settings modal) plus a last-used snapshot that auto-restores next time
// the modal opens. GLOBAL (not per-symbol/per-cell) — a strategy you built is
// useful on any chart.
export type SavedBacktestConfig = BacktestConfig;

// v2: config shape changed from entry/exit to four groups (hedging). Old keys
// are abandoned rather than migrated — a stale long-only config would be missing
// the short groups, so callers fall back to defaultBacktestConfig().
const BACKTEST_PRESETS_KEY = `${PREFIX}.backtestPresets.v2`;
const BACKTEST_LAST_USED_KEY = `${PREFIX}.backtestLastUsed.v2`;

export function loadBacktestPresets(): Record<string, SavedBacktestConfig> {
  return load<Record<string, SavedBacktestConfig>>(BACKTEST_PRESETS_KEY, {});
}
export function saveBacktestPreset(name: string, cfg: SavedBacktestConfig): void {
  const all = loadBacktestPresets();
  all[name] = cfg;
  save(BACKTEST_PRESETS_KEY, all);
}
export function deleteBacktestPreset(name: string): void {
  const all = loadBacktestPresets();
  if (name in all) {
    delete all[name];
    save(BACKTEST_PRESETS_KEY, all);
  }
}

export function loadBacktestLastUsed(): SavedBacktestConfig | null {
  return load<SavedBacktestConfig | null>(BACKTEST_LAST_USED_KEY, null);
}
export function saveBacktestLastUsed(cfg: SavedBacktestConfig): void {
  save(BACKTEST_LAST_USED_KEY, cfg);
}

// The Long/Short tab the backtest modal last showed. Device-local (a per-browser
// view preference, not synced) so re-opening the modal returns to the same side.
const BACKTEST_SIDE_KEY = `${PREFIX}.backtestSide`;
export function loadBacktestSide(): "long" | "short" {
  return load<"long" | "short">(BACKTEST_SIDE_KEY, "long");
}
export function saveBacktestSide(side: "long" | "short"): void {
  saveLocal(BACKTEST_SIDE_KEY, side);
}

// The settings/results vertical split in the backtest panel: the results-region
// height (px) and whether it's collapsed. Device-local view preference, like the
// side above — persists the layout you dragged to across re-opens and reloads.
const BACKTEST_SPLIT_KEY = `${PREFIX}.backtestSplit`;
export interface BacktestSplit {
  resultsHeight: number;
  collapsed: boolean;
}
export function loadBacktestSplit(): BacktestSplit {
  return load<BacktestSplit>(BACKTEST_SPLIT_KEY, { resultsHeight: 0, collapsed: false });
}
export function saveBacktestSplit(split: BacktestSplit): void {
  saveLocal(BACKTEST_SPLIT_KEY, split);
}

// --- per-symbol chart templates (global, keyed by epic) ----------------------
//
// A saved layout (indicators + drawings) tied to a SYMBOL, not a cell — so a
// NAS100 setup can follow NAS100 onto any chart. TradingView's "chart layout
// template" / "apply default to symbol". v1 = ONE default template per epic
// (saving overwrites it; that single template auto-applies to fresh charts of the
// symbol and can be applied on demand to any chart).
//
// The payload reuses the existing saved shapes VERBATIM (IndicatorInstance[],
// per-id SavedIndicatorConfig, SavedOverlay[]) so capture/apply just shuttle the
// same blobs the per-cell stores already hold — no new serialization. AVWAP anchors
// (deliberately NOT inside SavedIndicatorConfig — they live under avwap.<epic>.<id>)
// are captured separately so a templated AVWAP keeps its anchor. Stored under a
// PER-BROKER key (root()) so it's shared across cells/tabs of one broker and
// mirrored to the backend; epics are broker-specific, so templates don't cross
// brokers.
export interface SymbolTemplate {
  epic: string;
  indicators: IndicatorInstance[];
  indicatorConfigs: Record<string, SavedIndicatorConfig>;
  drawings: SavedOverlay[];
  avwapAnchors: Record<string, number>; // instance id -> anchor ms
  savedAt: number;
}

const templateKey = (epic: string) => root(`template.${epic}`);

export function loadSymbolTemplate(epic: string): SymbolTemplate | null {
  return load<SymbolTemplate | null>(templateKey(epic), null);
}
export function saveSymbolTemplate(t: SymbolTemplate): void {
  save(templateKey(t.epic), t);
}
export function deleteSymbolTemplate(epic: string): void {
  const key = templateKey(epic);
  try {
    localStorage.removeItem(key);
  } catch {
    /* non-fatal */
  }
  mirrorDelete(key); // keep the backend / other tabs in step
}

// --- global default chart template (symbol-agnostic) -------------------------
//
// A single, NOT-per-epic default layout that auto-applies to EVERY fresh chart
// regardless of symbol — for indicators useful on almost any chart (Volume, a
// session VWAP, etc.) so they don't have to be re-added by hand each time.
// TradingView's "apply as default to all symbols".
//
// Unlike SymbolTemplate this carries ONLY indicators + their per-id configs:
// drawings and AVWAP anchors are price/time/epic-specific (drawings live under
// the epic; anchors under avwap.<epic>.<id>), so they're meaningless-to-wrong on
// an arbitrary symbol and are deliberately excluded at capture. Stored under one
// global key, mirrored to the backend like everything else.
export interface DefaultTemplate {
  indicators: IndicatorInstance[];
  indicatorConfigs: Record<string, SavedIndicatorConfig>;
  savedAt: number;
}

const defaultTemplateKey = () => `${PREFIX}.defaultTemplate`;

export function loadDefaultTemplate(): DefaultTemplate | null {
  return load<DefaultTemplate | null>(defaultTemplateKey(), null);
}
export function saveDefaultTemplate(t: DefaultTemplate): void {
  save(defaultTemplateKey(), t);
}
export function deleteDefaultTemplate(): void {
  const key = defaultTemplateKey();
  try {
    localStorage.removeItem(key);
  } catch {
    /* non-fatal */
  }
  mirrorDelete(key); // keep the backend / other tabs in step
}
