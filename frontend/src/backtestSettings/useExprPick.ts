// Chart-side inputs to the rule expression editors: the one armed "pick from
// chart" row, and the live chart's referenceable panes.
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { BacktestConfig } from "../lib/backtestConfig";
import type { ChartController } from "../lib/chartController";
import type { ExprInstance } from "../lib/expr/catalog";
import { pickedIndicatorToken } from "../lib/exprPick";
import { exprInstancesFromChart } from "../lib/indicators";
import { toast } from "../lib/notify";

export function useExprPick(controller: ChartController | null, setCfg: Dispatch<SetStateAction<BacktestConfig>>) {
  // "Pick from chart" (expression editor): a rule row arms the chart, the user
  // clicks an on-chart indicator, and its expression token (e.g. "EMA(9)") is
  // appended to that row. Single source of truth for WHICH row is armed lives
  // here (not per-section), so arming a second row replaces the first and the
  // one chart click can only ever insert once. Mirrors the rangePick wiring.
  const [exprPickArmed, setExprPickArmed] = useState<
    { group: "longEntry" | "longExit" | "shortEntry" | "shortExit"; row: number } | null
  >(null);
  const exprPickArmedRef = useRef(exprPickArmed);
  exprPickArmedRef.current = exprPickArmed;
  useEffect(() => {
    if (!controller) return;
    const unsub = controller.indicatorPickResult.subscribe((sel) => {
      const target = exprPickArmedRef.current;
      if (!sel || !target) return;
      controller.indicatorPickResult.set(null); // consume one-shot
      setExprPickArmed(null);
      controller.indicatorPickArmed.set(false);
      // pickedIndicatorToken owns the chart-side normalisation — notably a click
      // on a Slope's acceleration companion, a separate instance the expression
      // language spells as an OUTPUT of its parent ("SLOPE.accel9").
      const token = controller.chart ? pickedIndicatorToken(controller.chart, sel) : null;
      if (!token) {
        toast("That indicator has no expression equivalent.");
        return;
      }
      setCfg((c) => {
        const g = c[target.group] as { rules: Array<{ expr?: string }> };
        const rules = g.rules.map((r, i) => (i === target.row ? { ...r, expr: (r.expr ?? "") + token } : r));
        return { ...c, [target.group]: { ...g, rules } };
      });
    });
    return () => {
      unsub();
      controller.indicatorPickArmed.set(false); // never leave the chart armed if the panel closes
    };
  }, [controller, setCfg]);
  const exprPick = controller
    ? {
        armed: exprPickArmed,
        arm: (group: "longEntry" | "longExit" | "shortEntry" | "shortExit", row: number) => {
          setExprPickArmed({ group, row });
          controller.indicatorPickArmed.set(true);
        },
        disarm: () => {
          setExprPickArmed(null);
          controller.indicatorPickArmed.set(false);
        },
      }
    : undefined;
  return exprPick;
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
