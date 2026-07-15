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
import { registerIndicator, getSupportedIndicators, DomPosition } from "klinecharts";
import {
  OVERLAY_INDICATORS,
  BASE_TEMPLATES,
  legendTooltipSource,
  indTypeOf,
  SESSIONS_AXIS_NAME,
  type CustomIndicatorType,
} from "./customIndicators";
import { EQUITY_INDICATOR } from "./backtest";
import { planPaneReorder, reorderInstanceList } from "./paneOrder";
import {
  type VisibilityModel,
  defaultVisibility,
  isVisibleOnResolution,
} from "./visibility";
import {
  loadIndicators,
  loadIndicatorConfigs,
  saveIndicatorConfig,
  loadIndicatorDefault,
  loadAvwapAnchor,
  deleteIndicatorConfig,
  type IndicatorInstance,
  type SavedIndicatorConfig,
} from "./persist";

// True if adding this indicator TYPE opens its own bottom sub-pane (Volume/MACD/RSI…)
// rather than overlaying the candle pane (EMA/…). Used to auto-expand collapsed
// sub-panes when the user adds one (seeing a nothing after adding would be confusing).
export function isSubPaneIndicator(type: string): boolean {
  return !OVERLAY_INDICATORS.has(type);
}

const CUSTOM_TYPES = Object.keys(BASE_TEMPLATES) as CustomIndicatorType[];
const isCustomType = (type: string): type is CustomIndicatorType =>
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

// Default calcParams for built-in klinecharts indicator TYPES that we don't
// override above and that aren't one of our custom types (those carry their
// own defaults in BASE_TEMPLATES). Needed because an indicator whose settings
// modal was merely opened gets its calcParams eagerly persisted from the LIVE
// instance (IndicatorSettings.tsx), which for a built-in type is klinecharts'
// own default — so the template-merge signature comparison (templates.ts) must
// know that same default to recognize the saved config as a no-op and avoid
// treating it as a different indicator than an unconfigured template entry.
//
// Values verified against the INSTALLED klinecharts package (not from memory):
// frontend/node_modules/klinecharts/dist/index.esm.js, each indicator's own
// `calcParams: [...]` literal a few lines below its `name: '<TYPE>'` line (v9,
// as of this fix). Every built-in type the app's indicator menu can add is
// covered (Toolbar.tsx's menu is literally `getSupportedIndicators()`, i.e. ALL
// registered types minus per-instance "#" ids and our own custom overrides).
const BUILTIN_CALC_PARAMS: Record<string, number[]> = {
  AO: [5, 34], // index.esm.js ~L2322 (name 'AO' ~L2320)
  BIAS: [6, 12, 24], // ~L2394 (name ~L2392)
  BOLL: [20, 2], // ~L2461 (name ~L2458)
  BRAR: [26], // ~L2514 (name ~L2512)
  BBI: [3, 6, 12, 24], // ~L2574 (name ~L2570)
  CCI: [20], // ~L2631 (name ~L2629)
  CR: [26, 10, 20, 40, 60], // ~L2693 (name ~L2691)
  DMA: [10, 50, 10], // ~L2789 (name ~L2787)
  DMI: [14, 6], // ~L2873 (name ~L2871)
  EMV: [14, 9], // ~L2980 (name ~L2978)
  MTM: [12, 6], // ~L3094 (name ~L3092)
  MACD: [12, 26, 9], // ~L3199 (name ~L3197)
  OBV: [30], // ~L3297 (name ~L3295)
  PSY: [12, 6], // ~L3394 (name ~L3392)
  ROC: [12, 6], // ~L3447 (name ~L3445)
  SMA: [12, 2], // ~L3572 (name ~L3569)
  KDJ: [9, 3, 3], // ~L3624 (name ~L3622)
  SAR: [2, 2, 20], // ~L3670 (name ~L3667)
  TRIX: [12, 9], // ~L3781 (name ~L3779)
  VOL: [5, 10, 20], // ~L3881 (name ~L3878)
  VR: [26, 6], // ~L3942 (name ~L3940)
  WR: [6, 10, 14], // ~L4022 (name ~L4020)
  // AVP and PVT ship with NO `calcParams` key at all in their template objects
  // (verified: no `calcParams:` literal near `name: 'AVP'` ~L2281 or
  // `name: 'PVT'` ~L3349) — klinecharts' base Indicator constructor defaults an
  // absent template calcParams to `[]` (index.esm.js ~L1042:
  // `this.calcParams = calcParams ?? []`). Listed explicitly (not left to the
  // `undefined` fallback) so a settings-opened instance — which persists the
  // LIVE `[]` — normalizes to the SAME `[]` a config-less template entry
  // produces, instead of comparing `[]` against `undefined`.
  AVP: [],
  PVT: [],
};

