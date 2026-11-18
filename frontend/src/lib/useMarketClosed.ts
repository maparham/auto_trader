import { useEffect, useState } from "react";
import { fetchMarketMeta } from "./feed";

export interface MarketClosedState {
  closed: boolean;
  nextOpen: string | null;
}

const OPEN: MarketClosedState = { closed: false, nextOpen: null };
// How often an open (or unknown) market is checked again, so a close shows
// while the ticket stays open.
const RECHECK_MS = 60_000;

/** Whether `epic` is closed on `brokerId`, from the backend's shared market
 * status (GET /api/market). Unknown reads as open, so a failed lookup never
 * blocks an order. A closed market with a known reopen time is checked again
 * just after it; otherwise every minute. */
export function useMarketClosed(epic: string, brokerId: string, enabled = true): MarketClosedState {
  const [state, setState] = useState<MarketClosedState>(OPEN);
  useEffect(() => {
    setState(OPEN);
    if (!enabled || !epic) return;
    let alive = true;
    let timer: number | undefined;
    const check = () => {
      void fetchMarketMeta(epic, brokerId).then((m) => {
        if (!alive) return;
        const closed = m.closed === true;
        setState({ closed, nextOpen: closed ? m.nextOpen : null });
        const reopen = closed && m.nextOpen ? Date.parse(m.nextOpen) - Date.now() + 2000 : NaN;
        const ms = Number.isFinite(reopen) ? Math.min(Math.max(1000, reopen), RECHECK_MS * 10) : RECHECK_MS;
        timer = window.setTimeout(check, ms);
      });
    };
    check();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [epic, brokerId, enabled]);
  return state;
}
