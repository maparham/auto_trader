import { useCallback, useRef } from "react";

/** A function with a STABLE identity whose calls always reach the latest
 * `fn`. For handlers passed to memoized children: a fresh inline closure per
 * render defeats the memo, while a plain useCallback captures stale state.
 * The ref reassignment happens on every render, so the wrapped closure reads
 * current props/state at call time. */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}
