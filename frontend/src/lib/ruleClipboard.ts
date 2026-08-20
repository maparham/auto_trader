// The portable rule clipboard: a tagged JSON envelope written to the SYSTEM
// clipboard (mirroring the indicator/drawing envelopes in useIndicatorCommands),
// so copied rules survive across tabs, windows and app instances.
//
// A rule's expression can reference a chart pane by instance (`SLOPE.9`,
// `ATR1.to14`) and carry NONE of that pane's settings — the pane is the source
// of truth (see exprInstances.ts). So a self-contained copy must ship those
// panes' full configs alongside the rules; `indicators` is exactly the map a
// backtest request ships for the same reason, collected the same way.
import { cloneRule, RULE_GROUP_KEYS, type BacktestConfig, type Rule } from "./backtestConfig";
import {
  collectExprInstances,
  rewriteInstanceRefs,
  type ExprInstancePayload,
  type LiveInstance,
} from "./exprInstances";
import type { SavedIndicatorConfig } from "./persist";

/** A pane's display dressing, shipped alongside its computational config so a
 * recreated pane also keeps the user's line colors/sizes and hidden state —
 * the same fields the standalone indicator envelope ships (SavedIndicatorConfig
 * shape, so it feeds applyIndicator directly). */
export interface InstanceAppearance {
  visible?: boolean;
  styles?: SavedIndicatorConfig["styles"];
}

export type PortableInstancePayload = ExprInstancePayload & InstanceAppearance;

export interface RuleClipboardPayload {
  rules: Rule[];
  indicators: Record<string, PortableInstancePayload>;
}

// The extendData keys that are RUNTIME state, not authored settings: barHours is
// re-derived from the chart's resolution (applySlopeBarHours), and the mtf stash
// (per-bar HTF series) belongs to the source chart's epic/data window — normal
// persistence deliberately saves only `mtf.timeframe` (see refreshMtfIndicators),
// and shipping the arrays would both bloat the envelope by orders of magnitude
// and render the SOURCE epic's series on the target until a refetch.
const MTF_RUNTIME_KEYS = [
  "htfStarts",
  "htfSeries",
  "htfMs",
  "htfSeriesByLine",
  "htfMaBaseByLine",
  "htfAccelByLine",
  // Trendlines: the four operand series, the detected line list and the HTF ATR
  // the merge tolerances are measured in.
  "htfSupport",
  "htfResistance",
  "htfBrokenSupport",
  "htfBrokenResistance",
  "htfLines",
  "htfAtr",
] as const;

/** extendData with runtime-derived state stripped — what the envelope ships. */
export function portableExtend(extendData: unknown): Record<string, unknown> {
  if (typeof extendData !== "object" || extendData === null) return {};
  const out = { ...(extendData as Record<string, unknown>) };
  delete out.barHours;
  const mtf = out.mtf;
  if (typeof mtf === "object" && mtf !== null) {
    const m = { ...(mtf as Record<string, unknown>) };
    for (const k of MTF_RUNTIME_KEYS) delete m[k];
    out.mtf = m;
  }
  return out;
}

/** The portable id→payload map for the panes `exprs` reference: full config of
 * every referenced live pane (nothing else — an unreferenced pane is not part
 * of the strategy, and a referenced-but-missing one is already a lint error on
 * the source side), runtime state stripped, `appearance` (per live pane id,
 * from captureIndicatorAppearance) folded in. Shared by the rule clipboard and
 * the preset snapshot — the two self-contained carriers of a strategy. */
export function collectPortableInstances(
  exprs: readonly string[],
  live: readonly LiveInstance[],
  appearance?: Readonly<Record<string, InstanceAppearance>>,
): Record<string, PortableInstancePayload> {
  const collected = collectExprInstances(live, [...exprs]);
  const indicators: Record<string, PortableInstancePayload> = {};
  for (const [id, p] of Object.entries(collected)) {
    indicators[id] = { ...p, extendData: portableExtend(p.extendData), ...appearance?.[id] };
  }
  return indicators;
}

/** `rules` with their instance refs rewritten per `idMap` — the rule-level
 * rewrite both a paste and a preset load apply after recreating panes. */
export function rewriteRulesInstanceRefs(
  rules: readonly Rule[],
  idMap: Readonly<Record<string, string>>,
): Rule[] {
  return rules.map((r) => (r.expr ? { ...r, expr: rewriteInstanceRefs(r.expr, idMap) } : r));
}

/** `cfg` with every rule group's instance refs rewritten per `idMap` (old pane
 * id → the id that actually landed on the chart). What a preset load applies
 * after recreating the panes, mirroring the per-rule rewrite a paste does. */
export function rewriteConfigInstanceRefs(
  cfg: BacktestConfig,
  idMap: Readonly<Record<string, string>>,
): BacktestConfig {
  if (!Object.keys(idMap).length) return cfg;
  const out = { ...cfg };
  for (const key of RULE_GROUP_KEYS) {
    out[key] = { ...cfg[key], rules: rewriteRulesInstanceRefs(cfg[key].rules, idMap) };
  }
  return out;
}

/** The system-clipboard text for `rules`: the rules plus the portable configs
 * of the panes they reference. */