// The EFFECTIVE default calcParams for a type when an instance carries no saved
// config: our TradingView-shape overrides first (RSI → [14]), then the custom
// template's own defaults (EMA → [9], MA → [20], LR → [100,2], …), then
// klinecharts' own built-in defaults (MACD → [12,26,9], BOLL → [20,2], …) for
// every other registered type. Both sides of a template-merge signature
// comparison normalize through this same function, so a config-less template
// entry matches a settings-opened instance whose persisted calcParams happen to
// equal the same default. Used by templates.ts's savedIndicatorSignature (via
// effectiveCalcParams below).
export function defaultCalcParams(type: string): number[] | undefined {
  return (
    DEFAULT_CALC_PARAMS[type] ??
    (isCustomType(type)
      ? (BASE_TEMPLATES[type].calcParams as number[] | undefined)
      : BUILTIN_CALC_PARAMS[type])
  );
}

// The EFFECTIVE calcParams for a type given an instance's saved value (or
// undefined if it has none): mirrors applyIndicator's own stale-config
// migration (below, ~L312) — a saved array longer than a DEFAULT_CALC_PARAMS
// override (e.g. a legacy RSI's [6,12,24] against the override's [14]) is
// sliced down to that length, since that's what actually ends up on the live
// chart. Falls back to defaultCalcParams(type) when there's no saved value at
// all. templates.ts's savedIndicatorSignature uses this (not defaultCalcParams
// directly) so the merge identity sees the same params applyIndicator would
// actually create, not the raw stored value.
export function effectiveCalcParams(type: string, saved?: number[]): number[] | undefined {
  const def = DEFAULT_CALC_PARAMS[type];
  if (saved && def && saved.length > def.length) return saved.slice(0, def.length);
  return saved ?? defaultCalcParams(type);
}

// Default height (CSS px) for a sub-pane indicator's own pane. klinecharts' default
// is a cramped ~50px; TradingView gives oscillators much more room, so new sub-panes
// (RSI/MACD/…) open taller. Users can still drag the pane divider to resize.
const SUBPANE_HEIGHT = 120;

// The Sessions indicator is a fixed compact strip (not a resizable oscillator): a
// short pane, no numeric y-axis, drag disabled. minHeight is passed explicitly so
// the sub-30px height isn't clamped by PANE_MIN_HEIGHT.
const SESSIONS_PANE_HEIGHT = 26;
function isFixedCompact(type: string): boolean {
  return type === "SESSIONS";
}

// Panes the reorder feature must never touch: the candle pane is handled by paneId,
// and the backtest equity curve is app-owned. Exported so ChartLegend filters on the
// SAME set — the legend's card index and this engine's reorderable order both exclude
// these, and they must agree or arrow/menu moves go off-by-one. One definition, no drift.
export const INTERNAL_INDICATORS = new Set<string>([EQUITY_INDICATOR]);

// A reorderable sub-pane captured before teardown: its id, current height, and the
// ordered indicator instances it holds (usually one; a multi-indicator pane moves whole).
interface PaneSnapshot {
  paneId: string;
  height: number;
  insts: IndicatorInstance[];
}

