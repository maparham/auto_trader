// Strategy-declared chart overlays: a coded strategy's meta can name chart
// indicators the UI keeps in sync with its params (e.g. BB Regime Breakout's
// "chart_overlays": [{"indicator": "BOLL", "calc_params": ["bb_period",
// "bb_dev"]}]), so the band the strategy trades on is visible on the candles.
// The managed instances are ordinary indicator instances tagged via their saved
// config's extendData ({ strategyOverlay: true }) — the tag is what separates
// them from indicators of the same type the user added by hand, and it survives
// reload with the config (hydrateIndicators re-applies it).

import type { Chart } from "klinecharts";
import type { ChartOverlaySpec, ParamSpec, ParamValues } from "../api";
import {
  addIndicatorInstance,
  getIndicatorById,
  removeIndicatorById,
  type IndicatorInstance,
} from "./indicators";
import {
  loadIndicatorConfigs,
  saveIndicatorConfig,
  saveIndicators,
} from "./persist";

export type { ChartOverlaySpec };

export interface DesiredOverlay {
  indicator: string;
  calcParams: number[];
}

/** The overlay's calcParams resolved from the tuned param values, falling back
 * to the schema defaults. Null when any named param has no numeric value —
 * the overlay is then skipped rather than drawn with garbage. */
export function resolveOverlayCalcParams(
  spec: ChartOverlaySpec,
  values: ParamValues | undefined,
  schema: ParamSpec[],
): number[] | null {
  const defaults = new Map(schema.map((p) => [p.name, p.default]));
  const out: number[] = [];
  for (const name of spec.calc_params) {
    const v = values?.[name] ?? defaults.get(name);
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    out.push(v);
  }
  return out;
}

/** Reconcile the chart's managed overlay instances with `desired`: create the
 * missing ones (tagged), retune existing ones in place, remove no-longer-wanted
 * ones. User-added instances of the same types are never touched (they lack the
 * tag). Persists both the instance list and per-instance configs; returns the
 * next instance list for the caller to publish (=== `current` items where
 * unchanged). */
export function syncStrategyOverlays(
  chart: Chart,
  scope: string,
  epic: string,
  current: IndicatorInstance[],
  desired: DesiredOverlay[],
): IndicatorInstance[] {
  const configs = loadIndicatorConfigs(scope);
  const isManaged = (inst: IndicatorInstance) =>
    configs[inst.id]?.extendData?.strategyOverlay === true;

  const managedByType = new Map<string, IndicatorInstance>();
  for (const inst of current) if (isManaged(inst)) managedByType.set(inst.type, inst);

  let next = current;
  const wantedTypes = new Set(desired.map((d) => d.indicator));

  // Drop managed instances whose type is no longer desired.
  for (const inst of current) {
    if (!isManaged(inst) || wantedTypes.has(inst.type)) continue;
    removeIndicatorById(chart, scope, inst.id);
    managedByType.delete(inst.type);
    next = next.filter((i) => i.id !== inst.id);
  }

  for (const d of desired) {
    const existing = managedByType.get(d.indicator);
    if (existing) {
      // Retune in place — overrideIndicator against the pane it lives on.
      const live = getIndicatorById(chart, existing.id);
      if (live) {
        chart.overrideIndicator({
          paneId: live.paneId,
          name: existing.id,
          calcParams: d.calcParams,
        });
      }
      saveIndicatorConfig(scope, existing.id, {
        ...configs[existing.id],
        calcParams: d.calcParams,
      });
      continue;
    }
    const inst = addIndicatorInstance(chart, scope, epic, d.indicator, {
      config: { calcParams: d.calcParams, extendData: { strategyOverlay: true } },
    });
    if (inst) next = [...next, inst];
  }

  if (next !== current) saveIndicators(scope, next);
  return next;
}
