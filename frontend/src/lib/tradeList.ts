// Imported trade lists (closed trades from an external sheet) for the Trade
// List panel: parse JSON or CSV into normalized rows, and the price math for
// sketching a closed trade as a tradeBox drawing (entry→exit as the reward
// zone, stop scanned from the bars the trade actually lived through).
import type { KLineData } from "klinecharts";
import { load, save } from "./persist/core";
import { zonedWallToUTC } from "./rangeWindow";

export interface TradeRow {
  symbol: string;
  side: "LONG" | "SHORT";
  entryTs: number; // ms UTC (midnight of the entry date)
  entryPrice: number;
  exitTs: number;
  exitPrice: number;
  /** Percent P/L: the sheet's own column, or derived from $ P/L over the
   *  entry notional (qty × entry price) when the sheet has qty but no %. */
  pctPL?: number;
  dollarPL?: number;
  /** Position size (shares/contracts). */
  qty?: number;
  /** Worst intra-trade drawdown, percent (adverse, so usually negative). */
  ddPct?: number;
  /** Recorded worst price the trade lived through (max adverse excursion);
   *  places the sketched stop exactly instead of the bar scan. */
  worstPrice?: number;
  /** True when the source stamp carried a time of day (not just a date). Timed
   *  trades anchor exactly and may drop to intraday TFs; date-only trades snap
   *  to daily bars and pin the chart to DAY. */
  hasTime?: boolean;
}

/** Why a parsed row is suspect. Flagging is advisory — the review stage decides
 *  which reasons to exclude, because a row that looks broken can be real (a
 *  delisted ticker genuinely exits at $0.00). */
export type DegenerateReason =
  | "unparseable"
  | "reversed"
  | "nonPositivePrice"
  | "duplicate";

export interface FlaggedGroup {
  reason: DegenerateReason;
  /** Positions in `trades`. Empty for "unparseable": those rows never built. */
  indices: number[];
  /** One human-readable line per offending row, for the review stage's list. */
  labels: string[];
}

export interface ParsedTradeList {
  trades: TradeRow[];
  /** Suspect rows grouped by reason; empty groups are omitted. */
  flagged: FlaggedGroup[];
  /** What the review stage excluded, kept on the saved list so a dropped row
   *  isn't invisible after the fact. Absent when nothing was excluded. */
  excluded?: Array<{ reason: DegenerateReason; count: number }>;
  /** IANA zone naive datetimes were interpreted in (import dropdown). */
  timezone?: string;
  /** Human label for the sheet (service/sheet fields when the JSON carries them). */
  label?: string;
  /** Rows dropped for missing/unparseable required fields. */
  skipped: number;
  /** Sheet symbol → broker epic, for symbols the review stage remapped. */
  symbolMap?: Record<string, string>;
}

// --- value parsing -----------------------------------------------------------

/** "$1,292.53" → 1292.53, "($1,915.00)" → -1915, "2.96%" → 2.96. */
function num(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== "string") return undefined;
  let s = raw.trim();
  if (!s) return undefined;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[$%\s,]/g, "");
  const v = Number(s);
  if (!Number.isFinite(v)) return undefined;
  return neg ? -v : v;
}

// --- timestamps --------------------------------------------------------------

interface Stamp {
  ts: number; // ms UTC
  hasTime: boolean; // false for a bare date
}

/** Wall-clock time in `timeZone` → UTC ms. Thin adapter (1-based month) over
 *  the range-window layer's DST-refined civil-time math — one implementation
 *  of this fiddly conversion in the codebase, not two. */
function zonedToUtc(
  y: number, mo: number, d: number, h: number, mi: number, sec: number,
  timeZone: string,
): number {
  return zonedWallToUTC(timeZone, y, mo - 1, d, h, mi, sec);
}

/** "08/24/2026", "2026-08-24 14:30", "2026-08-24T14:30:00Z", … → Stamp.
 *  A naive time of day is interpreted in `timezone` (UTC when omitted); an
 *  encoded zone (Z or ±HH:MM) always wins. Bare dates stay UTC midnight —
 *  they get snapped onto real daily bars at draw time, so the zone choice
 *  can't shift them across a day boundary. */