// Enumerate the reorderable bottom panes top-to-bottom (skip candle_pane and panes
// holding only internal indicators), capturing each pane's height + instances.
function reorderablePanes(chart: Chart): PaneSnapshot[] {
  const all = chart.getIndicatorByPaneId() as
    | Map<string, Map<string, Indicator>>
    | null
    | undefined;
  const out: PaneSnapshot[] = [];
  for (const [paneId, inds] of all ?? []) {
    if (paneId === "candle_pane") continue;
    const insts: IndicatorInstance[] = [];
    for (const ind of inds.values()) {
      if (!ind?.name || INTERNAL_INDICATORS.has(ind.name)) continue;
      insts.push({ id: ind.name, type: indTypeOf(ind) });
    }
    if (!insts.length) continue; // internal-only pane (e.g. equity) — not reorderable
    const height = Math.round(chart.getSize(paneId, DomPosition.Main)?.height ?? SUBPANE_HEIGHT);
    out.push({ paneId, height, insts });
  }
  return out;
}

// The reorderable sub-pane ids, top-to-bottom. Used by the UI to compute a pane's
// current position (for Move up/down enablement and the drag drop-slot).
export function subPaneOrder(chart: Chart): string[] {
  return reorderablePanes(chart).map((p) => p.paneId);
}

// Reorder the bottom sub-panes so `movingPaneId` lands at `targetIndex`. klinecharts
// has no pane-move API, so we tear down the panes from the first divergence point down
// and recreate them (via applyIndicator, rehydrating each instance's saved config and
// preserving its pane height) in the new order — they re-append below the untouched
// head panes. Returns the new full instance list for the caller to persist, or null on
// a no-op. NOTE: the equity pane, if present, is left in place and may end up above the
// reordered user panes; acceptable for the transient backtest pane.
export function reorderSubPanes(
  chart: Chart,
  scope: string,
  epic: string,
  current: IndicatorInstance[],
  movingPaneId: string,
  targetIndex: number,
): IndicatorInstance[] | null {
  const panes = reorderablePanes(chart);
  const plan = planPaneReorder(panes.map((p) => p.paneId), movingPaneId, targetIndex);
  if (!plan) return null;
  const { desired, divIndex } = plan;
  const byId = new Map(panes.map((p) => [p.paneId, p]));

  // Tear down every reorderable pane from the divergence point down (current order).
  for (const p of panes.slice(divIndex))
    for (const inst of p.insts) chart.removeIndicator(p.paneId, inst.id);

  // Recreate them in desired order; each opens a fresh pane appended at the bottom.
  // A multi-indicator pane is regrouped here (2nd+ instance stacks via opts.paneId),
  // but note hydrateIndicators recreates each persisted instance in its OWN pane — so a
  // multi-indicator pane's grouping does NOT round-trip through a reload today. Harmless
  // now (every createIndicator mints its own pane, so such panes don't exist); revisit
  // if a future feature lets several indicators share one sub-pane.
  for (const paneId of desired.slice(divIndex)) {
    const snap = byId.get(paneId);
    if (!snap) continue;
    let newPaneId: string | null = null;
    snap.insts.forEach((inst, i) => {
      const pid = applyIndicator(chart, scope, epic, inst, {
        rehydrate: true,
        ...(i === 0 ? { height: snap.height } : { paneId: newPaneId ?? undefined }),
      });
      if (i === 0) newPaneId = pid;
    });
  }

  const newSubOrderIds = desired.flatMap((pid) => byId.get(pid)?.insts.map((x) => x.id) ?? []);
  return reorderInstanceList(current, newSubOrderIds);
}

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
    // Reorder support: stack this instance into an existing pane (2nd+ indicator of a
    // moved multi-indicator pane), and/or open a fresh sub-pane at a preserved height.
    paneId?: string;
    height?: number;
    // The sidebar's master "Hide indicators" switch is on: create this instance
    // hidden (a one-shot applyIndicatorVisibility sweep can't catch indicators added
    // after it ran). Intent is seeded into extendData.userVisible so the switch
    // turning off restores what the indicator would have shown.
    forceHidden?: boolean;
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
  // The slice rule lives in effectiveCalcParams — the ONE source of truth the
  // template-merge signature also normalizes through, so what lands on the chart
  // and what the merge identity sees can never drift apart.
  if (cfg?.calcParams) {
    cfg.calcParams = effectiveCalcParams(type, cfg.calcParams);
  }
  // indType always reflects the real type; merge it over any saved/copied extendData.
  const extendData: { userVisible?: boolean; indType: string } = {
    ...(cfg?.extendData ?? {}),
    indType: type,
  };
  if (opts?.forceHidden && extendData.userVisible === undefined) {
    extendData.userVisible = cfg?.visible !== false;
  }
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
    ...(opts?.forceHidden || cfg?.visible === false ? { visible: false } : {}),
  };
  // Overlays stack on the candle pane; sub-pane indicators (RSI/MACD/…) get their own
  // pane with a taller default than klinecharts' cramped ~50px, so oscillators read
  // like TradingView's (unless a preserved height is passed in via opts.height). The
  // user can still drag the divider to resize. `gap` trims klinecharts' default
  // {top:0.2, bottom:0.1} empty margins so the curve fills the pane (TV-style) instead
  // of floating with dead space top/bottom. `opts.paneId` stacks this instance into an
  // already-recreated pane (2nd+ indicator of a moved multi-indicator pane).
  const stack = isOverlay || !!opts?.paneId;
  const paneOptions = opts?.paneId
    ? { id: opts.paneId } // stack into the just-recreated pane of a moved group
    : isOverlay
      ? { id: "candle_pane" }
      : isFixedCompact(type)
        ? {
            // Fixed compact strip: short, no numeric y-axis, drag disabled. minHeight
            // is explicit so the sub-30px height isn't clamped by PANE_MIN_HEIGHT.
            height: opts?.height ?? SESSIONS_PANE_HEIGHT,
            minHeight: 20,
            dragEnabled: false,
            gap: { top: 0, bottom: 0 },
            axisOptions: { name: SESSIONS_AXIS_NAME },
          }
        : { height: opts?.height ?? SUBPANE_HEIGHT, gap: { top: 0.08, bottom: 0.08 } };
  const paneId = chart.createIndicator(value, stack, paneOptions);
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

