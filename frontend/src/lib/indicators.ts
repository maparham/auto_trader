// Indicator create/remove/hydrate, extracted from Toolbar so BOTH the focused
// Toolbar (user add on the focused chart) and ChartCore (hydrate each cell's saved
// set on mount) drive indicators the same way. Hydration must live in ChartCore —
// non-focused cells still show their indicators, and the Toolbar only ever binds to
// the focused cell.
//
// MULTI-INSTANCE MODEL. klinecharts keys indicators by `name` within a pane and
// rejects duplicate names, so to have two EMAs we give each a UNIQUE name (the
// "instance id", e.g. "EMA#a1b2") and carry the real TYPE in extendData.indType.
// For our custom types we register a per-instance template (a clone of the base
// template under the instance id) before createIndicator. Built-in klinecharts
// types (RSI/MACD/…) are created under their own name as a single instance (one per
// type) — they have no custom template to clone, and duplicating them isn't a
// requested feature; their id === type.

import type {
  Chart,
  Indicator,
  IndicatorCreate,
  IndicatorStyle,
  IndicatorTemplate,
} from "klinecharts";
import { registerIndicator, getSupportedIndicators } from "klinecharts";
import {
  OVERLAY_INDICATORS,
  BASE_TEMPLATES,
  legendTooltipSource,
  indTypeOf,
  type CustomIndicatorType,
} from "./customIndicators";
import {
  loadIndicators,
  loadIndicatorConfigs,
  loadIndicatorDefault,
  loadAvwapAnchor,
  deleteIndicatorConfig,
  type IndicatorInstance,
  type SavedIndicatorConfig,
} from "./persist";

const CUSTOM_TYPES = Object.keys(BASE_TEMPLATES) as CustomIndicatorType[];
export const isCustomType = (type: string): type is CustomIndicatorType =>
  (CUSTOM_TYPES as string[]).includes(type);

// calcParams we override on built-in klinecharts indicators at creation, to match
// TradingView's shape rather than klinecharts' defaults. klinecharts' RSI ships
// with three lengths ([6,12,24] → three lines); TradingView draws a SINGLE RSI of
// length 14. Because RSI's `regenerateFigures` emits one line per calcParam, a
// one-element calcParams yields exactly one curve. Only consulted on a fresh add
// (no saved config); custom types carry their own defaults in BASE_TEMPLATES.
const DEFAULT_CALC_PARAMS: Record<string, number[]> = {
  RSI: [14],
};

// Default height (CSS px) for a sub-pane indicator's own pane. klinecharts' default
// is a cramped ~50px; TradingView gives oscillators much more room, so new sub-panes
// (RSI/MACD/…) open taller. Users can still drag the pane divider to resize.
const SUBPANE_HEIGHT = 120;

// Mint a unique instance id for a type. The bare type name is used for the FIRST
// instance (so storage stays byte-identical for single-instance users and the
// migration that maps old name → {id:name,type:name} lines up); later instances get
// a "#<rand>" suffix. The id must be a valid, unique klinecharts indicator name.
export function mintInstanceId(chart: Chart, type: string): string {
  const taken = new Set<string>();
  const panes = chart.getIndicatorByPaneId() as
    | Map<string, Map<string, Indicator>>
    | null
    | undefined;
  for (const inds of panes?.values() ?? []) for (const n of inds.keys()) taken.add(n);
  if (!taken.has(type)) return type; // first instance keeps the clean name
  let id: string;
  do {
    id = `${type}#${Math.random().toString(36).slice(2, 8)}`;
  } while (taken.has(id));
  return id;
}

