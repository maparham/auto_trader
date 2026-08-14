// Named backtest presets (global, not per-symbol — a strategy you built is
// useful on any chart). v3 wraps the config in an envelope carrying metadata:
// when it was saved, which chart it was built on, and the summary of its last
// CLEAN run, so the Presets tab can show a comparison table instead of a list
// of bare names.
//
// v2 (a plain Record<name, BacktestConfig>) is abandoned, not migrated — the
// same call v2 made about v1. Nothing here ever reads the v2 key.
import { PREFIX, load, save } from "./persist/core";
import {
  normalizeBacktestConfig, RULE_GROUP_KEYS,
  type BacktestConfig, type RangeConfig, type RuleGroup,
} from "./backtestConfig";
import { sanitizePortableInstances, type PortableInstancePayload } from "./ruleClipboard";

/** The summary of one completed single backtest, as shown in the library table. */
export type PresetRun = {
  at: number;
  symbol: string;
  timeframe: string;
  netPnl: number;
  trades: number;
  winRate: number; // 0..1, as the backend reports it
  maxDd: number;
};

export type BacktestPreset = {
  /** Duplicated from the record key so an exported file round-trips standalone. */
  name: string;
  cfg: BacktestConfig;
  createdAt: number;
  updatedAt: number;
  /** The chart this was saved from. Optional because an imported or
   *  hand-edited file may not carry one. */
  origin?: { symbol: string; timeframe: string };
  lastRun?: PresetRun;
  /** Free-text annotation shown as the row's hover tooltip. Absent, never "". */
  note?: string;
  /** Snapshot of the coded strategy's panel params (lib/codedConfig) taken at
   *  save time. Those params live in a per-file store shared across presets, so
   *  without this a loaded preset would run whatever the store last held.
   *  Absent on rule-mode presets and on presets saved before the field existed
   *  (loading those leaves the store untouched). */
  codedParams?: Record<string, number | boolean | string>;
  /** Snapshot of the chart panes the rules reference by instance (`SLOPE#a1.9`),
   *  taken at save time — same portable shape the rule clipboard ships, for the
   *  same reason: the expression names an instance's OUTPUT and restates none of
   *  its settings, so without this a preset loaded on another chart (or after
   *  retuning the pane) runs against different settings or none at all. Loading
   *  recreates these panes and rewrites the rule refs to the ids that landed.
   *  Absent on presets with no instance refs and on presets saved before the
   *  field existed. */
  exprInstances?: Record<string, PortableInstancePayload>;
};

const KEY = `${PREFIX}.backtestPresets.v3`;

export function newPreset(
  name: string,
  cfg: BacktestConfig,
  origin: { symbol: string; timeframe: string },
  now: number,
): BacktestPreset {
  return { name, cfg, createdAt: now, updatedAt: now, origin };
}

export function loadPresets(): Record<string, BacktestPreset> {
  const all = load<Record<string, BacktestPreset>>(KEY, {});
  // Config shape drift is still folded forward inside the envelope — the
  // envelope itself is metadata only and never needed normalizing.
  return Object.fromEntries(
    Object.entries(all).map(([name, p]) => [
      name,
      { ...p, name, cfg: normalizeBacktestConfig(p.cfg) },
    ]),
  );
}

/** Preset names are user text and reach this record as keys, so `__proto__` is a
 *  real name a user can type or a file can carry. A plain `all[name] = p` on that
 *  key writes the prototype instead of a property: the preset vanishes while
 *  every caller reports success. defineProperty makes it an ordinary own key. */
function setAt(all: Record<string, BacktestPreset>, name: string, preset: BacktestPreset): void {
  Object.defineProperty(all, name, { value: preset, enumerable: true, writable: true, configurable: true });
}

export function putPreset(preset: BacktestPreset): void {
  const all = loadPresets();
  setAt(all, preset.name, preset);
  save(KEY, all);
}

export function renamePreset(from: string, to: string): void {
  const all = loadPresets();
  const p = all[from];
  if (!p || from === to) return;
  delete all[from];
  setAt(all, to, { ...p, name: to });
  save(KEY, all);
}

export function deletePreset(name: string): void {
  const all = loadPresets();
  if (name in all) {
    delete all[name];
    save(KEY, all);
  }
}

type ExportFile = { version: 3; presets: BacktestPreset[] };

