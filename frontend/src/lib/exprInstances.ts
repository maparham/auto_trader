// The bridge between the chart's live indicator panes and the expression layer.
//
// Two directions, both pure (no klinecharts — the chart adapters that produce
// `LiveInstance[]` live in indicators.ts, where klinecharts already is):
//
//   1. OUT to the backend — `collectExprInstances(live, rows)` collects the panes
//      the rows actually reference, for the request's `indicators` map. Rules name
//      an instance's OUTPUT (`SLOPE.slope0`) and carry none of its settings, so the
//      backend needs the config to recompute over any window (a backtest window
//      routinely exceeds the chart's loaded candles).
//   2. IN to the editor — `exprInstancesFor(live)` is the injected list `analyze`
//      and the completion source read, so a pane's own settings stay the single
//      source of truth for which outputs exist.
import { slopeOutputs, slopeWarmup } from "./indicators/slopeOutputs";
import type { SlopeExtend } from "./indicators/slope"; // erased at build; no runtime edge
import type { ExprInstance } from "./expr/catalog";

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
// backtrack to a shorter match and slip past the lookahead), and requiring a
// letter/underscore immediately before the dot means a decimal literal (`0.5`)
// and a field read off a call result (`EMA(9).signal`, whose preceding char is
// ")") can never match.
const REF = /\b([A-Za-z_][A-Za-z0-9_]*(?:#[A-Za-z0-9_]+)?)\.([A-Za-z_][A-Za-z0-9_]*)\b(?!\s*\()/g;

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
 * belong to its parent (`accel0..N`), not to a pane of its own.
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
    if (!inst || inst.type !== "SLOPE") return 0;
    return slopeWarmup(inst.calcParams, (inst.extendData ?? {}) as SlopeExtend, output);
  };
}

export function exprInstancesFor(live: readonly LiveInstance[]): ExprInstance[] {
  const out: ExprInstance[] = [];
  for (const inst of live) {
    if (inst.type !== "SLOPE") continue;
    const ext = (inst.extendData ?? {}) as SlopeExtend;
    // slopeLengths falls back to [9], so a SLOPE always exposes at least
    // slope0 — no empty-output guard is needed for the one type handled here.
    out.push({
      id: inst.id,
      outputs: slopeOutputs(inst.calcParams, ext),
      timeframe: ext.mtf?.timeframe ?? null,
    });
  }
  return out;
}
