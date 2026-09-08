// Preset pattern search: the client for the preset-families manifest, the
// multi-chart preset scan, and user preset CRUD. Mirrors patternSearch.ts's
// fetch/error-handling idiom function-for-function.
import { API_BASE as BASE, apiFetch, errorDetail } from "./http";
import type { PatternBar } from "./patternSearch";

export interface PresetParamSchema {
  name: string;
  type: "float" | "int";
  min: number;
  max: number;
  default: number;
  help: string;
}

export interface PresetFamily {
  family: string;
  title: string;
  params: PresetParamSchema[];
}

export interface PresetHit {
  family: string;
  variant: string;
  forming: boolean;
  ts: number;
  endTs: number;
  distance: number;
  direction: number;
  breakoutUpPct: number | null;
  target: number | null;
  tell: string | null;
  source: string;
  bars: PatternBar[];
}

export interface PresetChartResult {
  epic: string;
  resolution: string;
  status: "ok" | "no-history" | "too-few-bars" | "error";
  error: string | null;
  hits: PresetHit[];
}

export interface PresetScanResult {
  charts: PresetChartResult[];
  elapsedMs: number;
}

/** snake_case created_at is intentional: it mirrors the backend's DTO. */
export interface UserPreset {
  id: string;
  name: string;
  epic: string;
  resolution: string;
  bars: PatternBar[];
  created_at: number;
}

export async function fetchFamilies(): Promise<PresetFamily[]> {
  const res = await apiFetch(`${BASE}/api/patterns/families`);
  if (!res.ok) throw new Error(await errorDetail(res, `fetch families failed (${res.status})`));
  const body = await res.json();
  return body.families;
}

export async function runPresetScan(req: {
  charts: { epic: string; resolution: string }[];
  families: { family: string; params: Record<string, number> }[];
  broker: string;
  priceSide: string;
}): Promise<PresetScanResult> {
  // Belt-and-braces: whatever fed `broker`/`priceSide` (a store field never
  // seeded this session, a stale prop, ...) an empty priceSide must never hit
  // the wire — the backend's PatternScanRequest.price_side is pattern-locked
  // to bid|mid|ask and 422s on "". Omit both when falsy so the server applies
  // its own defaults (priceSide -> "bid", broker -> its resolved default)
  // instead of a caller ever being able to reproduce that 422.
  const { charts, families, broker, priceSide } = req;
  const body: Record<string, unknown> = { charts, families };
  if (broker) body.broker = broker;
  if (priceSide) body.priceSide = priceSide;
  const res = await apiFetch(`${BASE}/api/patterns/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorDetail(res, `preset scan failed (${res.status})`));
  return res.json();
}

export async function listUserPresets(): Promise<UserPreset[]> {
  const res = await apiFetch(`${BASE}/api/patterns/presets`);
  if (!res.ok) throw new Error(await errorDetail(res, `fetch presets failed (${res.status})`));
  const body = await res.json();
  return body.presets;
}

export async function createUserPreset(p: {
  name: string;
  epic: string;
  resolution: string;
  bars: PatternBar[];
}): Promise<UserPreset> {
  const res = await apiFetch(`${BASE}/api/patterns/presets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(p),
  });
  if (!res.ok) throw new Error(await errorDetail(res, `create preset failed (${res.status})`));
  return res.json();
}

export async function renameUserPreset(id: string, name: string): Promise<void> {
  const res = await apiFetch(`${BASE}/api/patterns/presets/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(await errorDetail(res, `rename preset failed (${res.status})`));
}

export async function deleteUserPreset(id: string): Promise<void> {
  const res = await apiFetch(`${BASE}/api/patterns/presets/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await errorDetail(res, `delete preset failed (${res.status})`));
}
