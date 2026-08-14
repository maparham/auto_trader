// Keeps the focused chart's strategy-declared overlays (e.g. BB Regime's BOLL
// band) in sync with the backtest strategy setup, independent of the settings
// panel's lifecycle: the band retunes whether params change in the panel, via a
// preset restore, or through the agent bridge's backtest.config.set with the
// panel closed. Config source mirrors useProximityHeatmap: the panel's live
// config while it is open, the persisted last-used config otherwise. Strategy
// meta (chart_overlays + param schema) comes from /api/strategies, cached at
// module level; while the list is unavailable (fetch in flight or failed) the
// sync SKIPS rather than treating it as "no overlays desired" — removing the
// managed band would wipe its saved config.
import { useEffect } from "react";
import { fetchStrategies, type StrategyInfo } from "../api";
import type { ChartController } from "../lib/chartController";
import { backtestConfigLive, backtestStrategySetupChanged } from "../lib/signals";
import { defaultBacktestConfig } from "../lib/backtestConfig";
import { loadBacktestLastUsed } from "../lib/persist";
import { loadCodedCfg } from "../lib/codedConfig";
import { resolveOverlayCalcParams, syncStrategyOverlays } from "../lib/strategyOverlays";

let strategyMeta: StrategyInfo[] | null = null;
let strategyMetaFetch: Promise<void> | null = null;

/** Test hook: forget the cached strategy list between cases. */
export function resetStrategyMetaCache(): void {
  strategyMeta = null;
  strategyMetaFetch = null;
}

// Resolve the cached list, fetching (once, shared) when it is absent or does
// not know `filename` (a strategy file added since the last fetch). Returns
// null while the list is unavailable — the caller skips the sync.
function metaFor(filename: string): StrategyInfo | null | Promise<StrategyInfo | null> {
  const hit = strategyMeta?.find((s) => s.filename === filename);
  if (hit) return hit;
  strategyMetaFetch ??= fetchStrategies()
    .then((list) => {
      strategyMeta = list;
    })
    .catch(() => {}) // failed fetch: stay null, retry on the next change
    .finally(() => {
      strategyMetaFetch = null;
    });
  return strategyMetaFetch.then(
    () => strategyMeta?.find((s) => s.filename === filename) ?? null,
  );
}

export function useStrategyOverlaySync(controller: ChartController | null, epic: string | null): void {
  useEffect(() => {
    if (!controller || !epic) return;
    let disposed = false;

    const apply = (strategy: StrategyInfo | null, coded: boolean) => {
      const chart = controller.chart;
      if (disposed || !chart) return;
      if (coded && !strategy) return; // meta unavailable — keep the band as-is
      const overlays = coded ? (strategy?.chart_overlays ?? []) : [];
      const params = coded && strategy
        ? loadCodedCfg("backtest", strategy.filename).params
        : undefined;
      const desired = overlays.flatMap((o) => {
        const calcParams = resolveOverlayCalcParams(o, params, strategy?.params ?? []);
        return calcParams ? [{ indicator: o.indicator, calcParams }] : [];
      });
      const next = syncStrategyOverlays(chart, controller.scope, epic, controller.indicators.value, desired);
      if (next !== controller.indicators.value) controller.indicators.set(next);
    };

    const sync = () => {
      const cfg = backtestConfigLive.value ?? loadBacktestLastUsed() ?? defaultBacktestConfig();
      const coded = cfg.mode === "coded" && !!cfg.codedStrategy;
      if (!coded) return apply(null, false);
      const meta = metaFor(cfg.codedStrategy!);
      if (meta instanceof Promise) void meta.then((s) => apply(s, true));
      else apply(meta, true);
    };

    sync();
    const unsubs = [
      backtestConfigLive.subscribe(sync),
      backtestStrategySetupChanged.subscribe(sync),
    ];
    return () => {
      disposed = true;
      for (const u of unsubs) u();
    };
  }, [controller, epic]);
}