// Re-derive every indicator's effective on-chart visibility: user intent
// (extendData.userVisible, default true) AND the interval model matches the current
// resolution AND the sidebar eye menu's "Hide indicators" master switch isn't masking
// it. The internal EQUITY backtest pane is not a user indicator — left untouched.
// Mirrors OverlayManager.applyIntervalVisibility for drawings. Iterates ALL panes via
// chart.getIndicatorByPaneId() with no args (every pane's indicator map; klinecharts
// has no getPanes()/no-name-per-pane API). A VIEW reaction, not a user edit: it never
// persists (intent already lives in extendData, written by the settings modal).
//
// This is masking-in-place (the pane stays, the curve is hidden) — the sidebar eye.
// The double-click "hide bottom sub-panes" gesture is a DIFFERENT operation that frees
// the pane's HEIGHT: see collapseSubPanes/expandSubPanes below.
export function applyIndicatorVisibility(chart: Chart, resolution: string, allHidden: boolean): void {
  const panes = chart.getIndicatorByPaneId() as
    | Map<string, Map<string, Indicator>>
    | null
    | undefined;
  for (const [paneId, inds] of panes ?? []) {
    for (const ind of inds.values()) {
      if (!ind?.name || INTERNAL_INDICATORS.has(ind.name)) continue;
      const ext = (ind.extendData ?? {}) as { userVisible?: boolean; visibility?: VisibilityModel };
      const intent = ext.userVisible ?? ind.visible ?? true;
      const model = ext.visibility ?? defaultVisibility();
      const visible = !allHidden && intent && isVisibleOnResolution(model, resolution);
      // Record intent BEFORE the first mask forces the live flag off: un-masking
      // derives intent as userVisible ?? visible, and an indicator never individually
      // toggled has no userVisible yet — its forced-false flag would read back as
      // intent and the indicator would stay hidden after the mask lifts. Only seed
      // while masking a never-toggled indicator.
      const seed =
        allHidden && ext.userVisible === undefined
          ? { extendData: { ...ext, userVisible: ind.visible ?? true } }
          : {};
      chart.overrideIndicator({ name: ind.name, visible, ...seed }, paneId);
    }
  }
}

