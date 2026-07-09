// A tiny synchronous pub/sub for "a cell's persisted layout (indicators / drawings
// / configs / anchors) just changed", keyed by cell scope. Fired by the per-cell
// persist writers in artifacts.ts; consumed by ChartCore's per-cell auto-save.
//
// withLayoutEventsSuppressed wraps the programmatic merge writes in
// applySymbolTemplate so auto-apply / manual-apply / default-apply — which mint
// NEW instance ids — never look like a user edit and never trigger an auto-save.
// It's a DEPTH COUNTER (not a boolean) so nested applies compose.

type Listener = (scope: string) => void;

const listeners = new Set<Listener>();
let suppressDepth = 0;

export function onLayoutChanged(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function emitLayoutChanged(scope: string): void {
  if (suppressDepth > 0) return;
  for (const l of listeners) l(scope);
}

export function withLayoutEventsSuppressed<T>(fn: () => T): T {
  suppressDepth++;
  try {
    return fn();
  } finally {
    suppressDepth--;
  }
}
