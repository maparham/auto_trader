// Per-symbol chart templates: capture a cell's layout (indicators + drawings) into
// a SymbolTemplate keyed by epic, and apply one back onto a (possibly different)
// cell. Built entirely on the existing apply/serialize machinery so behaviour
// matches normal mount hydration exactly:
//  - capture reads the PERSISTED cell blobs (kept current by OverlayManager.persist
//    / saveIndicators on every edit) — they're authoritative, no need to re-read the
//    live chart.
//  - apply is an ADDITIVE MERGE onto the TARGET cell's scope: each template
//    indicator/drawing is compared by identity signature against what's already
//    there and added only if missing — existing instances are never modified or
//    removed (see docs/superpowers/specs/2026-07-02-template-apply-merge-design.md).
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
  type SavedIndicatorConfig,
  type IndicatorInstance,
} from "./persist";
import {
  applyIndicator,
  mintInstanceId,
  effectiveCalcParams,
  isSubPaneIndicator,
  removeIndicatorById,
} from "./indicators";
import {
  indicatorSignature,
  drawingSignature,
  type IndicatorIdentity,
} from "./templateSignatures";
import { withLayoutEventsSuppressed } from "./persist/layoutEvents";

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

// The identity signature of one saved instance, from its stored config and (for
// AVWAP) its separately-stored anchor. calcParams go through effectiveCalcParams
// so BOTH an absent config (→ the type's default) AND a saved-but-stale config
// (→ migrated/sliced the same way applyIndicator would) normalize to what would
// actually land on the chart — so a default-length EMA matches a default-length
// EMA, and a legacy 3-length RSI matches a fresh single-length RSI. AVWAP is
// special: its calcParams[0] IS the anchor (never meaningfully stored in
// config), so identity uses the anchor field instead — 0/absent normalizes to
// undefined so two unplaced AVWAPs match.
function savedIndicatorSignature(
  inst: IndicatorInstance,
  cfg: SavedIndicatorConfig | undefined,
  anchor: number | undefined,
): string {
  const identity: IndicatorIdentity = {
    type: inst.type,
    calcParams:
      inst.type === "AVWAP" ? undefined : effectiveCalcParams(inst.type, cfg?.calcParams),
    extendData: cfg?.extendData,
    anchor: inst.type === "AVWAP" && anchor ? anchor : undefined,
  };
  return indicatorSignature(identity);
}

// Add one template indicator instance to the cell under a freshly-minted id.
// The ordering is load-bearing and shared by BOTH apply paths (additive merge
// and exact-look replace): the AVWAP anchor is written BEFORE applyIndicator
// (rehydrate:true reads it from storage), the config is written only after
// success, and a failed add zeroes back any anchor it pre-wrote so a rejected
// AVWAP doesn't leave a placed-anchor orphan under an id no instance ever used.
// Returns the new instance, or null if the add failed.
function addTemplateIndicator(
  chart: Chart,
  controller: ChartController,
  scope: string,
  epic: string,
  t: SymbolTemplate,
  inst: IndicatorInstance,
): IndicatorInstance | null {
  const id = mintInstanceId(chart, inst.type);
  const anchor = t.avwapAnchors[inst.id];
  if (anchor) saveAvwapAnchor(scope, epic, id, anchor);
  const cfg = t.indicatorConfigs[inst.id];
  const ok = applyIndicator(chart, scope, epic, { id, type: inst.type }, {
    rehydrate: true,
    config: cfg,
    // Honor the cell's master "Hide indicators" switch — a template applied
    // while it's on must not repaint indicators the sidebar eye says are hidden.
    forceHidden: controller.indicatorsHidden.value,
  });
  if (!ok) {
    if (anchor) saveAvwapAnchor(scope, epic, id, 0); // undo the pre-write
    return null;
  }
  if (cfg) saveIndicatorConfig(scope, id, cfg);
  return { id, type: inst.type };
}