export function encodeRuleClipboard(
  rules: readonly Rule[],
  live: readonly LiveInstance[],
  appearance?: Readonly<Record<string, InstanceAppearance>>,
): string {
  const cloned = rules.map(cloneRule);
  const indicators = collectPortableInstances(cloned.map((r) => r.expr ?? ""), live, appearance);
  return JSON.stringify({ __autoTraderRules: 1, rules: cloned, indicators }, null, 2);
}

/** Parse clipboard text back into a payload, or null when it isn't ours.
 * Field-by-field sanitising, not a cast — the system clipboard is arbitrary
 * user-editable text by the time it comes back. */
export function decodeRuleClipboard(text: string): RuleClipboardPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as { __autoTraderRules?: unknown; rules?: unknown; indicators?: unknown };
  if (p.__autoTraderRules !== 1 || !Array.isArray(p.rules)) return null;
  const rules: Rule[] = [];
  for (const r of p.rules) {
    if (typeof r !== "object" || r === null) continue;
    const { expr, enabled, count } = r as Record<string, unknown>;
    if (typeof expr !== "string") continue; // a rule IS its expression; entries without one are junk
    rules.push({
      expr,
      enabled: typeof enabled === "boolean" ? enabled : undefined,
      count: typeof count === "number" && Number.isFinite(count) ? count : undefined,
    });
  }
  if (!rules.length) return null;
  return { rules, indicators: sanitizePortableInstances(p.indicators) };
}

/** Field-by-field sanitising of an id→payload map from outside the app (the
 * system clipboard, an imported preset file). Entries without a type are junk
 * and dropped; malformed optional fields cost the field, not the entry. */
export function sanitizePortableInstances(v: unknown): Record<string, PortableInstancePayload> {
  const indicators: Record<string, PortableInstancePayload> = {};
  if (typeof v !== "object" || v === null || Array.isArray(v)) return indicators;
  for (const [id, entry] of Object.entries(v as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { type, calcParams, extendData, visible, styles } = entry as Record<string, unknown>;
    if (typeof type !== "string" || !type) continue;
    indicators[id] = {
      type,
      calcParams: Array.isArray(calcParams)
        ? calcParams.map(Number).filter((n) => Number.isFinite(n))
        : [],
      extendData:
        typeof extendData === "object" && extendData !== null
          ? portableExtend(extendData)
          : {},
      ...(typeof visible === "boolean" ? { visible } : {}),
      ...(sanitizeStyles(styles) ?? {}),
    };
  }
  return indicators;
}

// Keep only the line-style fields SavedIndicatorConfig persists; anything
// malformed drops the styles rather than the whole entry.
function sanitizeStyles(styles: unknown): { styles: SavedIndicatorConfig["styles"] } | null {
  if (typeof styles !== "object" || styles === null) return null;
  const lines = (styles as { lines?: unknown }).lines;
  if (!Array.isArray(lines)) return null;
  return {
    styles: {
      lines: lines.map((l) => {
        const { color, size, style, dashedValue } = (
          typeof l === "object" && l !== null ? l : {}
        ) as Record<string, unknown>;
        return {
          ...(typeof color === "string" ? { color } : {}),
          ...(typeof size === "number" ? { size } : {}),
          ...(typeof style === "string" ? { style } : {}),
          ...(Array.isArray(dashedValue) ? { dashedValue: dashedValue.map(Number) } : {}),
        };
      }),
    },
  };
}

/** Key-order-insensitive deep equality over JSON-shaped values. Small and
 * recursive; the payloads compared through it (pane configs, coded-store
 * snapshots) are tiny. */
export function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEq(v, b[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    deepEq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

// What the pane-identity comparison looks at: authored settings only. On top of
// the runtime state portableExtend strips, display/visibility state is ignored
// too — a hidden pane computes the same series as a shown one, and forcing a
// duplicate pane over an eye toggle would defeat the reuse branch entirely.
function comparableExtend(extendData: unknown): unknown {
  const rest = portableExtend(extendData);
  delete rest.userVisible;
  delete rest.visibility;
  // applyIndicator force-merges indType (== the type) into every live pane's
  // extendData; the type is compared explicitly, so its echo here is noise.
  delete rest.indType;
  // inset is a placement/display marker (own sub-pane vs the candle pane's band),
  // not part of what makes an indicator a DIFFERENT indicator: both spellings
  // compute the same series. Leaving it in mismatches a live inset pane against a
  // plain payload (and vice versa), so the paste mints a new id and duplicates the
  // pane. Same class as templateSignatures' NON_IDENTIFYING_EXTEND_KEYS.
  delete rest.inset;
  // An unpinned pane spells "chart timeframe" either as no mtf at all or as
  // mtf:{timeframe:null} depending on its editing history — same pane.
  const mtf = rest.mtf as { timeframe?: unknown } | undefined;
  if (mtf && mtf.timeframe == null) delete rest.mtf;
  return rest;
}

/** Whether a live pane already IS the copied pane — same type and authored
 * settings — so a paste can point rules at it instead of creating a duplicate. */
export function sameInstanceConfig(live: LiveInstance, payload: ExprInstancePayload): boolean {
  return (
    live.type === payload.type &&
    deepEq(live.calcParams ?? [], payload.calcParams ?? []) &&
    deepEq(comparableExtend(live.extendData), comparableExtend(payload.extendData))
  );
}
