// Session-only state for the backtest bar inspector (idea 2). The per-bar trace
// ships with a run's result and is held here in memory only — never persisted, so
// after a reload the user re-runs to inspect again. Only one backtest panel is
// open at a time (auto-trader.backtestOpen is a single global flag), so this
// global state is unambiguous.

import { Signal } from "./signals";
import type { BarTrace } from "../api";

// Is inspect mode active? While on, a candle-pane click selects a bar to inspect
// instead of the chart's normal click behaviour.
export const inspectModeSignal = new Signal<boolean>(false);

// The trace for the current run, keyed by bar open time (unix seconds), or null
// when the open run carries no trace (ran without inspect, or a coded strategy).
export const inspectTraceSignal = new Signal<Map<number, BarTrace> | null>(null);

// The bar the user selected to inspect (unix seconds), or null when none.
export const inspectSelectedBarSignal = new Signal<number | null>(null);

// Replace the in-memory trace from a run's result. Pass undefined/null to clear.
export function setInspectTraces(barTraces?: BarTrace[] | null): void {
  if (!barTraces || barTraces.length === 0) {
    inspectTraceSignal.set(null);
    return;
  }
  inspectTraceSignal.set(new Map(barTraces.map((t) => [t.time, t])));
}

// Clear all inspector state (on a new run, or when results are cleared).
export function clearInspectTraces(): void {
  inspectTraceSignal.set(null);
  inspectSelectedBarSignal.set(null);
}

// The trace for a given bar time, or undefined when outside the run / no trace.
export function traceAt(time: number): BarTrace | undefined {
  return inspectTraceSignal.value?.get(time);
}
