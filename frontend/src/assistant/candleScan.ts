// candles_find: scan any date range of the focused market without moving the
// chart. Pure parts (derived fields, filter, result) plus the fetch that waits
// out the backend's partial fill.
import type { KLineData } from "klinecharts";
import { fetchRangeWithStatus } from "../lib/feed/candles";
import type { PriceSide } from "../theme";

export const SCAN_FIELDS = [
  "time", "weekday", "open", "high", "low", "close", "change%", "gap%", "afterWeekend",
] as const;
export type ScanField = (typeof SCAN_FIELDS)[number];
export const SCAN_OPS = [">", ">=", "<", "<=", "==", "!="] as const;
type Op = (typeof SCAN_OPS)[number];

export interface ScanRow {
  time: number;
  weekday: number;
  open: number;
  high: number;
  low: number;
  close: number;
  "change%": number | null;
  "gap%": number | null;
  afterWeekend: boolean;
}

export interface Cond { field: ScanField; op: Op; value: number | boolean }

const DAY_MS = 86_400_000;
const round3 = (x: number) => Math.round(x * 1000) / 1000;
const pct = (a: number, base: number) => (base ? round3(((a - base) / base) * 100) : null);

/** A UTC Saturday lies between the two opens: one starts after `prev`, or
 * `prev` is on a Saturday and `time` is on a later day. */
function saturdayBetween(prev: number, time: number): boolean {
  const prevDay = Math.floor(prev / DAY_MS);
  if (new Date(prev).getUTCDay() === 6 && Math.floor(time / DAY_MS) > prevDay) return true;
  for (let d = (prevDay + 1) * DAY_MS; d < time; d += DAY_MS) {
    if (new Date(d).getUTCDay() === 6) return true;
  }
  return false;
}

export function deriveRows(bars: KLineData[], barMs: number): ScanRow[] {
  // IG daily bars open 22:00-23:00 UTC the day before their session.
  const shift = barMs >= DAY_MS ? 6 * 3_600_000 : 0;
  return bars.map((b, i) => {
    const prev = i > 0 ? bars[i - 1] : null;
    return {
      time: b.timestamp,
      weekday: new Date(b.timestamp + shift).getUTCDay(),
      open: b.open, high: b.high, low: b.low, close: b.close,
      "change%": prev ? pct(b.close, prev.close) : null,
      "gap%": prev ? pct(b.open, prev.close) : null,
      afterWeekend: prev != null
        && b.timestamp - prev.timestamp > 1.5 * barMs
        && saturdayBetween(prev.timestamp, b.timestamp),
    };
  });
}

export function checkWhere(where: unknown): Cond[] {
  if (!Array.isArray(where)) throw new Error("where must be a list of {field, op, value}");
  return where.map((c) => {
    const { field, op, value } = (c ?? {}) as Record<string, unknown>;
    if (!SCAN_FIELDS.includes(field as ScanField)) {
      throw new Error(`unknown field ${String(field)} (one of ${SCAN_FIELDS.join(", ")})`);
    }
    if (!SCAN_OPS.includes(op as Op)) {
      throw new Error(`unknown op ${String(op)} (one of ${SCAN_OPS.join(" ")})`);
    }
    if (typeof value !== "number" && typeof value !== "boolean") {
      throw new Error(`value for ${String(field)} must be a number or true/false`);
    }
    return { field: field as ScanField, op: op as Op, value };
  });
}

function test(a: number | boolean, op: Op, b: number | boolean): boolean {
  switch (op) {
    case ">": return a > b;
    case ">=": return a >= b;
    case "<": return a < b;
    case "<=": return a <= b;
    case "==": return a === b;
    case "!=": return a !== b;
  }
}

export function matches(row: ScanRow, where: Cond[]): boolean {
  return where.every((c) => {
    const v = row[c.field];
    return v !== null && test(v, c.op, c.value);
  });
}

export interface ResultHead {
  epic: string;
  resolution: string;
  scanned: number;
  partial: boolean;
  degraded: string | null;
}

export function formatResult(
  head: ResultHead, rows: ScanRow[], fields: ScanField[], cap: number, extra: Record<string, unknown> = {},
): string {
  const all = rows.map((r) => fields.map((f) => r[f]));
  let out = all;
  const body = () => JSON.stringify({
    ...head, matched: rows.length, ...extra, cols: fields, rows: out, omitted: all.length - out.length,
  });
  // Drop the oldest 10% per pass rather than let the cap cut the JSON mid-row.
  while (out.length > 0 && body().length > cap - 64) out = out.slice(Math.max(1, Math.ceil(out.length / 10)));
  return body();
}

export interface FetchArgs {
  epic: string;
  resolution: string;
  fromMs: number;
  toMs: number;
  priceSide: PriceSide;
  broker: string;
  signal: AbortSignal;
  budgetMs?: number;
  now?: () => number;
}

/** One window read, asked again while the backend reports X-Candles-Partial
 * (its fill budget ran out), until it completes or `budgetMs` passes. */
export async function fetchFilled(a: FetchArgs): Promise<{ bars: KLineData[]; partial: boolean; degraded: string | null }> {
  const now = a.now ?? Date.now;
  const deadline = now() + (a.budgetMs ?? 30_000);
  for (;;) {
    a.signal.throwIfAborted();
    const r = await fetchRangeWithStatus(
      a.epic, a.resolution, Math.floor(a.fromMs / 1000), Math.ceil(a.toMs / 1000), a.priceSide, a.broker, a.signal,
    );
    a.signal.throwIfAborted();
    if (!r.partial || now() >= deadline) return { bars: r.bars, partial: r.partial != null, degraded: r.degraded };
  }
}
