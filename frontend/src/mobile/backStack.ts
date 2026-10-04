// Android back closes the topmost open sheet before it navigates or leaves
// the app. Each open sheet registers a closer; the Android shell (MainActivity)
// asks the page first on every back press through window.__chartkarBack, which
// runs the top closer. No history entries: a WebView's own back skips entries
// pushed without a user gesture, and under StrictMode's double effects a
// pushState racing the cleanup's history.back() left the stack and the
// history out of step. Android app only: elsewhere nothing registers.
import { useEffect, useRef } from "react";
import { inAndroidApp } from "../lib/shellBridge";

type Closer = () => void;

const stack: Closer[] = [];

/** One back press: closes the topmost sheet. True means a sheet took the
 *  press; false lets the shell go back in the WebView or leave the app. */
export function handleBackPress(): boolean {
  const top = stack.pop();
  if (!top) return false;
  top();
  return true;
}
if (typeof window !== "undefined") {
  (window as unknown as { __chartkarBack?: () => boolean }).__chartkarBack = handleBackPress;
}

/** Registers a closer for an open sheet; the returned release drops it when
 *  the sheet closes some other way (its own UI, a tap outside). */
export function pushBackCloser(close: Closer): () => void {
  stack.push(close);
  return () => {
    const i = stack.lastIndexOf(close);
    if (i !== -1) stack.splice(i, 1);
  };
}

export function useBackClose(active: boolean, onClose: Closer): void {
  const ref = useRef(onClose);
  useEffect(() => {
    ref.current = onClose;
  });
  useEffect(() => {
    if (!active || !inAndroidApp()) return;
    return pushBackCloser(() => ref.current());
  }, [active]);
}
