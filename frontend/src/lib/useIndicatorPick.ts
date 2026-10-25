// "Pick from chart" for any expression field: a field arms the chart, the
// user clicks an on-chart indicator, and its expression token goes to that
// field. Several hooks can be mounted at once (backtest panel, screener) and
// all hear the controller's one indicatorPickResult, so a module-level owner
// token decides who gets the click: arming takes ownership, and a hook whose
// ownership was taken drops its own armed target.
import { useEffect, useRef, useState } from "react";
import type { ChartController, SelectedIndicator } from "./chartController";
import { pickedIndicatorChoices, pickedIndicatorToken } from "./exprPick";
import { pickChoiceRequest } from "./pickChoice";
import { toast } from "./notify";
import { Signal } from "./signals";
import type { PickedLine } from "./pickedLines";

const owner = new Signal<symbol | null>(null);

export interface IndicatorPick<T> {
  armed: T | null;
  arm: (target: T) => void;
  disarm: () => void;
}

export function useIndicatorPick<T>(
  controller: ChartController | null,
  onToken: (target: T, token: string) => void,
  onLine?: (target: T, line: PickedLine) => void,
  // A field that cannot take this pick says why; the toast replaces the insert.
  refuse?: (sel: SelectedIndicator) => string | null,
): IndicatorPick<T> | undefined {
  const [me] = useState(() => Symbol("indicatorPick"));
  const [armed, setArmed] = useState<T | null>(null);
  const armedRef = useRef(armed);
  armedRef.current = armed;
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;
  const onLineRef = useRef(onLine);
  onLineRef.current = onLine;
  const refuseRef = useRef(refuse);
  refuseRef.current = refuse;

  useEffect(() => owner.subscribe((o) => { if (o !== me) setArmed(null); }), [me]);

  useEffect(() => {
    if (!controller) return;
    const unsub = controller.indicatorPickResult.subscribe((sel) => {
      const target = armedRef.current;
      if (!sel || target === null || owner.value !== me) return;
      controller.indicatorPickResult.set(null); // consume one-shot
      setArmed(null);
      owner.set(null);
      controller.indicatorPickArmed.set(false);
      const refusal = refuseRef.current?.(sel);
      if (refusal) {
        toast(refusal);
        return;
      }
      if (sel.lineRefusal && onLineRef.current) {
        toast(sel.lineRefusal);
        return;
      }
      if (sel.line && onLineRef.current) {
        onLineRef.current(target, sel.line);
        return;
      }
      // pickedIndicatorToken owns the chart-side normalisation, notably a click
      // on a Slope's acceleration companion, which the expression language
      // spells as an OUTPUT of its parent ("SLOPE.accel9").
      const token = controller.chart ? pickedIndicatorToken(controller.chart, sel) : null;
      if (!token) {
        toast("That indicator has no expression equivalent.");
        return;
      }
      // A pane with several sensible outputs asks which one; the field gets
      // whatever the user picks, or nothing if they dismiss the menu.
      const choices = controller.chart ? pickedIndicatorChoices(controller.chart, sel) : null;
      if (choices && choices.length > 1) {
        const deliver = onTokenRef.current;
        pickChoiceRequest.set({ options: choices, onChoose: (t) => deliver(target, t) });
        return;
      }
      onTokenRef.current(target, token);
    });
    return () => {
      unsub();
      if (owner.value === me) {
        owner.set(null);
        controller.indicatorPickArmed.set(false); // never leave the chart armed if the panel closes
      }
    };
  }, [controller, me]);

  if (!controller) return undefined;
  return {
    armed,
    arm: (target) => {
      owner.set(me);
      setArmed(target);
      controller.indicatorPickArmed.set(true);
    },
    disarm: () => {
      // Same ownership gate as the effect cleanup: a hook that never armed
      // (or whose ownership was already taken by a later arm) must not clear
      // the shared chart flag out from under whichever hook actually owns it.
      if (owner.value === me) {
        owner.set(null);
        controller.indicatorPickArmed.set(false);
      }
      setArmed(null);
    },
  };
}
