// Per-strategy-file coded config: the panel-tunable half of a coded run
// (params + risk + exit rule groups). BACKTEST and LIVE are deliberately
// SEPARATE sets — fiddling with a knob in the backtest panel must never
// change what an armed live strategy does. Synced via save() (cross-device).

import type { ParamSpec, ParamValues } from "../api";
import type { RiskConfig, RuleGroup } from "./backtestConfig";
import { load, save } from "./persist/core";

export interface CodedStrategyConfig {
  params: ParamValues;
  longRisk?: RiskConfig;
  shortRisk?: RiskConfig;
  longExit: RuleGroup;
  shortExit: RuleGroup;
}

export type CodedSetName = "backtest" | "live";

// ONE persist key PER (set, filename) — never a whole-store snapshot object.
// A single store object would be the full-snapshot-write pattern that caused
// the cross-tab overlay stomp: two panels editing configs for DIFFERENT files
// would race on the shared key and last-write-wins would drop one edit.
const KEY = (set: CodedSetName, filename: string) =>
  `auto-trader.codedCfg.${set}.${filename}`;

const emptyGroup = (): RuleGroup => ({ combine: "AND", rules: [] });

export function defaultCodedCfg(): CodedStrategyConfig {
  return { params: {}, longExit: emptyGroup(), shortExit: emptyGroup() };
}

export function loadCodedCfg(set: CodedSetName, filename: string): CodedStrategyConfig {
  return load<CodedStrategyConfig | null>(KEY(set, filename), null) ?? defaultCodedCfg();
}

export function saveCodedCfg(set: CodedSetName, filename: string, cfg: CodedStrategyConfig): void {
  save(KEY(set, filename), cfg);
}

/** Stored values overlaid on the schema's defaults; anything stale (unknown
 * name, wrong type, out of range, not in options) silently falls back to the
 * default — the file may have changed since the values were saved. */
export function resolveParamValues(specs: ParamSpec[], stored: ParamValues): ParamValues {
  const out: ParamValues = {};
  for (const s of specs) {
    const v = stored[s.name];
    out[s.name] = isValid(s, v) ? (s.type === "int" ? Math.round(v as number) : v!) : s.default;
  }
  return out;
}

function isValid(s: ParamSpec, v: number | boolean | string | undefined): boolean {
  if (v === undefined) return false;
  if (s.type === "bool") return typeof v === "boolean";
  if (s.type === "choice") return typeof v === "string" && (s.options ?? []).includes(v);
  if (typeof v !== "number" || !Number.isFinite(v)) return false;
  if (s.min !== null && v < s.min) return false;
  if (s.max !== null && v > s.max) return false;
  return true;
}

/** Normalize a risk config before it's sent to the backend: a none/none config
 * (RiskSection touched then reset back to None) must be indistinguishable
 * from never having configured panel risk at all — otherwise the backend
 * treats the leg as "panel-configured" and strips the coded file's own
 * sl=/tp= brackets while applying no engine-side stop either (C1, stopless
 * positions in both backtest and live). */
export function sendableRisk(risk: RiskConfig | undefined): RiskConfig | undefined {
  if (!risk) return undefined;
  return risk.stop.kind === "none" && risk.target.kind === "none" ? undefined : risk;
}

/** Structural compare — JSON.stringify would be key-order sensitive and flash
 * spurious "differs from backtest" / "edits apply on next arm" badges when two
 * code paths build the same config with keys in a different order. */
export function codedCfgsDiffer(a: CodedStrategyConfig, b: CodedStrategyConfig): boolean {
  return !deepEqual(a, b);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(
    (a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k],
  ));
}
