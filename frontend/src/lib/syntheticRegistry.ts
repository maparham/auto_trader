// localStorage-backed map of synthetic id -> expression, so a synthetic chart's
// id (used everywhere as an ordinary `epic`) resolves back to the expression the
// backend needs. Frontend is the source of truth; the backend stays stateless.

import { canonicalize, parseLegs, syntheticId } from "./syntheticExpr";

export interface SyntheticEntry {
  id: string;
  expression: string;
  canonical: string;
  brokerId: string;
  legs: string[];
  precision: number | null;
}

const KEY = "synthetic.registry.v1";

function load(): Record<string, SyntheticEntry> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, SyntheticEntry>) : {};
  } catch {
    return {};
  }
}

function save(map: Record<string, SyntheticEntry>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* quota / disabled storage — synthetic is session-usable regardless */
  }
}

export function registerSynthetic(expression: string, brokerId: string): SyntheticEntry {
  const canonical = canonicalize(expression);
  const id = syntheticId(expression);
  const map = load();
  const existing = map[id];
  if (existing) return existing;
  const entry: SyntheticEntry = {
    id,
    expression: expression.trim(),
    canonical,
    brokerId,
    legs: parseLegs(expression),
    precision: null,
  };
  map[id] = entry;
  save(map);
  return entry;
}

export function getSynthetic(id: string): SyntheticEntry | null {
  return load()[id] ?? null;
}

export function isSynthetic(epic: string): boolean {
  return epic.startsWith("SYN_") && getSynthetic(epic) !== null;
}

export function setSyntheticPrecision(id: string, precision: number): void {
  const map = load();
  const e = map[id];
  if (!e) return;
  e.precision = precision;
  save(map);
}