function stampOf(raw: unknown, timezone?: string): Stamp | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const t = Date.parse(s.replace(" ", "T"));
    if (Number.isFinite(t)) return { ts: t, hasTime: true };
  }
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  let y: number, mo: number, d: number;
  if (m) {
    y = Number(m[3]); mo = Number(m[1]); d = Number(m[2]);
  } else {
    m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
    if (!m) return undefined;
    y = Number(m[1]); mo = Number(m[2]); d = Number(m[3]);
  }
  if (m[4] == null) return { ts: Date.UTC(y, mo - 1, d), hasTime: false };
  const h = Number(m[4]), mi = Number(m[5]), sec = m[6] ? Number(m[6]) : 0;
  const ts = timezone && timezone !== "UTC"
    ? zonedToUtc(y, mo, d, h, mi, sec, timezone)
    : Date.UTC(y, mo - 1, d, h, mi, sec);
  return { ts, hasTime: true };
}

function sideOf(raw: unknown): "LONG" | "SHORT" | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim().toUpperCase();
  if (s === "LONG" || s === "BUY") return "LONG";
  if (s === "SHORT" || s === "SELL") return "SHORT";
  return undefined;
}

// --- row assembly ------------------------------------------------------------

interface RawRow {
  symbol?: unknown;
  side?: unknown;
  entryDate?: unknown;
  entryPrice?: unknown;
  exitDate?: unknown;
  exitPrice?: unknown;
  pctPL?: unknown;
  dollarPL?: unknown;
  qty?: unknown;
  ddPct?: unknown;
  worstPrice?: unknown;
}

function toRow(r: RawRow, timezone?: string): TradeRow | null {
  const symbol = typeof r.symbol === "string" ? r.symbol.trim().toUpperCase() : "";
  const side = sideOf(r.side);
  const entry = stampOf(r.entryDate, timezone);
  const entryPrice = num(r.entryPrice);
  const exit = stampOf(r.exitDate, timezone);
  const exitPrice = num(r.exitPrice);
  if (!symbol || !side || !entry || entryPrice == null || !exit || exitPrice == null) {
    return null;
  }
  const qty = num(r.qty);
  const dollarPL = num(r.dollarPL);
  let pctPL = num(r.pctPL);
  if (pctPL == null && dollarPL != null && qty != null && qty > 0 && entryPrice !== 0) {
    pctPL = (100 * dollarPL) / (qty * Math.abs(entryPrice));
  }
  return {
    symbol,
    side,
    entryTs: entry.ts,
    entryPrice,
    exitTs: exit.ts,
    exitPrice,
    pctPL,
    dollarPL,
    qty,
    ddPct: num(r.ddPct),
    worstPrice: num(r.worstPrice),
    hasTime: entry.hasTime || exit.hasTime,
  };
}

/** "AXP SHORT 2025-08-29 → 2025-02-13" — one review-list line for a row. */
function rowLabel(t: TradeRow): string {
  const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);
  return `${t.symbol} ${t.side} ${day(t.entryTs)} → ${day(t.exitTs)}`;
}

/** Group the suspect rows in a parsed sheet by reason. A row can appear under
 *  several reasons; the review stage excludes it if ANY of its groups is
 *  excluded, so no precedence between reasons is needed. */
/** "Tax Selling / To Offset / Huge 2020 / Profits" — the first few raw cells of
 *  a row that never parsed, so the review stage can show what it is dropping. */
function rawLabel(r: RawRow): string {
  return [r.symbol, r.side, r.entryDate, r.entryPrice]
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v !== "")
    .join(" / ") || "(blank row)";
}

