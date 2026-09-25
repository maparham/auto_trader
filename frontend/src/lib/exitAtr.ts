// Order-ticket exits measured in ATRs: the TP/SL rows can show and take their
// level as a multiple of ATR(length) on the focused chart's timeframe instead of
// a raw price. Prices stay the source of truth (the draft / pending edit still
// holds a price); ATR mode is only another view of that price and another way to
// type it, so chart-line drags, validation and Update are untouched.

import { useEffect, useState } from "react";
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
const ATR_REFRESH_MS = 60_000;

/** Coerce a typed/stored length to a whole number in [1, 500]; junk → 14. */
export function normalizeAtrLength(v: unknown): number {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_ATR_LENGTH;
  return Math.min(n, MAX_ATR_LENGTH);
}

/** Bars to fetch for a stable Wilder ATR: ~10 lengths of warm-up, 300 floor. */
export function atrFetchBars(length: number): number {
  return Math.min(MAX_BARS, Math.max(300, length * 10));
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
export function latestAtr(
  candles: Parameters<typeof atrSeries>[0],
  length: number,
): number | null {
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

/** Latest ATR(length) for an epic on a timeframe, refreshed every minute.
 *  `enabled` false (no row in ATR mode, or a replay session running) fetches
 *  nothing: a blind replay must not pull today's candles. */
export function useLatestAtr(opts: {
  epic: string;
  resolution: string | undefined;
  length: number;
  priceSide: PriceSide;
  brokerId: string | undefined;
  enabled: boolean;
}): number | null {
  const { epic, resolution, length, priceSide, brokerId, enabled } = opts;
  const [atr, setAtr] = useState<number | null>(null);
  useEffect(() => {
    setAtr(null);
    if (!enabled || !resolution) return;
    let alive = true;
    const tick = () =>
      fetchRecent(epic, resolution, atrFetchBars(length), priceSide, brokerId)
        .then((bars) => alive && setAtr(latestAtr(bars, length)))
        .catch(() => alive && setAtr(null));
    tick();
    const id = setInterval(tick, ATR_REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [epic, resolution, length, priceSide, brokerId, enabled]);
  return atr;
}
