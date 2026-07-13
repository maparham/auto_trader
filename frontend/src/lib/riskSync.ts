// "Same for long & short" SL/TP sync. Both config shapes that own per-side
// risk (BacktestConfig, CodedStrategyConfig) carry `riskSynced` — absent means
// ON (same `!== false` guard convention as longEnabled), so the flag is on by
// default for new and pre-existing configs alike.
// Spec: docs/superpowers/specs/2026-07-13-synced-long-short-risk-design.md

import type { RiskConfig } from "./backtestConfig";
import { sendableRisk } from "./codedConfig";

export interface SyncedRiskHolder {
  riskSynced?: boolean;
  longRisk?: RiskConfig;
  shortRisk?: RiskConfig;
}

export function riskSyncOn(cfg: SyncedRiskHolder): boolean {
  return cfg.riskSynced !== false;
}

/** The longRisk/shortRisk patch for an SL/TP edit made on `side`: both sides
 * when synced, just the edited one when not. Spread into the containing
 * config (`{ ...cfg, ...riskPatch(...) }`). */
export function riskPatch(
  synced: boolean,
  side: "long" | "short",
  r: RiskConfig,
): Pick<SyncedRiskHolder, "longRisk" | "shortRisk"> {
  if (synced) return { longRisk: r, shortRisk: r };
  return side === "long" ? { longRisk: r } : { shortRisk: r };
}

/** Structural equality with `undefined` ≡ none/none (a RiskSection touched
 * and reset back to None must not count as "differing" — same normalization
 * the backend request uses via sendableRisk). */
export function risksEqual(a: RiskConfig | undefined, b: RiskConfig | undefined): boolean {
  const na = sendableRisk(a);
  const nb = sendableRisk(b);
  if (!na || !nb) return na === nb || (!na && !nb);
  return specEqual(na.stop, nb.stop) && specEqual(na.target, nb.target);
}

function specEqual(
  a: { kind: string; value?: number; mult?: number; length?: number },
  b: { kind: string; value?: number; mult?: number; length?: number },
): boolean {
  return a.kind === b.kind && a.value === b.value && a.mult === b.mult && a.length === b.length;
}

/** Enforce the sync invariant on a just-loaded (or just-toggled-on) config:
 * when synced and the sides differ, `prefer` — the side the user is looking
 * at, or long where both are visible — wins and is copied across. Returns the
 * input untouched (same reference) when nothing needs to change. */
export function applyRiskSync<T extends SyncedRiskHolder>(cfg: T, prefer: "long" | "short"): T {
  if (!riskSyncOn(cfg) || risksEqual(cfg.longRisk, cfg.shortRisk)) return cfg;
  const src = prefer === "long" ? cfg.longRisk : cfg.shortRisk;
  return { ...cfg, longRisk: src, shortRisk: src };
}