function flagDegenerate(trades: TradeRow[], unparsed: RawRow[]): FlaggedGroup[] {
  const found = new Map<DegenerateReason, number[]>();
  const flag = (reason: DegenerateReason, i: number) => {
    const at = found.get(reason);
    if (at) at.push(i);
    else found.set(reason, [i]);
  };
  const seen = new Set<string>();
  trades.forEach((t, i) => {
    if (t.exitTs < t.entryTs) flag("reversed", i);
    if (t.entryPrice <= 0 || t.exitPrice <= 0) flag("nonPositivePrice", i);
    // Identical on every field a trade is identified by: a sheet listing the
    // same fill twice. The first occurrence stands; later ones are the repeat.
    const key = [t.symbol, t.side, t.entryTs, t.exitTs, t.entryPrice, t.exitPrice].join("|");
    if (seen.has(key)) flag("duplicate", i);
    else seen.add(key);
  });
  const groups: FlaggedGroup[] = [...found].map(([reason, indices]) => ({
    reason,
    indices,
    labels: indices.map((i) => rowLabel(trades[i])),
  }));
  if (unparsed.length > 0) {
    groups.unshift({ reason: "unparseable", indices: [], labels: unparsed.map(rawLabel) });
  }
  return groups;
}

/** The list to actually import: every row belonging to an excluded reason is
 *  dropped, and what went is recorded on `excluded` so the saved list still
 *  says so. A row named by two excluded reasons is dropped (and counted) once.
 *  The result carries no `flagged` groups — the decision has been made. */
export function applyExclusions(
  parsed: ParsedTradeList,
  excluded: ReadonlySet<DegenerateReason>,
): ParsedTradeList {
  const drop = new Set<number>();
  const record: Array<{ reason: DegenerateReason; count: number }> = [];
  for (const g of parsed.flagged) {
    if (!excluded.has(g.reason)) continue;
    // "unparseable" rows are already absent from `trades`; their count comes
    // from the group's labels, not from indices that don't exist.
    const count = g.reason === "unparseable" ? g.labels.length : g.indices.length;
    if (count > 0) record.push({ reason: g.reason, count });
    for (const i of g.indices) drop.add(i);
  }
  return {
    ...parsed,
    trades: parsed.trades.filter((_, i) => !drop.has(i)),
    flagged: [],
    excluded: record.length > 0 ? record : undefined,
  };
}

function assemble(raws: RawRow[], label?: string, timezone?: string): ParsedTradeList {
  const trades: TradeRow[] = [];
  const unparsed: RawRow[] = [];
  for (const r of raws) {
    const row = toRow(r, timezone);
    if (row) trades.push(row);
    else unparsed.push(r);
  }
  if (trades.length === 0) throw new Error("no trades recognized in the input");
  return {
    trades,
    flagged: flagDegenerate(trades, unparsed),
    label,
    skipped: unparsed.length,
    timezone,
  };
}

// --- JSON --------------------------------------------------------------------

function parseJson(text: string, timezone?: string): ParsedTradeList {
  const data = JSON.parse(text) as unknown;
  const raws = Array.isArray(data)
    ? (data as RawRow[])
    : data && typeof data === "object" && Array.isArray((data as { trades?: unknown }).trades)
      ? (data as { trades: RawRow[] }).trades
      : null;
  if (!raws) throw new Error("no trades found: expected an array or an object with a trades[] field");
  let label: string | undefined;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const d = data as { service?: unknown; sheet?: unknown };
    const parts = [d.service, d.sheet].filter((p): p is string => typeof p === "string");
    if (parts.length > 0) label = parts.join(" ");
  }
  return assemble(raws, label, timezone);
}

// --- CSV ---------------------------------------------------------------------

/** Split one CSV line honoring double-quoted fields (with "" escapes). */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Fuzzy header → field. Normalizes to lowercase (keeping % and $), then
 *  keyword-matches: entry/open vs exit/close crossed with date vs price. */
