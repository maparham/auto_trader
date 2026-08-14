// Keeps the focused chart's strategy-declared overlays (e.g. BB Regime's BOLL
// band) in sync with the backtest strategy setup, independent of the settings
// panel's lifecycle: the band retunes whether params change in the panel, via a
// preset restore, or through the agent bridge's backtest.config.set with the
// panel closed. Config source mirrors useProximityHeatmap: the panel's live
// config while it is open, the persisted last-used config otherwise — except
// while a live coded strategy is ARMED, when its frozen snapshot wins (the
// band shows what the engine actually trades; see source() below). Strategy
// meta (chart_overlays + param schema) comes from /api/strategies, cached at
// module level; while the list is unavailable (fetch in flight or failed) the
// sync SKIPS rather than treating it as "no overlays desired" — removing the
// managed band would wipe its saved config.
import { useEffect } from "react";
import { fetchStrategies, type StrategyInfo, type ParamValues } from "../api";
import type { ChartController } from "../lib/chartController";
import { backtestConfigLive, backtestStrategySetupChanged } from "../lib/signals";
import { liveStateSignal } from "../lib/liveController";
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

    const apply = (strategy: StrategyInfo | null, params: ParamValues | undefined, coded: boolean) => {
      const chart = controller.chart;
      if (disposed || !chart) return;
      if (coded && !strategy) return; // meta unavailable — keep the band as-is
      const overlays = coded ? (strategy?.chart_overlays ?? []) : [];
      const desired = overlays.flatMap((o) => {
        const calcParams = resolveOverlayCalcParams(o, params, strategy?.params ?? []);
        return calcParams ? [{ indicator: o.indicator, calcParams }] : [];
      });
      const next = syncStrategyOverlays(chart, controller.scope, epic, controller.indicators.value, desired);
      if (next !== controller.indicators.value) controller.indicators.set(next);
    };

    // Which strategy setup owns the band. An ARMED live coded strategy wins:
    // the band then shows what the engine actually trades — the FROZEN
    // snapshot's params, not the live panel's editable draft (which can drift
    // while armed) and not the backtest selection. Otherwise the backtest
    // panel's setup applies (live while open, persisted otherwise).
    const source = (): { filename: string; params: ParamValues | undefined } | null => {
      const live = liveStateSignal.value;
      const snap = live.status === "armed" ? live.snapshot : null;
      if (snap && snap.cfg.mode === "coded" && snap.cfg.codedStrategy) {
        return { filename: snap.cfg.codedStrategy, params: snap.coded?.params };
      }
      const cfg = backtestConfigLive.value ?? loadBacktestLastUsed() ?? defaultBacktestConfig();
      if (cfg.mode !== "coded" || !cfg.codedStrategy) return null;
      return { filename: cfg.codedStrategy, params: loadCodedCfg("backtest", cfg.codedStrategy).params };
    };

    const sync = () => {
      const src = source();
      if (!src) return apply(null, undefined, false);
      const meta = metaFor(src.filename);
      if (meta instanceof Promise) void meta.then((s) => apply(s, src.params, true));
      else apply(meta, src.params, true);
    };

    sync();
    const unsubs = [
      backtestConfigLive.subscribe(sync),
      backtestStrategySetupChanged.subscribe(sync),
      liveStateSignal.subscribe(sync),
    ];
    return () => {
      disposed = true;
      for (const u of unsubs) u();
    };
  }, [controller, epic]);
}