// klinecharts' default pane minHeight (PANE_MIN_HEIGHT), restored when un-collapsing.
const PANE_MIN_HEIGHT = 30;
// A sub-pane at/below this height (px) reads as collapsed, not user-sized — used to
// avoid re-capturing a 1px height as if it were the real one (see collapseSubPanes).
export const COLLAPSED_PANE_HEIGHT = 3;

// Double-click "hide bottom sub-panes": collapse every reorderable sub-pane
// (Volume/MACD/RSI…) to ~0px so the candle pane reclaims the height — plain
// visibility-hiding leaves the empty pane band, which the user explicitly didn't want.
// klinecharts ignores height:0 (it requires >0), so we use 1px + minHeight:0 and
// disable the divider drag. Returns the captured prior heights keyed by paneId for
// expandSubPanes to restore. The internal EQUITY pane is left alone (reorderablePanes
// skips it). MUST be called from a fully-expanded state so it captures real heights;
// a pane already at ~1px is recorded as SUBPANE_HEIGHT so a stray re-capture can't
// freeze it collapsed forever.
export function collapseSubPanes(chart: Chart): Map<string, number> {
  const heights = new Map<string, number>();
  for (const p of reorderablePanes(chart)) {
    heights.set(p.paneId, p.height > COLLAPSED_PANE_HEIGHT ? p.height : SUBPANE_HEIGHT);
    chart.setPaneOptions({ id: p.paneId, height: 1, minHeight: 0, dragEnabled: false });
  }
  return heights;
}

// Re-assert the collapse WITHOUT capturing heights — for the resolution/rehydrate
// re-assert, where the live panes may already be at 1px (a plain interval switch) or
// freshly recreated at the default height (a symbol switch). Either way the caller's
// saved height map is the source of truth for restore, so we must not overwrite it.
export function forceCollapseSubPanes(chart: Chart): void {
  for (const p of reorderablePanes(chart))
    chart.setPaneOptions({ id: p.paneId, height: 1, minHeight: 0, dragEnabled: false });
}

// Un-collapse: restore each sub-pane to its captured height (or the default for a pane
// created/recreated while collapsed, whose id isn't in the map), re-enabling the
// divider drag and the normal min height.
export function expandSubPanes(chart: Chart, heights: Map<string, number>): void {
  for (const p of reorderablePanes(chart))
    chart.setPaneOptions({
      id: p.paneId,
      height: heights.get(p.paneId) ?? SUBPANE_HEIGHT,
      minHeight: PANE_MIN_HEIGHT,
      dragEnabled: true,
    });
}

// Add a fresh instance of `type` (mints a new id). Returns the new instance, or
// null on failure. Used by the Toolbar menu (always-add) and Paste.
export function addIndicatorInstance(
  chart: Chart,
  scope: string,
  epic: string,
  type: string,
  opts?: { config?: SavedIndicatorConfig; forceHidden?: boolean },
): IndicatorInstance | null {
  const inst: IndicatorInstance = { id: mintInstanceId(chart, type), type };
  if (!applyIndicator(chart, scope, epic, inst, { config: opts?.config, forceHidden: opts?.forceHidden }))
    return null;
  // Paste (and any caller injecting a snapshot) applies the config LIVE but it must
  // also be persisted under the freshly-minted id. Otherwise a later teardown +
  // recreate (pane reorder, or a plain reload) rehydrates with no saved config and
  // falls back to the bare template, silently resetting the pasted settings. Mirrors
  // the save-after-apply the template/snapshot paths do (templates.ts, snapshots.ts).
  if (opts?.config) saveIndicatorConfig(scope, inst.id, opts.config);
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
