// The assistant's local knowledge tools. Everything is read from the same
// metadata the settings modal and the rule editor use, so the model sees the
// labels, tips and ranges a human sees.
import {
  resolveInputs, indicatorInfo, presetsFor, directionFor, withPresetStep,
  type IndicatorInputDef, type IndicatorPresets,
} from "../lib/indicatorMeta";
import { BASE_TEMPLATES } from "../lib/customIndicators";
import { TRENDLINES_DEFAULTS } from "../lib/indicators/trendlinesOutputs";
import { VALID_TYPES } from "../agent/actions/indicators";
import { exprInstancesFor, type LiveInstance } from "../lib/exprInstances";
import { analyze, warmupOf } from "../lib/expr/parser";
import {
  INDICATORS, WRAPPERS, FUNCS, CROSSES, CROSS_OPS, LOGIC, CANDLE_FIELDS,
  CANDLE_FIELD_DETAILS, TIMEFRAMES, CONDITIONS, PATTERNS,
} from "../lib/expr/catalog";

export interface InputDesc {
  key: string; name?: string; label: string; source: "calcParam" | "extend";
  index?: number; field?: string; default?: unknown; min?: number; max?: number; step?: number;
  options?: Array<{ value: string | number; label: string }>; tip?: string; group?: string;
}

const TL_NAMES = Object.keys(TRENDLINES_DEFAULTS);

function slotName(type: string, index: number | undefined): string | undefined {
  return type === "TRENDLINES" && index !== undefined ? TL_NAMES[index] : undefined;
}

function templateDefault(type: string, index: number): number | undefined {
  const tpl = (BASE_TEMPLATES as Record<string, { calcParams?: unknown[] }>)[type];
  const v = tpl?.calcParams?.[index];
  return typeof v === "number" ? v : undefined;
}

function inputsOf(type: string): IndicatorInputDef[] {
  const tplParams = (BASE_TEMPLATES as Record<string, { calcParams?: unknown[] }>)[type]?.calcParams;
  return resolveInputs(type, tplParams as unknown[] | undefined);
}

function assertType(type: string): void {
  if (!VALID_TYPES.includes(type)) {
    throw new Error(`unknown indicator type: ${type} (one of ${VALID_TYPES.join(", ")})`);
  }
}

function stepsAsSets(type: string, p: IndicatorPresets | undefined, inputs: IndicatorInputDef[]) {
  if (!p) return [];
  return p.steps.map((s) => {
    const sets: Record<string, number> = {};
    p.slots.forEach((slot, j) => {
      const inp = inputs.find((i) => i.source === "calcParam" && i.index === slot);
      sets[slotName(type, slot) ?? inp?.key ?? `p${slot}`] = s.values[j];
    });
    return { name: s.name, sets };
  });
}

export function describeIndicator(type: string) {
  assertType(type);
  const inputs = inputsOf(type);
  const presets = presetsFor(type);
  const info = indicatorInfo(type);
  const out: InputDesc[] = inputs.map((i) => {
    const def =
      i.default ??
      (i.source === "calcParam" && i.index !== undefined
        ? presets?.base[i.index] ?? templateDefault(type, i.index)
        : undefined);
    const d: InputDesc = {
      key: i.key, label: i.label, source: i.source,
      ...(i.index !== undefined ? { index: i.index } : {}),
      ...(i.field ? { field: i.field } : {}),
      ...(def !== undefined ? { default: def } : {}),
      ...(i.min !== undefined ? { min: i.min } : {}),
      ...(i.max !== undefined ? { max: i.max } : {}),
      ...(i.step !== undefined ? { step: i.step } : {}),
      ...(i.options ? { options: i.options } : {}),
      ...(i.tip ? { tip: Array.isArray(i.tip) ? i.tip.join(" ") : i.tip } : {}),
      ...(i.group ? { group: i.group } : {}),
    };
    const name = slotName(type, i.index);
    if (name) d.name = name;
    return d;
  });
  return {
    type, title: info.title, desc: info.desc, inputs: out,
    presets: stepsAsSets(type, presets, inputs),
    directions: stepsAsSets(type, directionFor(type), inputs),
    ...(type === "TRENDLINES" ? { startsOn: "Balanced" } : {}),
  };
}