function headerField(h: string): keyof RawRow | null {
  const n = h.toLowerCase().replace(/[^a-z0-9%$]/g, "");
  const has = (...ws: string[]) => ws.some((w) => n.includes(w));
  // Drawdown stats first ("DD Quant" must not reach the qty branch): the
  // percent and worst-price columns are real fields, the rest ("DD $",
  // "DD Time") stay ignored — none of them may read as the trade's P/L.
  if (n.startsWith("dd") || has("drawdown")) {
    if (has("%", "pct", "percent")) return "ddPct";
    if (has("worst") && has("price")) return "worstPrice";
    return null;
  }
  if (has("worst")) return has("price") ? "worstPrice" : null;
  // Quantity ("Qty Open" sits before "Avg Price Open" in collective2 exports,
  // so it must not read as a price). The closing-side twin stays ignored —
  // mapping both would trip validateMapping's duplicate check.
  if (has("qty", "quant", "shares", "contracts", "size")) {
    return has("close", "exit") ? null : "qty";
  }
  if (has("descrip")) return null; // company name, not the symbol
  const isDate = has("date", "time", "day");
  if (has("symbol", "ticker", "instrument", "epic")) return "symbol";
  if (has("side", "direction", "position")) return "side";
  if (has("entry", "open")) return isDate ? "entryDate" : "entryPrice";
  if (has("exit", "close")) return isDate ? "exitDate" : "exitPrice";
  if (has("%", "pct", "percent")) return "pctPL";
  if (has("$", "dollar", "pl", "pnl", "profit", "gain")) return "dollarPL";
  return null;
}

/** A normalized trade field a source column can map onto. */
export type TradeField = keyof RawRow;

export const TRADE_FIELD_LABELS: Record<TradeField, string> = {
  symbol: "Symbol",
  side: "Side",
  entryDate: "Entry date",
  entryPrice: "Entry price",
  exitDate: "Exit date",
  exitPrice: "Exit price",
  pctPL: "% P/L",
  dollarPL: "$ P/L",
  qty: "Qty",
  ddPct: "DD %",
  worstPrice: "Worst price",
};

const REQUIRED_FIELDS: TradeField[] = [
  "symbol", "side", "entryDate", "entryPrice", "exitDate", "exitPrice",
];

/** A CSV split and guessed but NOT yet turned into trades: the review stage
 *  shows the guessed column mapping (with sample values) for correction
 *  before finalizeCsvImport commits it. */
export interface PendingCsvImport {
  headers: string[];
  /** headerField's proposal per column (null = ignore) — a starting point. */
  guesses: Array<TradeField | null>;
  /** Up to the first 3 data values per column, for eyeballing the mapping. */
  samples: string[][];
  /** Parsed data rows (cells), kept so finalize needn't re-split. */
  rows: string[][];
}

const SAMPLE_ROWS = 3;

/** Stage 1: split the CSV and propose a column mapping. Throws only on an
 *  unusable sheet (no header/data rows) — a poor guess is what the review
 *  stage exists to fix, not an error. */
export function prepareCsvImport(text: string): PendingCsvImport {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) throw new Error("CSV needs a header row and at least one trade row");
  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
  const rows = lines.slice(1).map(splitCsvLine);
  return {
    headers,
    guesses: headers.map(headerField),
    samples: headers.map((_, c) => rows.slice(0, SAMPLE_ROWS).map((r) => r[c] ?? "")),
    rows,
  };
}

/** The review stage's gate: every required field mapped exactly once, nothing
 *  mapped twice. Returns a human-readable problem, or null when clean. */
