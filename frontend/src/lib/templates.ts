// Per-symbol chart templates: capture a cell's layout (indicators + drawings) into
// a SymbolTemplate keyed by epic, and apply one back onto a (possibly different)
// cell. Built entirely on the existing apply/serialize machinery so behaviour
// matches normal mount hydration exactly:
//  - capture reads the PERSISTED cell blobs (kept current by OverlayManager.persist
//    / saveIndicators on every edit) — they're authoritative, no need to re-read the
//    live chart.
//  - apply writes those blobs into the TARGET cell's scope, then replays them with
//    the same applyIndicator loop hydrateIndicators uses + overlays.rehydrate().
//
// AVWAP anchors live outside SavedIndicatorConfig (under avwap.<epic>.<id>), so they
// are captured/restored explicitly — anchors are written BEFORE the indicators are
// applied so applyIndicator({rehydrate:true}) reads them.

import type { Chart } from "klinecharts";
import type { ChartController } from "./chartController";
import {
  loadIndicators,
  saveIndicators,
  loadIndicatorConfigs,
  saveIndicatorConfig,
  loadDrawings,
  saveDrawings,
  loadAvwapAnchor,
  saveAvwapAnchor,
  loadSymbolTemplate,
  loadDefaultTemplate,
  type SymbolTemplate,
  type DefaultTemplate,
} from "./persist";
import { applyIndicator, removeIndicatorById } from "./indicators";

// Snapshot a cell's current layout for `epic` into a template. Reads the persisted
// per-cell stores (authoritative), plus each AVWAP instance's separately-stored
// anchor. `savedAt` is stamped by the caller's clock (Date.now is fine in the
// browser; this module never runs in the journaled workflow env).
export function captureSymbolTemplate(scope: string, epic: string): SymbolTemplate {
  const indicators = loadIndicators(scope);
  const indicatorConfigs = loadIndicatorConfigs(scope);
  const drawings = loadDrawings(scope, epic);
  const avwapAnchors: Record<string, number> = {};
  for (const inst of indicators) {
    if (inst.type === "AVWAP") {
      const anchor = loadAvwapAnchor(scope, epic, inst.id);
      if (anchor) avwapAnchors[inst.id] = anchor;
    }
  }
  return { epic, indicators, indicatorConfigs, drawings, avwapAnchors, savedAt: Date.now() };
}

// Apply a template onto a cell. `clearFirst` removes the cell's current indicators
// before applying (used by the manual "Apply" button onto a populated cell);
// auto-apply passes clearFirst:false because the gate guarantees the cell is empty.
//
// Order is load-bearing: (1) AVWAP anchors written first so rehydrate picks them up,
// (2) the template blobs persisted into the target scope so a later reload sees a
// non-empty cell (auto-apply gate stays closed) and rehydrate has data to read,
// (3) replay onto the live chart via the same paths mount uses.
export function applySymbolTemplate(
  chart: Chart,
  controller: ChartController,
  scope: string,
  epic: string,
  t: SymbolTemplate,
  opts?: { clearFirst?: boolean },
): void {
  if (opts?.clearFirst) {
    for (const inst of controller.indicators.value) {
      removeIndicatorById(chart, scope, inst.id);
    }
    // Drawings are replaced wholesale below (saveDrawings + rehydrate removes the
    // live ones), so no separate clear needed.
  }

  // (1) AVWAP anchors into the target scope, before indicators are applied.
  for (const [id, ms] of Object.entries(t.avwapAnchors)) {
    saveAvwapAnchor(scope, epic, id, ms);
  }

  // (2) Persist the template blobs into the target cell scope.
  saveIndicators(scope, t.indicators);
  for (const [id, cfg] of Object.entries(t.indicatorConfigs)) {
    saveIndicatorConfig(scope, id, cfg);
  }
  saveDrawings(scope, epic, t.drawings);

  // (3) Replay onto the live chart. Indicators via the hydrateIndicators loop
  // (rehydrate:true so AVWAP anchors are read), drawings via the manager's
  // rehydrate (re-reads the loadDrawings we just wrote).
  const restored = t.indicators.filter((inst) =>
    applyIndicator(chart, scope, epic, inst, {
      rehydrate: true,
      config: t.indicatorConfigs[inst.id],
    }),
  );
  controller.indicators.set(restored);
  controller.overlays.rehydrate();
}