// Apply a template onto a cell — ADDITIVE MERGE, existing wins (see
// docs/superpowers/specs/2026-07-02-template-apply-merge-design.md). For each
// template indicator/drawing we compute its identity signature and add it only
// if no equivalent is already on the chart; matched items are skipped entirely
// (the existing instance keeps its id, config and styling). Nothing is ever
// modified or removed, so Apply is idempotent and can never destroy user work
// (the old replace-and-clear semantics silently wiped drawings when the
// template held none).
//
// Order per added indicator is load-bearing: its AVWAP anchor is written BEFORE
// applyIndicator (rehydrate:true reads the anchor from storage); its config is
// written after success (applyIndicator gets it explicitly via opts.config, and
// a failed add must not leave an orphaned config behind). A failed add also
// zeroes back out any anchor it pre-wrote, so a rejected AVWAP doesn't leave a
// placed-anchor orphan under an id no instance ever used.
export function applySymbolTemplate(
  chart: Chart,
  controller: ChartController,
  scope: string,
  epic: string,
  t: SymbolTemplate,
): void {
  // Suppress layout-change events for the whole merge: apply mints NEW instance
  // ids, so letting these writes fire would make auto-save capture a re-id'd copy
  // and churn the stored template on every apply/auto-apply.
  withLayoutEventsSuppressed(() => {
  // --- indicators: add what's missing, never touch what exists ---------------
  const existing = loadIndicators(scope);
  const existingCfgs = loadIndicatorConfigs(scope);
  const have = new Set(
    existing.map((inst) =>
      savedIndicatorSignature(inst, existingCfgs[inst.id], loadAvwapAnchor(scope, epic, inst.id)),
    ),
  );

  const added: IndicatorInstance[] = [];
  for (const inst of t.indicators) {
    const sig = savedIndicatorSignature(inst, t.indicatorConfigs[inst.id], t.avwapAnchors[inst.id]);
    if (have.has(sig)) continue; // an equivalent indicator is already on the chart
    have.add(sig); // two identical template rows still add only once
    // Fresh id in the target cell — the template's id may collide with an
    // existing instance (ids are the bare type name or a random suffix).
    const addedInst = addTemplateIndicator(chart, controller, scope, epic, t, inst);
    if (addedInst) added.push(addedInst);
  }
  if (added.length > 0) {
    const full = [...existing, ...added];
    saveIndicators(scope, full);
    controller.indicators.set(full);
    // A template that brings in any sub-pane indicator auto-expands collapsed bottom
    // panes (mirrors a manual add) so the applied layout is actually visible.
    if (controller.subPanesHidden.value && added.some((a) => isSubPaneIndicator(a.type)))
      controller.subPanesHidden.set(false);
  }

  // --- drawings: union by geometry, never remove ------------------------------
  const existingDrawings = loadDrawings(scope, epic);
  const haveDrawings = new Set(existingDrawings.map(drawingSignature));
  const newDrawings = t.drawings.filter((d) => {
    const sig = drawingSignature(d);
    if (haveDrawings.has(sig)) return false;
    haveDrawings.add(sig);
    return true;
  });
  if (newDrawings.length > 0) {
    saveDrawings(scope, epic, [...existingDrawings, ...newDrawings]);
    // Rebuild the live overlays from the union we just wrote. Skipped when
    // nothing was added — a rehydrate re-mints overlay ids and drops selection,
    // so a no-op Apply must not churn the chart.
    controller.overlays.rehydrate();
    // A template drawing can be anchored before the loaded history window —
    // page the older bars in (ChartCore's coverage walk) or it renders clamped
    // to the first loaded bar with the wrong slope.
    controller.coverDrawingAnchors?.();
  }
  });
}

// Apply a template onto a cell as its EXACT look — the replace-on-open path
// (spec: docs/superpowers/specs/2026-07-17-symbol-look-follows-template-design.md).
// Unlike the additive applySymbolTemplate (manual Apply, never destroys), this
// makes the cell end up exactly like the template: signature-matched existing
// instances are KEPT untouched (no id/config/styling churn), unmatched ones are
// removed, missing ones added, and the epic's drawings become the template's
// drawings verbatim. Safe because the caller has already captured the outgoing
// look into ITS template (flushTemplateCapture) — nothing is destroyed, it
// travels with its own symbol.
export function replaceSymbolTemplate(
  chart: Chart,
  controller: ChartController,
  scope: string,
  epic: string,
  t: SymbolTemplate,
): void {
  withLayoutEventsSuppressed(() => {
    // --- indicators: keep matched, remove extra, add missing -----------------
    const existing = loadIndicators(scope);
    const existingCfgs = loadIndicatorConfigs(scope);
    // Multiset of wanted looks: signature -> template instances not yet matched
    // (two identical template rows need two live instances).
    const want = new Map<string, IndicatorInstance[]>();
    for (const inst of t.indicators) {
      const sig = savedIndicatorSignature(inst, t.indicatorConfigs[inst.id], t.avwapAnchors[inst.id]);
      const q = want.get(sig) ?? [];
      q.push(inst);
      want.set(sig, q);
    }
    const kept: IndicatorInstance[] = [];
    for (const inst of existing) {
      const sig = savedIndicatorSignature(inst, existingCfgs[inst.id], loadAvwapAnchor(scope, epic, inst.id));
      const q = want.get(sig);
      if (q && q.length > 0) {
        q.shift();
        kept.push(inst);
      } else {
        removeIndicatorById(chart, scope, inst.id);
        // Don't leave a placed anchor behind under a dead id for this epic.
        if (inst.type === "AVWAP") saveAvwapAnchor(scope, epic, inst.id, 0);
      }
    }
    const added: IndicatorInstance[] = [];
    for (const q of want.values()) {
      for (const inst of q) {
        const addedInst = addTemplateIndicator(chart, controller, scope, epic, t, inst);
        if (addedInst) added.push(addedInst);
      }
    }
    const full = [...kept, ...added];
    saveIndicators(scope, full);
    controller.indicators.set(full);
    if (controller.subPanesHidden.value && added.some((a) => isSubPaneIndicator(a.type)))
      controller.subPanesHidden.set(false);

    // --- drawings: the epic's set becomes exactly the template's -------------
    // Order-sensitive signature compare skips the rewrite (and the id-minting
    // rehydrate, which would drop selection) when the look is already exact.
    const existingDrawings = loadDrawings(scope, epic);
    const same =
      existingDrawings.length === t.drawings.length &&
      existingDrawings.every((d, i) => drawingSignature(d) === drawingSignature(t.drawings[i]));
    if (!same) {
      saveDrawings(scope, epic, t.drawings);
      controller.overlays.rehydrate();
      controller.coverDrawingAnchors?.();
    }
  });
}

