import type { BacktestConfig, RuleGroup } from "./backtestConfig";
import { activeGroup } from "./backtestConfig";
import type { ClosenessAgg, ClosenessRequest } from "../api";

export type HeatmapSide = "long" | "short";

export interface HeatmapView {
  side: HeatmapSide;
  basis: "volatility" | "atr";
  width: number;
  window: number;
  atrLength: number;
  agg: ClosenessAgg;
  baseResolution: string; // the rule's authored resolution
}

export interface HeatmapWindow {
  broker: string;
  epic: string;
  priceSide: string;
  displayResolution: string;
  fromTime: number;
  toTime: number;
}

// Enabled expression rows of the active side's entry group, or null if none.
function activeRows(cfg: BacktestConfig, side: HeatmapSide): RuleGroup | null {
  const group = side === "long" ? cfg.longEntry : cfg.shortEntry;
  const active = activeGroup(group);
  return active.rules.length ? active : null;
}

export function buildClosenessRequest(
  cfg: BacktestConfig,
  view: HeatmapView,
  win: HeatmapWindow,
): ClosenessRequest | null {
  const group = activeRows(cfg, view.side);
  if (!group) return null;
  const rows = group.rules
    .map((r) => r.expr)
    .filter((e): e is string => typeof e === "string" && e.trim().length > 0);
  if (!rows.length) return null;
  return {
    broker: win.broker,
    epic: win.epic,
    priceSide: win.priceSide,
    rows,
    combine: group.combine,
    baseResolution: view.baseResolution,
    displayResolution: win.displayResolution,
    fromTime: win.fromTime,
    toTime: win.toTime,
    norm: { basis: view.basis, width: view.width, window: view.window, atrLength: view.atrLength },
    agg: view.agg,
  };
}

export function alignValuesToBars(
  barTimes: number[],
  resp: { times: number[]; values: (number | null)[] },
): (number | null)[] {
  const byTime = new Map<number, number | null>();
  for (let i = 0; i < resp.times.length; i++) byTime.set(resp.times[i], resp.values[i] ?? null);
  return barTimes.map((t) => (byTime.has(t) ? byTime.get(t)! : null));
}
