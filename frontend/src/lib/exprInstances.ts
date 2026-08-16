// The bridge between the chart's live indicator panes and the expression layer.
//
// Two directions, both pure (no klinecharts — the chart adapters that produce
// `LiveInstance[]` live in indicators.ts, where klinecharts already is):
//
//   1. OUT to the backend — `collectExprInstances(live, rows)` collects the panes
//      the rows actually reference, for the request's `indicators` map. Rules name
//      an instance's OUTPUT (`SLOPE.9`) and carry none of its settings, so the
//      backend needs the config to recompute over any window (a backtest window
//      routinely exceeds the chart's loaded candles).
//   2. IN to the editor — `exprInstancesFor(live)` is the injected list `analyze`
//      and the completion source read, so a pane's own settings stay the single
//      source of truth for which outputs exist.
import { normalizeSlopeUnit, slopeOutputs, slopeWarmup } from "./indicators/slopeOutputs";
import type { SlopeExtend } from "./indicators/slope"; // erased at build; no runtime edge
import { atrOutputs, atrWarmup, normalizeAtrSmoothing, normalizeAtrPctSource, ATR_SMOOTHING_LABEL, type AtrExtend } from "./atr";
import { FVG_OUTPUTS, fvgWarmup, parseFvgConfig } from "./indicators/fvgOutputs";
import type { FvgExtend } from "./indicators/fvg"; // erased at build; no runtime edge
import type { ExprInstance } from "./expr/catalog";
// Display vocabularies, both from klinecharts-free modules so this stays a pure,
// node-testable bridge: mtf.ts type-imports klinecharts only, indicatorMeta.ts
// imports nothing at all.
import { MA_KIND_LABEL, normalizeMaKind } from "./mtf";
import { SLOPE_UNIT_LABEL } from "./indicatorMeta";

/** The pane types a rule can reference by instance (`<id>.<output>`). The ONE
 * list — mintInstanceId (indicators.ts) consults it to avoid minting ids that
 * collide with expr function names. The per-type branches in `exprInstancesFor`
 * and `exprWarmupByRef` below must stay in step with it. */
export const EXPR_INSTANCE_TYPES: ReadonlySet<string> = new Set(["SLOPE", "ATR", "FVG"]);

/** A live chart pane, flattened to just what the expression layer reads. */
export interface LiveInstance {
  id: string;
  type: string;
  calcParams?: number[];
  extendData?: unknown;
}

/** One entry of the request's `indicators` map (backend IndicatorInstanceDTO). */
export interface ExprInstancePayload {
  type: string;
  calcParams: number[];
  extendData: unknown;
}