export function serializePresets(list: BacktestPreset[]): string {
  const file: ExportFile = { version: 3, presets: list };
  return JSON.stringify(file, null, 2);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** Structural check on the parts of a config the panel dereferences WITHOUT
 *  guarding — `cfg.range.mode` and each rule group's `rules` array. Unlike the
 *  metadata, a cfg that fails this has no usable remainder: it is the whole
 *  point of the preset, so a bad one is rejected and counted rather than
 *  repaired. Deliberately structural, not exhaustive: it rules out `{}`, an
 *  array, and a truncated file, but does not re-validate every optional field
 *  that already has a guarded read. */
function isConfigShaped(v: unknown): v is BacktestConfig {
  if (!isPlainObject(v)) return false;
  const range = v.range;
  if (!isPlainObject(range) || typeof (range as Partial<RangeConfig>).mode !== "string") return false;
  for (const key of RULE_GROUP_KEYS) {
    const g = v[key];
    if (!isPlainObject(g) || !Array.isArray((g as Partial<RuleGroup>).rules)) return false;
  }
  // `costs` may be ABSENT: normalizeBacktestConfig fills it from defaults, and a
  // preset exported before costs existed legitimately lacks it — rejecting those
  // would break the format's own backward compatibility. Present-but-not-an-
  // object is different: that is a corrupt file, not an old one.
  return v.costs === undefined || isPlainObject(v.costs);
}

/** Verifies the two fields a preset is useless without; the timestamps are
 *  coerced by the caller, since a missing one is recoverable and a missing cfg
 *  isn't. */
function isPreset(v: unknown): v is Partial<BacktestPreset> & Pick<BacktestPreset, "name" | "cfg"> {
  if (!v || typeof v !== "object") return false;
  const p = v as Partial<BacktestPreset>;
  return typeof p.name === "string" && p.name.length > 0 && isConfigShaped(p.cfg);
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";

/** Drop a malformed `origin` rather than the preset carrying it: the cfg is the
 *  thing of value, and losing a whole strategy over a cosmetic metadata field is
 *  a worse outcome than showing "—" in the Symbol/TF column. Same for lastRun. */
function cleanOrigin(v: unknown): BacktestPreset["origin"] {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Partial<NonNullable<BacktestPreset["origin"]>>;
  return isStr(o.symbol) && isStr(o.timeframe) ? { symbol: o.symbol, timeframe: o.timeframe } : undefined;
}

/** All-or-nothing: a run summary with one non-numeric field would render as
 *  "Invalid Date"/NaN and sort against the other rows as garbage, so a partial
 *  one is no more useful than none. */
function cleanRun(v: unknown): PresetRun | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as Partial<PresetRun>;
  if (!isNum(r.at) || !isStr(r.symbol) || !isStr(r.timeframe)) return undefined;
  if (!isNum(r.netPnl) || !isNum(r.trades) || !isNum(r.winRate) || !isNum(r.maxDd)) return undefined;
  return {
    at: r.at, symbol: r.symbol, timeframe: r.timeframe,
    netPnl: r.netPnl, trades: r.trades, winRate: r.winRate, maxDd: r.maxDd,
  };
}

/** Entry-level cleaning: keep scalar values, drop the rest. A hand-edited file
 *  with one nested object in it shouldn't cost the other params (they are the
 *  tuned values — the point of the snapshot), and a non-object shape is no
 *  snapshot at all. */
function cleanCodedParams(v: unknown): BacktestPreset["codedParams"] {
  if (!isPlainObject(v)) return undefined;
  const out: NonNullable<BacktestPreset["codedParams"]> = {};
  for (const [k, val] of Object.entries(v)) {
    if (isNum(val) || isStr(val) || typeof val === "boolean") out[k] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Same call as codedParams: a malformed entry costs the entry, not the preset.
 *  Delegates to the clipboard's sanitizer — the field IS the clipboard payload
 *  shape — and collapses empty to absent so "has instances" stays a plain
 *  truthiness test. */
function cleanExprInstances(v: unknown): BacktestPreset["exprInstances"] {
  const out = sanitizePortableInstances(v);
  return Object.keys(out).length ? out : undefined;
}

/** Parse an exported file, keeping every usable entry and counting the rest.
 * Never throws: import must tell the user what it dropped rather than failing
 * the whole file (or, worse, silently). Malformed JSON counts as one rejection. */
export function parsePresets(json: string): { presets: BacktestPreset[]; rejected: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { presets: [], rejected: 1 };
  }
  const raw = (parsed as Partial<ExportFile> | null)?.presets;
  if (!Array.isArray(raw)) return { presets: [], rejected: 1 };
  const presets: BacktestPreset[] = [];
  let rejected = 0;
  for (const entry of raw) {
    if (!isPreset(entry)) {
      rejected += 1;
      continue;
    }
    presets.push({
      ...entry,
      cfg: normalizeBacktestConfig(entry.cfg),
      createdAt: typeof entry.createdAt === "number" ? entry.createdAt : 0,
      updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : 0,
      // Import is the only path that can put hand-edited metadata in front of
      // the library table's formatters and sort comparators, so it is where the
      // shape is enforced — not in every reader downstream.
      origin: cleanOrigin(entry.origin),
      lastRun: cleanRun(entry.lastRun),
      // Same call as origin/lastRun: a bad note costs the note, not the preset.
      // Blank collapses to absent so the tooltip's "has a note" check stays a
      // plain truthiness test everywhere.
      note: isStr(entry.note) && entry.note.trim() ? entry.note : undefined,
      codedParams: cleanCodedParams(entry.codedParams),
      exprInstances: cleanExprInstances(entry.exprInstances),
    });
  }
  return { presets, rejected };
}
