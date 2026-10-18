// React glue for lib/signals' Signal.
import { useCallback, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import type { Signal } from "./signals";

export function useSignalValue<T>(sig: Signal<T>): T {
  // Stable per signal, so a per-frame signal does not resubscribe each render.
  const subscribe = useCallback((cb: () => void) => sig.subscribe(cb), [sig]);
  return useSyncExternalStore(subscribe, () => sig.value);
}

/** A setState-shaped writer for a Signal, so callers written against a state
 * setter keep their bail-out-on-same-value behaviour. */
export function signalSetter<T>(sig: Signal<T>): Dispatch<SetStateAction<T>> {
  return (action) => {
    const next = typeof action === "function" ? (action as (prev: T) => T)(sig.value) : action;
    if (!Object.is(next, sig.value)) sig.set(next);
  };
}
