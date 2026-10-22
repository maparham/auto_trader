// "Pick from chart" for any expression field: a field arms the chart, the
// user clicks an on-chart indicator, and its expression token goes to that
// field. Several hooks can be mounted at once (backtest panel, screener) and
// all hear the controller's one indicatorPickResult, so a module-level owner
// token decides who gets the click: arming takes ownership, and a hook whose
// ownership was taken drops its own armed target.
import { useEffect, useRef, useState } from "react";
import type { ChartController } from "./chartController";
import { pickedIndicatorToken } from "./exprPick";
import { toast } from "./notify";
import { Signal } from "./signals";

const owner = new Signal<symbol | null>(null);

export interface IndicatorPick<T> {
  armed: T | null;
  arm: (target: T) => void;
  disarm: () => void;
}

export function useIndicatorPick<T>(
  controller: ChartController | null,
  onToken: (target: T, token: string) => void,
): IndicatorPick<T> | undefined {
  const [me] = useState(() => Symbol("indicatorPick"));
  const [armed, setArmed] = useState<T | null>(null);
  const armedRef = useRef(armed);
  armedRef.current = armed;
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

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
      // pickedIndicatorToken owns the chart-side normalisation, notably a click
      // on a Slope's acceleration companion, which the expression language
      // spells as an OUTPUT of its parent ("SLOPE.accel9").
      const token = controller.chart ? pickedIndicatorToken(controller.chart, sel) : null;
      if (!token) {
        toast("That indicator has no expression equivalent.");
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
      if (owner.value === me) owner.set(null);
      setArmed(null);
      controller.indicatorPickArmed.set(false);
    },
  };
}
