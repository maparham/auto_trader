// Earnings dates for the chart's earnings markers (EarningsMarkers.tsx). The
// backend answers from Yahoo for equities only (GET /api/market/{epic}/earnings)
// and [] for everything else. Past rows carry the reported EPS; the next
// scheduled report has only the estimate. The upcoming date can move, so the
// list is cached per broker+epic for a few hours rather than the whole session.

import { API_BASE as BASE, apiFetch } from "./http";
import { isSynthetic } from "./syntheticRegistry";
import { splitBarIndex, splitDateText } from "./splits";

type Bar = { timestamp: number };

export interface Earnings {
  timeMs: number;
  epsEstimate: number | null;
  /** null until the quarter is reported. */
  epsActual: number | null;
  surprisePct: number | null;
  /** Consensus for the upcoming report only (Yahoo keeps no past estimates). */
  revenueEstimate: number | null;
  /** The last ~5 reported quarters only. */
  revenueActual: number | null;
  /** Before the open, during the session or after the close; null when Yahoo
   * gave only the date. Its times are hour-rounded, so this is all they say. */
  session: EarningsSession | null;
}

export type EarningsSession = "pre" | "intraday" | "post";

const SESSIONS: Record<EarningsSession, string> = {
  pre: "Before open",
  intraday: "During market hours",
  post: "After close",
};

const TTL_MS = 6 * 3600_000;
const cache = new Map<string, { at: number; p: Promise<Earnings[]> }>();

