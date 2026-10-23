// Chart-side inputs to the rule expression editors: the one armed "pick from
// chart" row, and the live chart's referenceable panes.
import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { BacktestConfig } from "../lib/backtestConfig";
import type { ChartController } from "../lib/chartController";
import type { ExprInstance } from "../lib/expr/catalog";
import { exprInstancesFromChart } from "../lib/indicators";
import { useIndicatorPick } from "../lib/useIndicatorPick";
import { lineGeoKey, mintLineId } from "../lib/pickedLines";

type Group = "longEntry" | "longExit" | "shortEntry" | "shortExit";

export function useExprPick(controller: ChartController | null, setCfg: Dispatch<SetStateAction<BacktestConfig>>) {
  // "Pick from chart" (expression editor): a rule row arms the chart, the user
  // clicks an on-chart indicator, and its expression token (e.g. "EMA(9)") is
  // appended to that row. One armed row at a time; the generic hook owns the
  // arm/consume cycle (lib/useIndicatorPick.ts).
  // A click on a Trendlines line freezes that line into the config as L<n>
  // (cfg.lines) and appends the bare id. Re-picking a line already held reuses
  // its id rather than minting a duplicate.
  const pick = useIndicatorPick<{ group: Group; row: number }>(
    controller,
    (target, token) => {
      setCfg((c) => {
        const g = c[target.group] as { rules: Array<{ expr?: string }> };
        const rules = g.rules.map((r, i) => (i === target.row ? { ...r, expr: (r.expr ?? "") + token } : r));
        return { ...c, [target.group]: { ...g, rules } };
      });
    },
    (target, line) => {
      setCfg((c) => {
        const key = lineGeoKey(line);
        const id = Object.entries(c.lines ?? {}).find(([, l]) => lineGeoKey(l) === key)?.[0] ?? mintLineId(c.lines);
        const g = c[target.group] as { rules: Array<{ expr?: string }> };
        const rules = g.rules.map((r, i) => (i === target.row ? { ...r, expr: (r.expr ?? "") + id } : r));
        return { ...c, [target.group]: { ...g, rules }, lines: { ...(c.lines ?? {}), [id]: line } };
      });
    },
  );
  return pick
    ? { armed: pick.armed, arm: (group: Group, row: number) => pick.arm({ group, row }), disarm: pick.disarm }
    : undefined;
}

export function useExprInstances(controller: ChartController | null): readonly ExprInstance[] {
  // The live chart's referenceable panes, injected into every expression editor
  // for lint + completion (`SLOPE.9`). Read off the CHART, not storage, so a
  // pane the user just retuned offers the outputs it draws right now — and
  // polled, because a pane's settings can change from its own modal with nothing
  // to subscribe to. The identity is held stable while the list is unchanged, so
  // the poll re-renders nothing in the common case.
  const [exprInstances, setExprInstances] = useState<readonly ExprInstance[]>([]);
  useEffect(() => {
    const key = (xs: readonly ExprInstance[]) =>
      xs.map((i) => `${i.id}:${i.outputs.join(",")}:${i.timeframe ?? ""}`).join("|");
    // The chart is read on EVERY tick, not captured once: this panel is not
    // modal and outlives chart lifecycles, so `controller.chart` can be null when
    // the effect first runs (the cell has not mounted its chart yet) and can be
    // replaced later (a tab switch disposes one and assigns another). Capturing
    // it would leave the editors with an empty pane list for the panel's whole
    // life — every valid `SLOPE.9` underlined as unknown — with no recovery.
    const read = () =>
      setExprInstances((prev) => {
        const chart = controller?.chart;
        const next = chart ? exprInstancesFromChart(chart) : [];
        return key(prev) === key(next) ? prev : next;
      });
    read();
    const t = setInterval(read, 1000);
    return () => clearInterval(t);
  }, [controller]);
  return exprInstances;
}
