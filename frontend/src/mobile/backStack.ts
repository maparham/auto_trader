// Android back closes the topmost open sheet before it navigates or leaves
// the app. Each open sheet pushes one history entry and a closer; the back
// press pops the entry and runs the top closer. Closing a sheet from its own
// UI pops its entry with history.back() and skips that one popstate, so the
// two paths stay in sync. Android app only: the web app keeps its history
// untouched.
import { useEffect, useRef } from "react";
import { inAndroidApp } from "../lib/shellBridge";

type Closer = () => void;

const stack: Closer[] = [];
let skipNextPop = false;
let installed = false;

function onPop(): void {
  if (skipNextPop) {
    skipNextPop = false;
    return;
  }
  stack.pop()?.();
}

export function pushBackCloser(close: Closer): () => void {
  if (!installed) {
    window.addEventListener("popstate", onPop);
    installed = true;
  }
  stack.push(close);
  window.history.pushState({ chartkarSheet: true }, "");
  return () => {
    const i = stack.lastIndexOf(close);
    if (i === -1) return; // already closed by a back press
    stack.splice(i, 1);
    skipNextPop = true;
    window.history.back();
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