// Pull a registerable template off a LIVE indicator instance of `type`. klinecharts
// doesn't expose its built-in templates (getIndicatorClass is private), but a live
// instance carries the template-defining properties (calc / figures / series / …),
// so we copy those to register a fresh same-shape template under a new name. Only
// the template recipe is copied — per-instance STATE (result / visible / extendData
// / calcParams overrides) is applied separately by applyIndicator. Returns null if
// no live instance of that type exists to clone from.
function cloneTemplateFromLive(
  chart: Chart,
  type: string,
): Omit<IndicatorCreate, "name"> | null {
  const panes = chart.getIndicatorByPaneId() as
    | Map<string, Map<string, Indicator>>
    | null
    | undefined;
  for (const inds of panes?.values() ?? []) {
    for (const ind of inds.values()) {
      if (indTypeOf(ind) !== type) continue;
      return {
        shortName: ind.shortName,
        series: ind.series,
        precision: ind.precision,
        calcParams: [...(ind.calcParams ?? [])],
        shouldOhlc: ind.shouldOhlc,
        shouldFormatBigNumber: ind.shouldFormatBigNumber,
        minValue: ind.minValue,
        maxValue: ind.maxValue,
        // Copy the figure list shallowly so the two templates don't share array
        // identity (klinecharts may regenerate it per instance via regenerateFigures).
        figures: ind.figures.map((f) => ({ ...f })),
        styles: ind.styles ?? undefined,
        calc: ind.calc,
        regenerateFigures: ind.regenerateFigures,
        createTooltipDataSource: ind.createTooltipDataSource,
        draw: ind.draw,
      } as Omit<IndicatorCreate, "name">;
    }
  }
  return null;
}

// Register a per-instance template (a clone of the type's template under the
// instance id) so createIndicator accepts the id. Idempotent — re-registering the
// same name just overwrites with an identical clone.
//  - Custom types: clone our authored BASE_TEMPLATES.
//  - Built-in types: the bare type name is already registered by klinecharts (first
//    instance, id === type). For a SECOND+ instance we clone the template off a live
//    instance of the same type (see cloneTemplateFromLive) — that's how RSI/MACD/…
//    go multi-instance despite klinecharts hiding their templates.
function registerInstanceTemplate(chart: Chart, type: string, id: string): boolean {
  if (isCustomType(type)) {
    // Copy `figures` AND `styles.lines` so each instance owns its own arrays. A bare
    // shallow spread shared one figures array / styles.lines reference across every
    // instance of a custom type (and even across types — the default line arrays like
    // MA_DEFAULT_LINE_STYLES are reused), so klinecharts' per-instance regenerateFigures
    // and per-instance style edits corrupted siblings. Mirrors the figure copy the
    // built-in path makes in cloneTemplateFromLive.
    const base = BASE_TEMPLATES[type];
    const lines = base.styles?.lines;
    registerIndicator({
      ...base,
      name: id,
      figures: base.figures ? base.figures.map((f) => ({ ...f })) : base.figures,
      styles: base.styles
        ? { ...base.styles, ...(lines ? { lines: lines.map((l) => ({ ...l })) } : {}) }
        : base.styles,
    } as IndicatorTemplate);
    return true;
  }
  if (id === type) return getSupportedIndicators().includes(type);
  const tmpl = cloneTemplateFromLive(chart, type);
  if (!tmpl) return false;
  registerIndicator({ ...tmpl, name: id } as IndicatorTemplate);
  return true;
}

