// Today's % change on tab chips: per tab from the tab context menu
// (ChartTab.barChange), all tabs from Appearance > Tabs (Settings.tabBarChange,
// the default, off). Always the DAILY change, whatever timeframe the chart
// shows: the last price vs the previous day's close. One feed per distinct
// lead epic. Background tabs mount no ChartCore, so this runs its own feeds,
// and only for the tabs that show it.
//
// The reference comes from the last two DAY bars, polled; the price from
// that poll and, between polls, a MINUTE stream. A DAY stream alone is not
// enough: Capital pushes its DAY OHLC lazily and the backend yields nothing
// until the first one, so a DAY socket can sit silent for minutes, and with
// ~30 chips some streams never deliver at all. So the poll carries the chip
// and the stream only makes it tick. A failed or degraded poll (the backend
// could not refresh the tail) retries sooner: at boot every chip fetches at
// once and some time out. Until a fresh poll lands, a live frame from a newer
// day rolls the seeded day forward (the cache holds closed bars only, so a
// stale tail is usually just missing today's bar).

import { useEffect, useMemo, useRef, useState } from "react";
import type { KLineData } from "klinecharts";
import { fetchRecentWithStatus, openLive } from "./feed";
import type { PriceSide } from "../theme";

const DAY_MS = 86_400_000;
// A live frame further than this past the seeded day means the seed is stale
// (not a weekend or holiday gap): wait for a fresh seed instead of rolling.
const MAX_ROLL_MS = 5 * DAY_MS;
const POLL_MS = 60_000;
const SEED_RETRY_MS = [2_000, 5_000, 15_000, 30_000];
// Seeds in flight at once, so a boot with ~30 chips does not queue every
// fetch behind the browser's per-host connection cap and time them out.
const SEED_CONCURRENCY = 4;

let seedsInFlight = 0;
const seedQueue: Array<() => void> = [];
async function limitSeed<T>(run: () => Promise<T>): Promise<T> {
  if (seedsInFlight >= SEED_CONCURRENCY) {
    await new Promise<void>((resolve) => seedQueue.push(resolve));
  }
  seedsInFlight += 1;
  try {
    return await run();
  } finally {
    seedsInFlight -= 1;
    seedQueue.shift()?.();
  }
}

/** Last price vs a reference price, in percent; null when it can't be computed. */
export function dayChangePct(close: number | undefined, ref: number | undefined): number | null {
  if (close == null || ref == null || !Number.isFinite(close) || !Number.isFinite(ref) || ref === 0) {
    return null;
  }
  return ((close - ref) / ref) * 100;
}

/** "+0.42%" / "-1.30%" / "0.00%". */
export function fmtBarChange(pct: number): string {
  const s = pct.toFixed(2);
  if (s === "0.00" || s === "-0.00") return "0.00%";
  return pct > 0 ? `+${s}%` : `${s}%`;
}

// Ticks land far faster than a chip needs to repaint; coalesce them.
const FLUSH_MS = 1000;

/** Today's % change per epic. */
export function useTabBarChange(
  epics: string[],
  brokerId: string,
  priceSide: PriceSide,
): Record<string, number> {
  // Stable key so the diff below runs only when the SET of epics changes.
  const leadsKey = useMemo(() => JSON.stringify([...new Set(epics)].sort()), [epics]);
  const [pcts, setPcts] = useState<Record<string, number>>({});
  const pending = useRef<Record<string, number>>({});
  // One feed per lead, kept across renders so toggling one tab opens or
  // closes just that lead's feed instead of reconnecting all of them.
  const feeds = useRef(new Map<string, { close: () => void }>());

  // A broker or price-side change puts every feed on the wrong stream: close
  // them all here, and the diff effect below reopens them. React runs every
  // cleanup before any setup, so the diff sees the emptied map.
  useEffect(() => {
    const map = feeds.current;
    const timer = setInterval(() => {
      if (Object.keys(pending.current).length === 0) return;
      const next = pending.current;
      pending.current = {};
      setPcts((prev) => ({ ...prev, ...next }));
    }, FLUSH_MS);
    return () => {
      clearInterval(timer);
      map.forEach((f) => f.close());
      map.clear();
      pending.current = {};
    };
  }, [brokerId, priceSide]);

  useEffect(() => {
    const keys = new Set<string>(JSON.parse(leadsKey));
    const map = feeds.current;
    for (const [key, feed] of map) {
      if (!keys.has(key)) {
        feed.close();
        map.delete(key);
      }
    }
    // A lead shown again briefly keeps its old value in `pcts` (callers read
    // only the leads they show) until this feed's first value flushes.
    for (const epic of keys) {
      if (map.has(epic)) continue;
      let closed = false;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      // The seeded day (its bar open), the close it is measured against, and
      // the latest price. `live` is the newest stream frame, kept so a frame
      // that beats the seed still counts once the seed lands.
      let dayT: number | undefined;
      let ref: number | undefined;
      let price: number | undefined;
      let live: KLineData | undefined;
      const emit = () => {
        const pct = dayChangePct(price, ref);
        if (pct != null) pending.current[epic] = pct;
      };
      const applyLive = (k: KLineData) => {
        live = k;
        if (dayT == null) return;
        if (k.timestamp >= dayT + DAY_MS) {
          if (k.timestamp >= dayT + MAX_ROLL_MS) return;
          // A newer day: the old day's last price is the new reference.
          ref = price;
          dayT += Math.floor((k.timestamp - dayT) / DAY_MS) * DAY_MS;
        } else if (k.timestamp < dayT) {
          return;
        }
        price = k.close;
        emit();
      };
      const seed = (attempt: number) => {
        void limitSeed(() => fetchRecentWithStatus(epic, "DAY", 2, priceSide, brokerId))
          .then(({ bars, degraded }) => {
            if (closed) return;
            const last = bars[bars.length - 1];
            // Empty is a 404: no daily history for this epic, nothing to poll.
            if (last == null) return;
            dayT = last.timestamp;
            ref = bars[bars.length - 2]?.close ?? last.open;
            price = last.close;
            emit();
            // A frame that beat this poll only matters if it is from a newer day.
            if (live && live.timestamp >= dayT + DAY_MS) applyLive(live);
            if (degraded) retry(attempt);
            else next(0, POLL_MS);
          })
          .catch(() => retry(attempt));
      };
      const next = (attempt: number, ms: number) => {
        if (!closed) retryTimer = setTimeout(() => seed(attempt), ms);
      };
      const retry = (attempt: number) =>
        next(attempt + 1, SEED_RETRY_MS[attempt] ?? POLL_MS);
      seed(0);
      const handle = openLive(
        epic,
        "MINUTE",
        (k) => {
          if (!closed) applyLive(k);
        },
        undefined,
        priceSide,
        brokerId,
      );
      map.set(epic, {
        close: () => {
          closed = true;
          clearTimeout(retryTimer);
          handle.close();
        },
      });
    }
  }, [leadsKey, brokerId, priceSide]);

  return pcts;
}
