// Visited-tab history for the tab bar: browser-style back/forward over the
// tabs the user has activated, plus a most-recently-used order for the
// search's "Recent" list. Pure; TabBar holds the state for the session.
//
// `stack` is the back/forward trail and `idx` the current position in it.
// Back/forward only move `idx`, so the activation that follows (activeId
// becoming stack[idx]) is recognised by `visit` and doesn't fork the trail.
// `mru` is every visited tab, newest first, with no repeats.

export interface TabHistory {
  stack: string[];
  idx: number;
  mru: string[];
}

const MAX = 100;

export const emptyHistory: TabHistory = { stack: [], idx: -1, mru: [] };

export function visit(h: TabHistory, id: string): TabHistory {
  const mru = [id, ...h.mru.filter((x) => x !== id)].slice(0, MAX);
  if (h.stack[h.idx] === id) return { ...h, mru };
  // A fresh visit drops the forward trail, as a browser does.
  const stack = [...h.stack.slice(0, h.idx + 1), id].slice(-MAX);
  return { stack, idx: stack.length - 1, mru };
}

// The next live tab `dir` steps along the trail (-1 back, +1 forward), with
// the history moved onto it, or null at the end. Closed tabs are skipped.
export function step(
  h: TabHistory,
  dir: -1 | 1,
  live: ReadonlySet<string>,
  activeId: string,
): { id: string; history: TabHistory } | null {
  for (let i = h.idx + dir; i >= 0 && i < h.stack.length; i += dir) {
    const id = h.stack[i];
    if (id != null && live.has(id) && id !== activeId) {
      return { id, history: { ...h, idx: i } };
    }
  }
  return null;
}

// Up to `n` live tabs by last visit, newest first, without the active one.
export function recent(
  h: TabHistory,
  live: ReadonlySet<string>,
  activeId: string,
  n = 5,
): string[] {
  return h.mru.filter((id) => id !== activeId && live.has(id)).slice(0, n);
}
