// Order-ticket exits measured in ATRs: the TP/SL rows can show and take their
// level as a multiple of ATR(length) on the focused chart's timeframe instead of
// a raw price. Prices stay the source of truth (the draft / pending edit still
// holds a price); ATR mode is only another view of that price and another way to
// type it, so chart-line drags, validation and Update are untouched.

import { useEffect, useRef, useState } from "react";
import type { KLineData } from "klinecharts";
import { atrSeries } from "./atr";
import { fetchRecent } from "./feed";
import { PREFIX, load, save } from "./persist/core";
import { Signal } from "./signals";
import type { PriceSide } from "../theme";

export type ExitUnit = "price" | "atr";

export interface ExitAtrPrefs {
  tp: ExitUnit;
  sl: ExitUnit;
  length: number; // shared ATR length for both rows
}

export const DEFAULT_ATR_LENGTH = 14;
const MAX_ATR_LENGTH = 500;
// The backend caps one /api/candles fetch at 1000 bars.
const MAX_BARS = 1000;
// The chart's own bars are re-read this often (cheap, no network); a fetch
// fallback refreshes every minute, or sooner after a failure.
const CHART_POLL_MS = 3_000;
const FETCH_REFRESH_MS = 60_000;
const FETCH_RETRY_MS = 10_000;

/** Coerce a typed/stored length to a whole number in [1, 500]; junk → 14. */
export function normalizeAtrLength(v: unknown): number {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_ATR_LENGTH;
  return Math.min(n, MAX_ATR_LENGTH);
}

/** Bars to fetch for a stable Wilder ATR: ~10 lengths of warm-up. The 500
 *  floor is the chart's own initial load, so the request coalesces with it and
 *  hits the backend's warm cache instead of a cold build. */
export function atrFetchBars(length: number): number {
  return Math.min(MAX_BARS, Math.max(500, length * 10));
}

/** The level `mult` ATRs from `ref`, on the `up` side (long TP / short SL = up),
 *  rounded to the instrument's precision. */
export function levelFromAtr(
  ref: number,
  mult: number,
  atr: number,
  up: boolean,
  precision: number,
): number {
  return Number((ref + (up ? 1 : -1) * mult * atr).toFixed(precision));
}

/** How many ATRs `level` sits from `ref`, positive on the `up` side (the valid
 *  side for that exit), negative when the level is on the wrong side. */
export function atrMultiple(level: number, ref: number, atr: number, up: boolean): number {
  return ((level - ref) / atr) * (up ? 1 : -1);
}

/** Latest ATR(length) value (the forming bar, like the chart legend), or null. */
export function latestAtr(candles: KLineData[], length: number): number | null {
  const s = atrSeries(candles, length);
  for (let i = s.length - 1; i >= 0; i--) {
    const v = s[i];
    if (v != null && Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

// --- persisted unit + length (global preference) ----------------------------

const PREFS_KEY = `${PREFIX}.orderTicketExitUnits`;
const unit = (v: unknown): ExitUnit => (v === "atr" ? "atr" : "price");

function loadPrefs(): ExitAtrPrefs {
  const raw = load<Partial<ExitAtrPrefs>>(PREFS_KEY, {});
  return { tp: unit(raw.tp), sl: unit(raw.sl), length: normalizeAtrLength(raw.length ?? DEFAULT_ATR_LENGTH) };
}

// Lazily created so the first read happens after persist hydration, and shared
// so the new-order and edit forms (parent and child) agree on the units.
let prefsSignal: Signal<ExitAtrPrefs> | null = null;
const prefsStore = () => (prefsSignal ??= new Signal(loadPrefs()));

export function useExitAtrPrefs(): [ExitAtrPrefs, (p: Partial<ExitAtrPrefs>) => void] {
  const [prefs, setPrefs] = useState(() => prefsStore().value);
  useEffect(() => prefsStore().subscribe(setPrefs), []);
  const update = (p: Partial<ExitAtrPrefs>) => {
    const next = { ...prefsStore().value, ...p };
    save(PREFS_KEY, next);
    prefsStore().set(next);
  };
  return [prefs, update];
}

// --- live ATR value ----------------------------------------------------------

/** Latest ATR(length) for an epic on a timeframe.
 *  `chartCandles` reads the focused chart's loaded bars (pass it only when the
 *  chart shows this epic): that is the same series the user sees, needs no
 *  network, and works for custom timeframes a cold fetch can time out on. Only
 *  when the chart has too few bars does it fall back to fetching.
 *  `enabled` false (no row in ATR mode, or a replay session running) reads and
 *  fetches nothing: a blind replay must not pull today's candles. */
export function useLatestAtr(opts: {
  epic: string;
  resolution: string | undefined;
  length: number;
  priceSide: PriceSide;
  brokerId: string | undefined;
  enabled: boolean;
  chartCandles?: () => KLineData[] | undefined;
}): number | null {
  const { epic, resolution, length, priceSide, brokerId, enabled, chartCandles } = opts;
  const [atr, setAtr] = useState<number | null>(null);
  // Latest getter in a ref: App passes a fresh closure every render, which must
  // not restart the effect (and its fetch) each time.
  const chartRef = useRef(chartCandles);
  chartRef.current = chartCandles;
  useEffect(() => {
    setAtr(null);
    if (!enabled || !resolution) return;
    let alive = true;
    let inflight = false;
    let nextFetch = 0;
    const tick = () => {
      const bars = chartRef.current?.();
      const fromChart = bars && bars.length ? latestAtr(bars, length) : null;
      if (fromChart != null) {
        setAtr(fromChart);
        return;
      }
      if (inflight || Date.now() < nextFetch) return;
      inflight = true;
      fetchRecent(epic, resolution, atrFetchBars(length), priceSide, brokerId)
        .then((b) => {
          if (!alive) return;
          const v = latestAtr(b, length);
          setAtr(v);
          nextFetch = Date.now() + (v != null ? FETCH_REFRESH_MS : FETCH_RETRY_MS);
        })
        .catch(() => {
          if (alive) nextFetch = Date.now() + FETCH_RETRY_MS;
        })
        .finally(() => {
          inflight = false;
        });
    };
    tick();
    const id = setInterval(tick, CHART_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [epic, resolution, length, priceSide, brokerId, enabled]);
  return atr;
}