// --- global default template (symbol-agnostic) ------------------------------

// Snapshot a cell's indicators (+ their configs) into the GLOBAL default. Unlike
// captureSymbolTemplate this deliberately drops drawings and AVWAP anchors: the
// default applies to any symbol, where epic/price/time-specific data is
// meaningless. AVWAP instances are excluded entirely — an anchor-less AVWAP would
// land at an arbitrary bar — so the default is a clean set of symbol-agnostic
// indicators (Volume, RSI, MACD, …).
export function captureDefaultTemplate(
  scope: string,
  includeIds?: Set<string>,
): DefaultTemplate {
  const indicators = loadIndicators(scope)
    .filter((inst) => inst.type !== "AVWAP")
    .filter((inst) => !includeIds || includeIds.has(inst.id));
  const allConfigs = loadIndicatorConfigs(scope);
  const indicatorConfigs: Record<string, SavedIndicatorConfig> = {};
  for (const inst of indicators) {
    if (allConfigs[inst.id]) indicatorConfigs[inst.id] = allConfigs[inst.id];
  }
  return { indicators, indicatorConfigs, savedAt: Date.now() };
}

// Apply the global default onto a cell. Reuses applySymbolTemplate by wrapping the
// default in a drawings-less / anchor-less SymbolTemplate shell bound to the
// target epic — the shared path merges the indicators in and, with an empty
// drawings list, touches no drawings — so applying the default can never affect
// existing drawings.
export function applyDefaultTemplate(
  chart: Chart,
  controller: ChartController,
  scope: string,
  epic: string,
  t: DefaultTemplate,
): void {
  applySymbolTemplate(chart, controller, scope, epic, {
    epic,
    indicators: t.indicators,
    indicatorConfigs: t.indicatorConfigs,
    drawings: [],
    avwapAnchors: {},
    savedAt: t.savedAt,
  });
}

// Make a cell LOOK like `epic`'s saved template on open. Two modes:
//  - opts.replace (a real symbol SWITCH whose outgoing look was just captured
//    by flushTemplateCapture): exact-look replace, even onto a populated cell —
//    safe because the capture means nothing on the chart is un-saved.
//  - default (mount / reload / autosave-off): only a completely FRESH cell (no
//    indicators, no drawings for this epic) gets the template. A populated cell
//    is left exactly as persisted — its content may hold edits no template ever
//    captured (autosave off, pre-reload debounce, a sibling cell on the same
//    epic), and replacing here would destroy them.
// No per-symbol template → fresh cell falls back to the GLOBAL default
// (symbol-agnostic staples). Returns true if a template was applied.
export function applyLookOnOpen(
  chart: Chart,
  controller: ChartController,
  scope: string,
  epic: string,
  opts?: { replace?: boolean },
): boolean {
  const fresh = loadIndicators(scope).length === 0 && loadDrawings(scope, epic).length === 0;
  const t = loadSymbolTemplate(epic);
  if (t && (opts?.replace || fresh)) {
    replaceSymbolTemplate(chart, controller, scope, epic, t);
    return true;
  }
  if (!fresh) return false;
  const d = loadDefaultTemplate();
  if (d) {
    applyDefaultTemplate(chart, controller, scope, epic, d);
    return true;
  }
  return false;
}