export function validateMapping(mapping: Array<TradeField | null>): string | null {
  const counts = new Map<TradeField, number>();
  for (const f of mapping) {
    if (f) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  const dup = [...counts].filter(([, c]) => c > 1).map(([f]) => TRADE_FIELD_LABELS[f]);
  if (dup.length > 0) return `mapped more than once: ${dup.join(", ")}`;
  const missing = REQUIRED_FIELDS.filter((f) => !counts.has(f)).map((f) => TRADE_FIELD_LABELS[f]);
  if (missing.length > 0) return `not mapped to any column: ${missing.join(", ")}`;
  return null;
}

/** Distinct symbols (uppercased, source order) under the mapping's symbol
 *  column — what the review stage checks against the broker catalogue. */
export function pendingSymbols(
  pending: PendingCsvImport,
  mapping: Array<TradeField | null>,
): string[] {
  const col = mapping.indexOf("symbol");
  if (col < 0) return [];
  const out: string[] = [];
  for (const cells of pending.rows) {
    const sym = (cells[col] ?? "").trim().toUpperCase();
    if (sym && !out.includes(sym)) out.push(sym);
  }
  return out;
}

/** Stage 2: build the trade list from the user-approved mapping. */
export function finalizeCsvImport(
  pending: PendingCsvImport,
  mapping: Array<TradeField | null>,
  opts?: { timezone?: string },
): ParsedTradeList {
  const problem = validateMapping(mapping);
  if (problem) throw new Error(`column mapping: ${problem}`);
  const raws: RawRow[] = pending.rows.map((cells) => {
    const r: RawRow = {};
    mapping.forEach((f, i) => {
      if (f) r[f] = cells[i];
    });
    return r;
  });
  return assemble(raws, undefined, opts?.timezone);
}

function parseCsv(text: string, timezone?: string): ParsedTradeList {
  const pending = prepareCsvImport(text);
  return finalizeCsvImport(pending, pending.guesses, { timezone });
}

// --- entry point -------------------------------------------------------------

/** Parse a trade list from JSON or CSV text (auto-detected). `timezone` is the
 *  IANA zone naive datetimes are interpreted in (UTC when omitted; stamps with
 *  an encoded zone are always taken as-is). Throws with a human-readable
 *  reason when nothing parseable is found. */
export function parseTradeList(
  text: string,
  opts?: { timezone?: string },
): ParsedTradeList {
  const t = text.trim();
  const tz = opts?.timezone;
  return t.startsWith("{") || t.startsWith("[") ? parseJson(t, tz) : parseCsv(t, tz);
}

// --- trade box price math ----------------------------------------------------

type Bar = Pick<KLineData, "timestamp" | "high" | "low">;

/** Where the sketched stop goes for a CLOSED trade: just past the extreme the
 *  price actually reached over the trade's life — lowest low for a long,
 *  highest high for a short — buffered by 10% of the entry→exit range so the
 *  zone edge doesn't sit exactly on a wick. No candles (data gap): fall back
 *  to the entry/exit extreme itself. */
export function computeTradeStop(
  side: "LONG" | "SHORT",
  entryPrice: number,
  exitPrice: number,
  bars: readonly Bar[],
  worstPrice?: number,
): number {
  const range = Math.abs(entryPrice - exitPrice);
  // Flat trade: buffer off the scanned bars' span instead, else a token 0.5%
  // of entry so the stop is still visibly apart from the zone.
  const barSpan = bars.length > 0
    ? Math.max(...bars.map((b) => b.high)) - Math.min(...bars.map((b) => b.low))
    : 0;
  const buffer = 0.1 * (range || barSpan || Math.abs(entryPrice) * 0.005);
  // A recorded worst price (the sheet's own MAE) beats the bar scan: it's the
  // trade's ground truth, where chart candles are only an approximation.
  if (worstPrice != null) {
    return side === "LONG" ? worstPrice - buffer : worstPrice + buffer;
  }
  if (side === "LONG") {
    const lo = bars.length > 0 ? Math.min(...bars.map((b) => b.low)) : Math.min(entryPrice, exitPrice);
    return lo - buffer;
  }
  const hi = bars.length > 0 ? Math.max(...bars.map((b) => b.high)) : Math.max(entryPrice, exitPrice);
  return hi + buffer;
}

/** Snap an imported date to a real bar so overlay anchors land on candles. */
export function nearestCandleTs(bars: readonly Bar[], ts: number): number {
  if (bars.length === 0) return ts;
  let best = bars[0].timestamp;
  for (const b of bars) {
    if (Math.abs(b.timestamp - ts) < Math.abs(best - ts)) best = b.timestamp;
  }
  return best;
}

// --- the import library ------------------------------------------------------
// Every import is saved permanently as a NAMED list. Storage goes through the
// persist helpers, so the library rides the same localStorage-plus-backend
// mirror as the rest of the workspace (survives reloads, browsers, devices).


export interface SavedTradeList extends ParsedTradeList {
  id: string;
  name: string;
  createdAt: number; // ms epoch of the import
}

const LISTS_KEY = "auto-trader.tradeLists";
// The panel's original one-slot save (pre-library). Folded into the library on
// first read so an existing import isn't lost, then removed.
const LEGACY_KEY = "at.tradeList.v1";

function migrateLegacy(): void {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return;
    localStorage.removeItem(LEGACY_KEY);
    const legacy = JSON.parse(raw) as ParsedTradeList;
    if (!Array.isArray(legacy.trades) || legacy.trades.length === 0) return;
    addTradeList(legacy, legacy.label ?? "Imported list");
  } catch {
    /* unreadable legacy slot: nothing to migrate */
  }
}

