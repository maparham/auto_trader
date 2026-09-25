// Today's % change on tab chips: per tab from the tab context menu
// (ChartTab.barChange), all tabs from Appearance > Tabs (Settings.tabBarChange,
// the default, off). Always the DAILY change, whatever timeframe the chart
// shows: the live day bar's close vs the previous day's close (vs today's open
// when there is no previous bar). One feed per distinct lead epic: seed from
// the last two fetched day bars, then follow the live day stream. Background
// tabs mount no ChartCore, so this runs its own feeds, and only for the tabs
// that show it.

import { useEffect, useMemo, useRef, useState } from "react";
import type { KLineData } from "klinecharts";
import { fetchRecent, openLive } from "./feed";
import type { PriceSide } from "../theme";

const DAY = "DAY";

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
      let live = false;
      // The day bar being tracked and the close before it. A live frame for a
      // newer day rolls today's bar into the reference.
      let cur: KLineData | undefined;
      let prevClose: number | undefined;
      const put = (bar: KLineData | undefined) => {
        if (bar == null) return;
        if (cur != null && bar.timestamp > cur.timestamp) prevClose = cur.close;
        if (cur == null || !(bar.timestamp < cur.timestamp)) cur = bar;
        const pct = dayChangePct(cur.close, prevClose ?? cur.open);
        if (pct != null) pending.current[epic] = pct;
      };
      void fetchRecent(epic, DAY, 2, priceSide, brokerId)
        .then((bars) => {
          if (closed) return;
          if (!live) {
            prevClose = bars[bars.length - 2]?.close;
            put(bars[bars.length - 1]);
            return;
          }
          // A live frame already beat the seed; it is the newer bar, but it
          // still needs the reference: the last seeded day before it.
          if (prevClose == null && cur != null) {
            const t = cur.timestamp;
            prevClose = bars.filter((b) => b.timestamp < t).pop()?.close;
            put(cur);
          }
        })
        .catch(() => {});
      const handle = openLive(
        epic,
        DAY,
        (k) => {
          if (closed) return;
          live = true;
          put(k);
        },
        undefined,
        priceSide,
        brokerId,
      );
      map.set(epic, {
        close: () => {
          closed = true;
          handle.close();
        },
      });
    }
  }, [leadsKey, brokerId, priceSide]);

  return pcts;
}
