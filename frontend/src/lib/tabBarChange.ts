// Live-bar % change on tab chips: per tab from the tab context menu
// (ChartTab.barChange), all tabs from Appearance > Tabs (Settings.tabBarChange,
// the default, off). For every distinct lead (epic,
// resolution) across the tabs: seed from the latest fetched bar, then follow
// the live stream. Background tabs mount no ChartCore, so this runs its own
// feeds, and only for the tabs that show it.

import { useEffect, useMemo, useRef, useState } from "react";
import type { KLineData } from "klinecharts";
import { fetchRecent, openLive } from "./feed";
import type { PriceSide } from "../theme";

export interface BarLead {
  epic: string;
  resolution: string;
}

export function barLeadKey(epic: string, resolution: string): string {
  return JSON.stringify([epic, resolution]);
}

/** Close vs open of one bar, in percent; null when it can't be computed. */
export function barChangePct(bar: Pick<KLineData, "open" | "close"> | undefined): number | null {
  if (bar == null || !Number.isFinite(bar.open) || !Number.isFinite(bar.close) || bar.open === 0) {
    return null;
  }
  return ((bar.close - bar.open) / bar.open) * 100;
}

/** "+0.42%" / "-1.30%" / "0.00%". */
export function fmtBarChange(pct: number): string {
  const s = pct.toFixed(2);
  if (s === "0.00" || s === "-0.00") return "0.00%";
  return pct > 0 ? `+${s}%` : `${s}%`;
}

// Ticks land far faster than a chip needs to repaint; coalesce them.
const FLUSH_MS = 1000;

/** % change of the live bar per lead, keyed by barLeadKey. */
export function useTabBarChange(
  leads: BarLead[],
  brokerId: string,
  priceSide: PriceSide,
): Record<string, number> {
  // Stable key so the diff below runs only when the SET of leads changes.
  const leadsKey = useMemo(
    () => JSON.stringify([...new Set(leads.map((l) => barLeadKey(l.epic, l.resolution)))].sort()),
    [leads],
  );
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
    for (const key of keys) {
      if (map.has(key)) continue;
      const [epic, resolution] = JSON.parse(key) as [string, string];
      let closed = false;
      let live = false;
      const put = (bar: KLineData | undefined) => {
        const pct = barChangePct(bar);
        if (pct != null) pending.current[key] = pct;
      };
      void fetchRecent(epic, resolution, 1, priceSide, brokerId)
        .then((bars) => {
          // A live frame already beat the seed; it is the newer bar.
          if (!closed && !live) put(bars[bars.length - 1]);
        })
        .catch(() => {});
      const handle = openLive(
        epic,
        resolution,
        (k) => {
          if (closed) return;
          live = true;
          put(k);
        },
        undefined,
        priceSide,
        brokerId,
      );
      map.set(key, {
        close: () => {
          closed = true;
          handle.close();
        },
      });
    }
  }, [leadsKey, brokerId, priceSide]);

  return pcts;
}
