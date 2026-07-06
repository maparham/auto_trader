/** Which broker deal ids were opened by the live engine, so the dock/chart can
 *  tag them `strat` (engine-owned) vs manual. The broker's netted position
 *  doesn't carry who placed it, so we remember the deal ids the engine filled.
 *  Persisted device-locally so the tag survives a reload. */
import { Signal } from "./signals";

const KEY = "auto-trader.live.strategyDeals";

function loadIds(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set<string>();
  }
}

let ids = loadIds();

/** Bumped whenever the set changes, so the dock re-renders its badges. */
export const strategyDealsVersion = new Signal<number>(0);

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...ids]));
  } catch {
    /* quota / private mode — tag is best-effort */
  }
  strategyDealsVersion.set(strategyDealsVersion.value + 1);
}

export function markStrategyDeal(id: string | null | undefined): void {
  if (!id || ids.has(id)) return;
  ids.add(id);
  persist();
}

export function isStrategyDeal(id: string): boolean {
  return ids.has(id);
}

export function forgetStrategyDeal(id: string | null | undefined): void {
  if (!id || !ids.has(id)) return;
  ids.delete(id);
  persist();
}