function pickStep(p: IndicatorPresets | undefined, name: string, what: string): number {
  const names = p?.steps.map((s) => s.name) ?? [];
  const i = names.findIndex((n) => n.toLowerCase() === name.toLowerCase());
  if (!p || i === -1) throw new Error(`unknown ${what}: ${name} (one of ${names.join(", ") || "none"})`);
  return i;
}

export function configureParams(
  type: string,
  live: number[],
  opts: { preset?: string; direction?: string; params?: Record<string, number> },
): { calcParams: number[]; changed: string[]; edits: string[] } {
  assertType(type);
  const inputs = inputsOf(type).filter((i) => i.source === "calcParam" && i.index !== undefined);
  const presets = presetsFor(type);
  const base = presets?.base ?? live;
  let next = base.map((d, k) => (Number.isFinite(live[k]) ? live[k] : d));
  const before = [...next];
  // "Lookback 120 to 255" per explicit param, for the Changed card.
  const edits: string[] = [];
  if (opts.preset) next = withPresetStep(presets!, next, pickStep(presets, opts.preset, "preset"));
  if (opts.direction) {
    const dir = directionFor(type);
    next = withPresetStep(dir!, next, pickStep(dir, opts.direction, "direction"));
  }
  for (const [k, raw] of Object.entries(opts.params ?? {})) {
    const inp = inputs.find((i) => i.key === k || slotName(type, i.index) === k);
    if (!inp) {
      const valid = inputs.map((i) => slotName(type, i.index) ?? i.key);
      throw new Error(`unknown param ${k} for ${type} (one of ${valid.join(", ")})`);
    }
    const v = Number(raw);
    const label = slotName(type, inp.index) ?? inp.key;
    if (!Number.isFinite(v)) throw new Error(`${label}: a number is required`);
    if (inp.min !== undefined && v < inp.min) throw new Error(`${label}: at least ${inp.min}`);
    if (inp.max !== undefined && v > inp.max) throw new Error(`${label}: at most ${inp.max}`);
    next[inp.index!] = v;
    const from = before[inp.index!];
    edits.push(from === v ? `${inp.label} ${v}` : `${inp.label} ${from} to ${v}`);
  }
  const changed = next
    .map((v, i) => (v !== before[i] ? slotName(type, i) ?? `p${i}` : null))
    .filter((x): x is string => x !== null);
  return { calcParams: next, changed, edits };
}

export function describeRules(live: readonly LiveInstance[]): Record<string, unknown> {
  const typeOf = new Map(live.map((l) => [l.id, l.type]));
  const strip = (e: { name: string; signature?: string; detail?: string }) =>
    ({ name: e.name, signature: e.signature, detail: e.detail });
  return {
    indicators: INDICATORS.map(strip),
    wrappers: WRAPPERS.map(strip),
    funcs: FUNCS.map(strip),
    crosses: CROSSES.map(strip),
    crossOps: CROSS_OPS.map(strip),
    logic: LOGIC.map(strip),
    candleFields: CANDLE_FIELDS.map((f) => ({ name: `candle.${f}`, detail: CANDLE_FIELD_DETAILS[f] })),
    timeframes: TIMEFRAMES.map((t) => t.alias),
    conditions: CONDITIONS.map(strip),
    patterns: PATTERNS.map((p) => p.name),
    instances: exprInstancesFor(live).map((i) => ({
      id: i.id, type: typeOf.get(i.id) ?? null, outputs: i.outputs,
      timeframe: i.timeframe ?? null, detail: i.detail ?? null,
    })),
  };
}

export function validateRule(
  expr: string, isExit: boolean, live: readonly LiveInstance[], baseSeconds: number,
  lines?: ReadonlySet<string>,
) {
  const instances = exprInstancesFor(live);
  const res = analyze(expr, { isExit, instances, lines });
  const errors = res.errors.map((e) => ({ message: e.message, from: e.from, to: e.to }));
  return {
    ok: errors.length === 0,
    errors,
    warmupBars: errors.length ? 0 : warmupOf(expr, baseSeconds, instances),
  };
}