// --- global default template (symbol-agnostic) ------------------------------

// Snapshot a cell's indicators (+ their configs) into the GLOBAL default. Unlike
// captureSymbolTemplate this deliberately drops drawings and AVWAP anchors: the
// default applies to any symbol, where epic/price/time-specific data is
// meaningless. AVWAP instances are excluded entirely — an anchor-less AVWAP would
// land at an arbitrary bar — so the default is a clean set of symbol-agnostic
// indicators (Volume, RSI, MACD, …).
export function captureDefaultTemplate(scope: string): DefaultTemplate {
  const indicators = loadIndicators(scope).filter((inst) => inst.type !== "AVWAP");
  const allConfigs = loadIndicatorConfigs(scope);
  const indicatorConfigs: Record<string, SavedIndicatorConfig> = {};
  for (const inst of indicators) {
    if (allConfigs[inst.id]) indicatorConfigs[inst.id] = allConfigs[inst.id];
  }
  return { indicators, indicatorConfigs, savedAt: Date.now() };
}

// Apply the global default onto a cell. Reuses applySymbolTemplate by wrapping the
// default in a drawings-less / anchor-less SymbolTemplate shell bound to the
// target epic — the shared path writes empty drawings + no anchors, then replays
// the indicators exactly like a normal mount hydrate.
export function applyDefaultTemplate(
  chart: Chart,
  controller: ChartController,
  scope: string,
  epic: string,
  t: DefaultTemplate,
  opts?: { clearFirst?: boolean },
): void {
  applySymbolTemplate(
    chart,
    controller,
    scope,
    epic,
    {
      epic,
      indicators: t.indicators,
      indicatorConfigs: t.indicatorConfigs,
      drawings: [],
      avwapAnchors: {},
      savedAt: t.savedAt,
    },
    opts,
  );
}

// Auto-apply a default template to a FRESH cell only. Tries the per-symbol
// template first, then falls back to the GLOBAL default (symbol-agnostic) so
// staple indicators (Volume, …) appear on every fresh chart. Gate: the cell has
// zero saved indicators AND zero saved drawings for this epic — otherwise a reload
// of a populated/customized cell would clobber it, or double-apply alongside the
// normal mount hydrate. Returns true if a template was applied.
//
// Two nuances of the gate worth knowing:
//  - Indicators are CELL-scoped (no epic), drawings are EPIC-scoped. So a cell that
//    has only drawings (no indicators) and switches to a brand-new epic still passes
//    the gate and auto-applies — its old-epic drawings are untouched (separate key).
//    That's intentional: a never-touched epic in this cell IS fresh for templating.
//  - The gate can't distinguish "fresh cell" from "user deliberately cleared it", so
//    a fully-emptied cell will re-acquire the template on the next reload / symbol
//    change. Acceptable: the symbol's default is meant to be the baseline.
export function maybeAutoApplyTemplate(
  chart: Chart,
  controller: ChartController,
  scope: string,
  epic: string,
): boolean {
  if (loadIndicators(scope).length > 0 || loadDrawings(scope, epic).length > 0) return false;
  // Precedence: a per-symbol template (specific) wins over the global default
  // (general). Same empty-cell gate guards both; only one is applied.
  const t = loadSymbolTemplate(epic);
  if (t) {
    applySymbolTemplate(chart, controller, scope, epic, t, { clearFirst: false });
    return true;
  }
  const d = loadDefaultTemplate();
  if (d) {
    applyDefaultTemplate(chart, controller, scope, epic, d, { clearFirst: false });
    return true;
  }
  return false;
}