/** All saved imports, newest first. */
export function listTradeLists(): SavedTradeList[] {
  migrateLegacy();
  return load<SavedTradeList[]>(LISTS_KEY, []);
}

/** Save an import under a name (file name minus extension, sheet label, …);
 *  no name falls back to the sheet's label, then a dated default. */
export function addTradeList(parsed: ParsedTradeList, name?: string): SavedTradeList {
  const createdAt = Date.now();
  const entry: SavedTradeList = {
    ...parsed,
    id: crypto.randomUUID(),
    name: name ?? parsed.label ?? `Imported ${new Date(createdAt).toISOString().slice(0, 10)}`,
    createdAt,
  };
  // A dropped write (storage full) leaves localStorage on its PREVIOUS value, so
  // the import simply didn't happen. Saying so beats returning an entry the
  // caller renders as saved and the next reload has never heard of.
  if (!save(LISTS_KEY, [entry, ...load<SavedTradeList[]>(LISTS_KEY, [])])) {
    throw new Error(
      "the list could not be saved: browser storage is full — delete an old list or backtest and try again",
    );
  }
  return entry;
}

export function renameTradeList(id: string, name: string): void {
  save(
    LISTS_KEY,
    load<SavedTradeList[]>(LISTS_KEY, []).map((l) => (l.id === id ? { ...l, name } : l)),
  );
}

export function deleteTradeList(id: string): void {
  save(LISTS_KEY, load<SavedTradeList[]>(LISTS_KEY, []).filter((l) => l.id !== id));
}

/** "smart-money-2026.json" → "smart-money-2026" (last extension only). */
export function nameFromFilename(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i > 0 ? filename.slice(0, i) : filename;
}

/** The tradeBox drawing for a closed trade: entry→exit as the trade's zone
 *  (the overlay reads direction from the points, so a short's exit below entry
 *  paints correctly), stop from computeTradeStop over the bars the trade
 *  actually spanned. Anchors snap to real bars when candles are available so
 *  the box edges land on candles, not between them. */
export function tradeBoxSpec(
  trade: TradeRow,
  bars: readonly (Bar & { timestamp: number })[],
): { points: Array<{ timestamp: number; value: number }>; text: string } {
  // Date-only trades snap onto real daily bars; timed trades anchor exactly.
  let entryTs = trade.hasTime ? trade.entryTs : nearestCandleTs(bars, trade.entryTs);
  let exitTs = trade.hasTime ? trade.exitTs : nearestCandleTs(bars, trade.exitTs);
  if (entryTs === exitTs) {
    // A same-day trade snapped onto ONE candle: all three points on a single
    // timestamp is a zero-width strip the persist layer scrubs as degenerate.
    // Widen by one bar — forward when there is one, back otherwise.
    const next = bars.find((b) => b.timestamp > exitTs);
    const prev = [...bars].reverse().find((b) => b.timestamp < entryTs);
    if (next) exitTs = next.timestamp;
    else if (prev) entryTs = prev.timestamp;
    else exitTs = entryTs + 86_400_000;
  }
  const lo = Math.min(entryTs, exitTs);
  const hi = Math.max(entryTs, exitTs);
  // Daily bars are stamped at UTC midnight — BEFORE a timed entry the same
  // day — so the scan starts at the entry's day floor or the entry-day
  // extreme would be missed.
  const spanLo = Math.floor(lo / 86_400_000) * 86_400_000;
  const span = bars.filter((b) => b.timestamp >= spanLo && b.timestamp <= hi);
  const stop = computeTradeStop(trade.side, trade.entryPrice, trade.exitPrice, span, trade.worstPrice);
  return {
    points: [
      { timestamp: entryTs, value: trade.entryPrice },
      { timestamp: exitTs, value: trade.exitPrice },
      { timestamp: exitTs, value: stop },
    ],
    text: `${trade.symbol} ${trade.side}${trade.pctPL != null ? ` ${trade.pctPL.toFixed(2)}%` : ""}`,
  };
}