// <instanceId>.<output> — the id may carry the "#<rand>" uniqueness suffix that
// mintInstanceId adds to a second-or-later instance of a type. The trailing
// "\b(?!\s*\()" drops a dotted CALL (the \b first, so the output name can't
// backtrack to a shorter match and slip past the lookahead).
//
// The OUTPUT group takes digits, because a SLOPE pane's outputs are named by
// its MA lengths (`SLOPE.9`, `SLOPE.accel50`). What keeps a decimal literal
// (`0.5`) out is the INSTANCE group's leading `[A-Za-z_]` — a bare number can
// never start a match — and a field read off a call result (`EMA(9).signal`)
// stays out because the char before its dot is ")", which no group accepts.
const REF = /\b([A-Za-z_][A-Za-z0-9_]*(?:#[A-Za-z0-9_]+)?)\.([A-Za-z0-9_]+)\b(?!\s*\()/g;

/**
 * Rewrite `<instance>.<output>` references per `idMap` (old id → new id),
 * leaving everything else — calls, `candle.*`, unmapped ids — untouched. Used
 * when pasting copied rules recreates their indicator panes under fresh ids
 * (the copied id was taken by a differently-configured pane on this chart).
 */
export function rewriteInstanceRefs(expr: string, idMap: Readonly<Record<string, string>>): string {
  return expr.replace(REF, (whole, id: string, output: string) => {
    const next = id === "candle" ? undefined : idMap[id];
    return next && next !== id ? `${next}.${output}` : whole;
  });
}

export function referencedInstanceIds(rows: string[]): Set<string> {
  const out = new Set<string>();
  for (const row of rows) {
    for (const m of row.matchAll(REF)) {
      // `candle.close` is the language's own root, not an instance ref.
      if (m[1] === "candle") continue;
      out.add(m[1]);
    }
  }
  return out;
}

/** The pane type an instance id names, or null for an id no pane type mints.
 * mintInstanceId builds ids as `<TYPE>`, `<TYPE><n>` (numbered later
 * instances / the ATR function-name collision) or legacy `<TYPE>#<rand>`, so
 * stripping the `#` suffix and any trailing digits recovers the type. */
function instanceTypeOfId(id: string): string | null {
  const base = id.split("#", 1)[0].replace(/\d+$/, "");
  return EXPR_INSTANCE_TYPES.has(base) ? base : null;
}

/**
 * Best-effort pane payloads for referenced instances that have NO stored
 * snapshot — presets saved before the snapshot existed. The refs themselves
 * are the only record left, and they carry more than the id: outputs are named
 * by MA length (`SLOPE.9`, `SLOPE.accel50`, `ATR1.14`), so the lengths a rule
 * reads — and whether the accel companion must be on — are recoverable. Every
 * other setting takes the pane type's defaults: a default pane that computes
 * the referenced series beats a load that lints every rule as unknown.
 *
 * `exclude` is the ids the stored snapshot already covers (exact settings
 * always beat inference). An id whose type no pane mints is skipped — the
 * editor lints it as unknown, and inventing a pane for it would hide that.
 */
export function synthesizeExprInstances(
  rows: string[],
  exclude: ReadonlySet<string>,
): Record<string, ExprInstancePayload> {
  const outputsById = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const m of row.matchAll(REF)) {
      if (m[1] === "candle" || exclude.has(m[1])) continue;
      let set = outputsById.get(m[1]);
      if (!set) outputsById.set(m[1], (set = new Set()));
      set.add(m[2]);
    }
  }
  const out: Record<string, ExprInstancePayload> = {};
  for (const [id, outputs] of outputsById) {
    const type = instanceTypeOfId(id);
    if (!type) continue;
    // Length-named outputs, in reference order. `accel<length>` selects the
    // same MA line as its parent but requires the companion toggle.
    const lengths: number[] = [];
    let accel = false;
    for (const output of outputs) {
      let name = output;
      if (type === "SLOPE" && /^accel\d+$/.test(output)) {
        accel = true;
        name = output.slice("accel".length);
      }
      if (!/^\d+$/.test(name)) continue;
      const n = Number(name);
      if (n > 0 && !lengths.includes(n)) lengths.push(n);
    }
    // Defaults mirror the panes' own fallbacks: slopeLengths' [9] (first 5
    // kept, as there), atrLength's 14 (single-length pane).
    // FVG outputs are fixed names, not lengths, so nothing about the pane's
    // params is recoverable from a ref — an empty list takes every default.
    const calcParams =
      type === "FVG"
        ? []
        : type === "ATR"
          ? [lengths[0] ?? 14]
          : lengths.length
            ? lengths.slice(0, 5)
            : [9];
    out[id] = {
      type,
      calcParams,
      extendData: type === "SLOPE" && accel ? { showAccel: true } : {},
    };
  }
  return out;
}

/**
 * The `indicators` map for a request whose rule rows are `rows`: every live pane
 * a row references, and nothing else. A referenced id that is NOT on the chart is
 * skipped — the editor already flags that as `unknown_indicator_ref`, and the
 * request must not invent an entry for it.
 */
export function collectExprInstances(
  live: readonly LiveInstance[],
  rows: string[],
): Record<string, ExprInstancePayload> {
  const wanted = referencedInstanceIds(rows);
  const out: Record<string, ExprInstancePayload> = {};
  for (const inst of live) {
    if (!wanted.has(inst.id)) continue;
    out[inst.id] = {
      type: inst.type,
      calcParams: inst.calcParams ?? [],
      extendData: inst.extendData ?? {},
    };
  }
  return out;
}

/**
 * The editor's instance list: each referenceable pane with the outputs its
 * CURRENT settings expose and the timeframe it is pinned to (null = follows the
 * chart). Only panes a rule can name by INSTANCE are listed — an EMA is spelled
 * `EMA(9)` in a rule, not as an instance ref, and the accel companion's outputs
 * belong to its parent (`accel<length>`), not to a pane of its own.
 */