export function _resetEarningsCache(): void {
  cache.clear();
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Earnings for an epic, oldest first. [] on any failure, which is not cached. */
export function fetchEarnings(epic: string, brokerId: string): Promise<Earnings[]> {
  if (isSynthetic(epic)) return Promise.resolve([]);
  const key = `${brokerId}|${epic}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.p;
  const p = (async (): Promise<Earnings[]> => {
    const url = `${BASE}/api/market/${encodeURIComponent(epic)}/earnings?broker=${encodeURIComponent(brokerId)}`;
    const res = await apiFetch(url);
    if (!res.ok) throw new Error(`earnings ${res.status}`);
    const d = (await res.json()) as { earnings?: Record<string, unknown>[] };
    return (d.earnings ?? [])
      .filter((e) => typeof e.time === "number" && Number.isFinite(e.time))
      .map((e) => ({
        timeMs: (e.time as number) * 1000,
        epsEstimate: num(e.epsEstimate),
        epsActual: num(e.epsActual),
        surprisePct: num(e.surprisePct),
        revenueEstimate: num(e.revenueEstimate),
        revenueActual: num(e.revenueActual),
        session: typeof e.session === "string" && e.session in SESSIONS ? (e.session as EarningsSession) : null,
      }))
      .sort((a, b) => a.timeMs - b.timeMs);
  })().catch(() => {
    cache.delete(key);
    return [] as Earnings[];
  });
  cache.set(key, { at: Date.now(), p });
  return p;
}

const eps = (v: number) => v.toFixed(2);

/** "113.4B", "950.0M", "1.2T". */
export function revenueText(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e12) return `${(v / 1e12).toFixed(1)}T`;
  if (a >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  return v.toFixed(0);
}

export interface EarningsRow {
  label: string;
  estimate: string | null;
  actual: string | null;
}

/** The popup's content: a heading, the status line, and a grid of figures
 * (estimate vs actual), with the EPS surprise beneath it. A figure Yahoo does
 * not have is null; a row with neither is dropped. */
export interface EarningsView {
  date: string;
  status: "Reported" | "Estimated";
  session: string | null;
  rows: EarningsRow[];
  /** Whether the grid has an Actual column (any figure reported). */
  hasActual: boolean;
  surprise: { text: string; tone: "pos" | "neg" | "flat" } | null;
}

export function earningsView(e: Earnings): EarningsView {
  const rows: EarningsRow[] = [
    {
      label: "EPS",
      estimate: e.epsEstimate != null ? eps(e.epsEstimate) : null,
      actual: e.epsActual != null ? eps(e.epsActual) : null,
    },
    {
      label: "Revenue",
      estimate: e.revenueEstimate != null ? revenueText(e.revenueEstimate) : null,
      actual: e.revenueActual != null ? revenueText(e.revenueActual) : null,
    },
  ].filter((r) => r.estimate != null || r.actual != null);
  const sp = e.epsActual != null ? e.surprisePct : null;
  return {
    date: splitDateText(e.timeMs),
    status: e.epsActual == null ? "Estimated" : "Reported",
    session: e.session ? SESSIONS[e.session] : null,
    rows,
    hasActual: rows.some((r) => r.actual != null),
    surprise:
      sp == null
        ? null
        : {
            text: `${sp > 0 ? "+" : ""}${sp.toFixed(1)}%`,
            tone: sp > 0.05 ? "pos" : sp < -0.05 ? "neg" : "flat",
          },
  };
}

/** Chip size in px (EarningsMarkers.tsx); the projection keeps it on the pane. */
export const EARNINGS_CHIP = 14;

export interface EarningsMarker {
  key: string;
  x: number;
  earnings: Earnings;
  /** "Earnings 30 Jul 2026": the chip's accessible name. */
  label: string;
  upcoming: boolean;
  /** Sits one chip higher: a split chip already holds this spot. */
  lift: boolean;
}

/** Bars per millisecond over the last `window` bars: how densely this symbol's
 * bars fall in wall time, sessions and weekends included. Projects a future
 * date onto the bar grid without knowing the exchange calendar. */
export function barsPerMs(bars: readonly Bar[], window = 500): number | null {
  const n = bars.length;
  if (n < 2) return null;
  const a = bars[Math.max(0, n - window)].timestamp;
  const span = bars[n - 1].timestamp - a;
  return span > 0 ? (Math.min(n, window) - 1) / span : null;
}

/** Pixel markers for earnings on visible bars, plus a future report past the
 * last bar when the chart's right-side space reaches it (skipped otherwise).
 * `toX` projects a bar timestamp; `barSpace` is the pixel width of one bar;
 * `avoidXs` are split chip centres, which push a coinciding chip up a row. */
export function projectEarningsMarkers(
  earnings: readonly Earnings[],
  bars: readonly Bar[],
  barMs: number,
  visible: { from: number; to: number },
  toX: (timestamp: number) => number | null,
  barSpace: number,
  paneW: number,
  chipW: number,
  avoidXs: readonly number[] = [],
): EarningsMarker[] {
  const n = bars.length;
  if (n === 0) return [];
  const out: EarningsMarker[] = [];
  const lastTs = bars[n - 1].timestamp;
  let lastX: number | null | undefined;
  let density: number | null | undefined;
  for (const e of earnings) {
    let x: number | null;
    if (e.timeMs >= lastTs + barMs) {
      // Past the loaded bars: only an unreported (upcoming) date goes there.
      if (e.epsActual != null) continue;
      lastX ??= toX(lastTs);
      density ??= barsPerMs(bars);
      if (lastX == null || density == null) continue;
      x = lastX + Math.max(1, Math.round((e.timeMs - lastTs) * density)) * barSpace;
    } else {
      const i = splitBarIndex(bars, e.timeMs, barMs);
      if (i < 0 || i < visible.from || i > visible.to) continue;
      x = toX(bars[i].timestamp);
    }
    if (x == null || x < 0 || x + chipW / 2 > paneW) continue;
    const at = x;
    out.push({
      key: `earn:${e.timeMs}`,
      x,
      earnings: e,
      label: `Earnings ${splitDateText(e.timeMs)}`,
      upcoming: e.epsActual == null,
      lift: avoidXs.some((sx) => Math.abs(sx - at) < chipW),
    });
  }
  return out;
}