// Create one indicator INSTANCE on `chart`, restoring the persisted settings
// snapshot for `scope` keyed by the instance id. Returns the pane id or null.
//
// AVWAP carries a per-epic, per-instance anchor in calcParams[0]: on rehydrate we
// restore the saved anchor; on a fresh add we start UNPLACED (anchor 0 → no line)
// so the user clicks a bar to place it. Persisted line styles are applied via
// overrideIndicator (NOT createIndicator) because saved entries are partial
// ({color,size}) and override merges them onto the full default line style.
//
// `overrideExtend`/`overrideCalcParams` let Paste inject a copied config that isn't
// in storage yet (the snapshot is applied verbatim, indType is forced to `type`).
export function applyIndicator(
  chart: Chart,
  scope: string,
  epic: string,
  inst: IndicatorInstance,
  opts?: {
    rehydrate?: boolean;
    config?: SavedIndicatorConfig; // explicit snapshot (Paste) instead of storage
  },
): string | null {
  const { id, type } = inst;
  if (!registerInstanceTemplate(chart, type, id)) return null;
  const isOverlay = OVERLAY_INDICATORS.has(type);
  // Config resolution, in priority order:
  //  1. explicit config (Paste / Apply-preset injects a snapshot)
  //  2. this instance's own saved per-cell config
  //  3. the TYPE's global default preset — ONLY on a fresh add (not rehydrate), so
  //     it seeds new instances but never stomps an existing/rehydrated one whose
  //     config is simply absent (keeps existing charts byte-identical on reload).
  const cfg =
    opts?.config ??
    loadIndicatorConfigs(scope)[id] ??
    (opts?.rehydrate ? undefined : loadIndicatorDefault(type) ?? undefined);
  // Migrate stale saved calcParams to a new shorter default (e.g. an RSI saved
  // under the old three-length design → single length 14), so existing instances
  // pick up the TradingView shape on reload instead of redrawing three curves.
  const def = DEFAULT_CALC_PARAMS[type];
  if (cfg?.calcParams && def && cfg.calcParams.length > def.length) {
    cfg.calcParams = cfg.calcParams.slice(0, def.length);
  }
  // indType always reflects the real type; merge it over any saved/copied extendData.
  const extendData = { ...(cfg?.extendData ?? {}), indType: type };
  const value = {
    name: id,
    createTooltipDataSource: legendTooltipSource,
    extendData,
    ...(type === "AVWAP"
      ? { calcParams: [opts?.rehydrate ? loadAvwapAnchor(scope, epic, id) : (cfg?.calcParams?.[0] ?? 0)] }
      : cfg?.calcParams
        ? { calcParams: cfg.calcParams }
        : DEFAULT_CALC_PARAMS[type]
          ? { calcParams: DEFAULT_CALC_PARAMS[type] }
          : {}),
    ...(cfg?.visible === false ? { visible: false } : {}),
  };
  const paneId = chart.createIndicator(
    value,
    isOverlay, // stack on candle pane for overlays; own pane otherwise
    // Overlays stack on the candle pane; sub-pane indicators (RSI/MACD/…) get their
    // own pane with a taller default than klinecharts' cramped ~50px, so oscillators
    // read like TradingView's. The user can still drag the divider to resize.
    // `gap` trims klinecharts' default {top:0.2, bottom:0.1} empty margins so the
    // curve fills the pane (TV-style) instead of floating with dead space top/bottom.
    isOverlay
      ? { id: "candle_pane" }
      : { height: SUBPANE_HEIGHT, gap: { top: 0.08, bottom: 0.08 } },
  );
  if (!paneId) return null;
  // Saved line entries are partial ({color,size}); override merges them onto the
  // full default line style (DeepPartial — klinecharts fills style/dashedValue).
  if (cfg?.styles)
    chart.overrideIndicator(
      { name: id, styles: cfg.styles as unknown as Partial<IndicatorStyle> },
      paneId,
    );
  return paneId;
}

// Add a fresh instance of `type` (mints a new id). Returns the new instance, or
// null on failure. Used by the Toolbar menu (always-add) and Paste.
export function addIndicatorInstance(
  chart: Chart,
  scope: string,
  epic: string,
  type: string,
  opts?: { config?: SavedIndicatorConfig },
): IndicatorInstance | null {
  const inst: IndicatorInstance = { id: mintInstanceId(chart, type), type };
  if (!applyIndicator(chart, scope, epic, inst, { config: opts?.config })) return null;
  return inst;
}

// Remove an instance by its id across whichever pane holds it (the candle pane for
// overlays, a dedicated pane for RSI/MACD/etc.). Also drops its saved config.
export function removeIndicatorById(chart: Chart, scope: string, id: string): void {
  const panes = chart.getIndicatorByPaneId() as
    | Map<string, Map<string, Indicator>>
    | null
    | undefined;
  for (const [paneId, inds] of panes ?? []) {
    if (inds.has(id)) {
      chart.removeIndicator(paneId, id);
      break;
    }
  }
  deleteIndicatorConfig(scope, id);
}

// Rebuild a cell's saved instance set on a fresh chart. Returns the instances that
// were successfully restored (the caller mirrors them into controller.indicators).
export function hydrateIndicators(chart: Chart, scope: string, epic: string): IndicatorInstance[] {
  const restored: IndicatorInstance[] = [];
  for (const inst of loadIndicators(scope)) {
    if (applyIndicator(chart, scope, epic, inst, { rehydrate: true })) restored.push(inst);
  }
  return restored;
}