/**
 * The `warmupByRef` callback `warmupOf` (expr/parser.ts) injects: how many bars
 * `<instance>.<output>` needs before its first honest value, read off the pane's
 * LIVE settings.
 *
 * Injected rather than imported because the expression layer must not know about
 * any concrete indicator — the same reason `exprInstancesFor` is injected. An
 * unknown instance or output costs 0: that reference is already a lint error, and
 * inflating the history ask over it would hard-fail the run for the wrong reason.
 *
 * Pinned instances never reach here with a known base timeframe — warmupNode
 * short-circuits them to 0 BASE bars because they warm from their own HTF
 * history. The EXPRESSION routes source and sufficiency-check that history
 * (expr.py::_ensure_htf); the coded path does not — it fetches a flat
 * _HTF_WARMUP_BARS floor instead (see sweep_apply.py's note on the same split).
 */
export function exprWarmupByRef(
  live: readonly LiveInstance[],
): (instance: string, output: string) => number {
  const byId = new Map(live.map((i) => [i.id, i]));
  return (instance, output) => {
    const inst = byId.get(instance);
    if (!inst) return 0;
    // One branch per EXPR_INSTANCE_TYPES member — keep the two in step.
    if (inst.type === "ATR") return atrWarmup(inst.calcParams, output);
    // Every FVG output shares one floor (ATR warm-up + the pattern's two bars);
    // an output this pane does not expose costs 0, like the other branches.
    if (inst.type === "FVG") return (FVG_OUTPUTS as readonly string[]).includes(output) ? fvgWarmup() : 0;
    if (inst.type !== "SLOPE") return 0;
    return slopeWarmup(inst.calcParams, (inst.extendData ?? {}) as SlopeExtend, output);
  };
}

/** What the completion popup shows beside a SLOPE ref, e.g. "SMA · % / hour".
 *
 * The label itself is now `SLOPE.9`, so the LENGTH is already on screen and
 * repeating it here would be noise; what a reader still cannot see is which
 * moving average the pane uses and what the number is measured in. Both
 * vocabularies are the ones already on screen elsewhere — MA_KIND_LABEL is the
 * chart legend's, SLOPE_UNIT_LABEL is the settings modal's Units dropdown — so
 * the popup can't drift into a second spelling of the same setting.
 *
 * The pinned timeframe is NOT here: complete.ts appends it, so an unpinned pane
 * and a pinned one differ only by the suffix. */
function slopeRefDetail(ext: SlopeExtend): string {
  const kind = MA_KIND_LABEL[normalizeMaKind(ext.maType)];
  return `${kind} · ${SLOPE_UNIT_LABEL[normalizeSlopeUnit(ext.units)]}`;
}

export function exprInstancesFor(live: readonly LiveInstance[]): ExprInstance[] {
  const out: ExprInstance[] = [];
  for (const inst of live) {
    // One branch per EXPR_INSTANCE_TYPES member — keep the two in step.
    if (inst.type === "ATR") {
      const ext = (inst.extendData ?? {}) as AtrExtend;
      out.push({
        id: inst.id,
        outputs: atrOutputs(inst.calcParams),
        timeframe: null, // ATR panes are chart-timeframe only (no MTF input)
        // Smoothing plus the .to% output's divisor price — the SLOPE detail
        // convention: the popup says what the output names cannot.
        detail: `${ATR_SMOOTHING_LABEL[normalizeAtrSmoothing(ext.smoothing)]} · % of ${normalizeAtrPctSource(ext.pctSource)}`,
      });
      continue;
    }
    if (inst.type === "FVG") {
      const ext = (inst.extendData ?? {}) as FvgExtend;
      const cfg = parseFvgConfig(inst.calcParams);
      out.push({
        id: inst.id,
        outputs: [...FVG_OUTPUTS],
        timeframe: ext.mtf?.timeframe ?? null,
        // The output names say which gap and which edge; what they cannot say is
        // how selective the pane is — the SLOPE/ATR detail convention.
        detail: `min ${cfg.minSize}x ATR · newest ${cfg.maxGaps}/side`,
      });
      continue;
    }
    if (inst.type !== "SLOPE") continue;
    const ext = (inst.extendData ?? {}) as SlopeExtend;
    // slopeLengths falls back to [9], so a SLOPE always exposes at least one
    // output — no empty-output guard is needed for the one type handled here.
    out.push({
      id: inst.id,
      outputs: slopeOutputs(inst.calcParams, ext),
      timeframe: ext.mtf?.timeframe ?? null,
      detail: slopeRefDetail(ext),
    });
  }
  return out;
}
