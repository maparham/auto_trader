// The order ticket's Move SL / Move TP draft. One module-level signal is the
// single source of truth: the ticket controls read from it and write to it, and
// the chart draws its trigger / target lines from it.
import type { AlertCondition, MoveTarget } from "./alertsApi";
import { Signal } from "./signals";

export interface MoveRuleDraft {
  on: boolean;
  level: number;
  condition: AlertCondition;
  target: MoveTarget;
}
export interface MoveDraftState {
  epic: string;
  dealId: string | null;
  side: "buy" | "sell";
  sl: MoveRuleDraft | null;
  tp: MoveRuleDraft | null;
}

export const moveDraftSignal = new Signal<MoveDraftState | null>(null);

/** Long SL and short TP trigger going up, long TP and short SL going down. */
export function defaultCondition(field: "sl" | "tp", side: "buy" | "sell"): AlertCondition {
  const up = (field === "sl") === (side === "buy");
  return up ? "crossing_up" : "crossing_down";
}

/** SL: 1R in the trade's favor from `ref` (0.5% when there is no SL).
 *  TP: halfway to the SL, against the trade (0.5% when there is no SL). */
export function defaultTriggerLevel(
  field: "sl" | "tp", side: "buy" | "sell", ref: number, sl: number | null, tp: number | null,
): number {
  void tp;
  const long = side === "buy";
  const risk = sl != null ? Math.abs(ref - sl) : null;
  if (field === "sl") {
    const d = risk != null && risk > 0 ? risk : ref * 0.005;
    return long ? ref + d : ref - d;
  }
  const d = risk != null && risk > 0 ? risk / 2 : ref * 0.005;
  return long ? ref - d : ref + d;
}

/** Set one level of a field's draft in place ("target" becomes a price target). */
export function setMoveLevel(field: "sl" | "tp", which: "trigger" | "target", level: number): void {
  const cur = moveDraftSignal.value;
  const d = cur?.[field];
  if (!cur || !d) return;
  moveDraftSignal.set({
    ...cur,
    [field]: which === "trigger" ? { ...d, level } : { ...d, target: { type: "price", value: level } },
  });
}
