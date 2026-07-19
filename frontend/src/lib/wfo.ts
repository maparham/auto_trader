// Walk-forward optimization config, payload builder, and persistence.

import type { WfoAxis, WalkForwardPayload, WfoSchedule, WfoObjective } from "../api";
import { axisValues, enumerateCombos, type SweepAxis } from "./sweep";

export const TRAIN_SPAN_PICKS = ["2w", "1m", "3m", "6m"] as const;

export interface WfoConfigState {
  trainSpans: string[];          // >=1 selected; first = primary, rest = matrix
  testSpan: string;              // default "1m"
  step: string | null;           // null = testSpan
  mode: "rolling" | "anchored";  // default "rolling"
  metric: string;                // default "sharpe"
  selection: "best" | "plateau"; // default "plateau"
}

export const DEFAULT_WFO_CONFIG: WfoConfigState = {
  trainSpans: ["3m"],
  testSpan: "1m",
  step: null,
  mode: "rolling",
  metric: "sharpe",
  selection: "plateau",
};

/**
 * Converts SweepAxis[] to WfoAxis[], filtering out period and timeWindow axes.
 * Returns the converted wfoAxes, the surviving usable SweepAxis[], and dropped labels.
 *
 * Conversions:
 * - RangeAxis -> {kind:"range", targets:[target, ...(mirrorTarget?[mirrorTarget]:[])], values: axisValues(a)}
 * - ListAxis -> {kind:"list", targets: Object.keys(options[0].patch)} — but DROP (into `dropped`, by label)
 *   any period axis (kind === "period") and any list axis whose option patches contain a key
 *   starting with "period:" or "timeWindow:" (backend 422s those in WFO combos).
 */
export function wfoAxesFromSweepAxes(axes: SweepAxis[]): {
  wfoAxes: WfoAxis[];
  usable: SweepAxis[];
  dropped: string[];
} {
  const wfoAxes: WfoAxis[] = [];
  const usable: SweepAxis[] = [];
  const dropped: string[] = [];

  for (const axis of axes) {
    // Drop period axes
    if (axis.kind === "period") {
      dropped.push(axis.label);
      continue;
    }

    // Handle list axes: check if any option patch contains period: or timeWindow: keys
    if (axis.kind === "list") {
      const hasForbiddenKey = axis.options.some((opt) =>
        Object.keys(opt.patch).some((k) => k.startsWith("period:") || k.startsWith("timeWindow:"))
      );
      if (hasForbiddenKey) {
        dropped.push(axis.label);
        continue;
      }

      // Convert list axis: targets are the keys from the first option's patch
      const targets = Object.keys(axis.options[0].patch);
      wfoAxes.push({ kind: "list", targets });
      usable.push(axis);
      continue;
    }

    // Handle range axes
    if (axis.kind === "range") {
      const targets = [axis.target];
      if (axis.mirrorTarget) {
        targets.push(axis.mirrorTarget);
      }
      const values = axisValues(axis);
      wfoAxes.push({ kind: "range", targets, values });
      usable.push(axis);
    }
  }

  return { wfoAxes, usable, dropped };
}

/**
 * Builds a complete WalkForwardPayload from sweep axes and WFO config.
 *
 * Throws Error("add at least one parameter axis") when usable axes produce 0 combos,
 * and Error("select a training span") when cfg.trainSpans is empty.
 */
export function buildWalkForwardPayload(
  axes: SweepAxis[],
  cfg: WfoConfigState,
): { payload: WalkForwardPayload; comboTotal: number; dropped: string[] } {
  const { wfoAxes, usable, dropped } = wfoAxesFromSweepAxes(axes);

  // Check for training span
  if (cfg.trainSpans.length === 0) {
    throw new Error("select a training span");
  }

  // Enumerate combos from usable axes
  const combos = enumerateCombos(usable);

  // Check for at least one parameter axis
  if (combos.length === 0) {
    throw new Error("add at least one parameter axis");
  }

  const schedule: WfoSchedule = {
    mode: cfg.mode,
    trainSpan: cfg.trainSpans[0],
    testSpan: cfg.testSpan,
    step: cfg.step ?? undefined,
  };

  const objective: WfoObjective = {
    metric: cfg.metric,
    selection: cfg.selection,
  };

  const matrixTrainSpans = cfg.trainSpans.slice(1);

  const payload: WalkForwardPayload = {
    combos,
    axes: wfoAxes,
    schedule,
    objective,
    matrixTrainSpans: matrixTrainSpans.length > 0 ? matrixTrainSpans : undefined,
  };

  return { payload, comboTotal: combos.length, dropped };
}