// --- auto timeframe ----------------------------------------------------------
// "Auto TF" mode picks the COARSEST interval that keeps the clicked trade's box
// readable: raise to a higher TF whenever the box would still span 7+ bars
// there (a 3-month swing needn't be 400 hourly candles), and lower when the
// current TF gives it fewer than 5 bars (a 3-day swing is unreadable as 3 daily
// candles). Raising needs 7 while staying only needs 5, so a box near the
// boundary doesn't flap between intervals. Bar counts are estimated from
// TRADING days (the daily candles fetched for the stop scan) times a
// per-interval bars-per-day rate (stock-session ballpark; precision is not the
// point, crossing the thresholds is).

const AUTO_TF_MIN_BARS = 5;
const AUTO_TF_RAISE_BARS = 7;
// Coarse → fine, native chart resolutions only (derived TFs are left alone).
const BARS_PER_TRADING_DAY: Array<[string, number]> = [
  ["WEEK", 0.2],
  ["DAY", 1],
  ["HOUR_4", 2],
  ["HOUR", 7],
  ["MINUTE_30", 13],
  ["MINUTE_15", 26],
  ["MINUTE_5", 78],
  ["MINUTE", 390],
];

/** The interval to switch to: the coarsest one giving the span 7+ bars when
 *  that's above the current interval, else finer until the span holds 5+ bars.
 *  Null when the current interval is already the pick (or isn't a known native
 *  one). */
export function autoTfResolution(current: string, tradingDays: number): string | null {
  const idx = BARS_PER_TRADING_DAY.findIndex(([r]) => r === current);
  if (idx < 0) return null;
  const days = Math.max(1, tradingDays);
  for (let i = 0; i < idx; i++) {
    if (days * BARS_PER_TRADING_DAY[i][1] >= AUTO_TF_RAISE_BARS) {
      return BARS_PER_TRADING_DAY[i][0];
    }
  }
  if (days * BARS_PER_TRADING_DAY[idx][1] >= AUTO_TF_MIN_BARS) return null;
  for (let i = idx + 1; i < BARS_PER_TRADING_DAY.length; i++) {
    if (days * BARS_PER_TRADING_DAY[i][1] >= AUTO_TF_MIN_BARS) {
      return BARS_PER_TRADING_DAY[i][0];
    }
  }
  return null; // already as fine as it goes
}

// The toggle (default ON) rides the persist mirror like the library itself.
const AUTO_TF_KEY = "auto-trader.tradeListAutoTf";

export function loadAutoTf(): boolean {
  return load<boolean>(AUTO_TF_KEY, true);
}

export function saveAutoTf(on: boolean): void {
  save(AUTO_TF_KEY, on);
}

// Same-tab mode (default ON): a clicked symbol that isn't open anywhere reuses
// ONE trade-list tab — each new symbol replaces the previous one — instead of
// piling up a tab per symbol while browsing a long list.
const SAME_TAB_KEY = "auto-trader.tradeListSameTab";

export function loadSameTab(): boolean {
  return load<boolean>(SAME_TAB_KEY, true);
}

export function saveSameTab(on: boolean): void {
  save(SAME_TAB_KEY, on);
}
