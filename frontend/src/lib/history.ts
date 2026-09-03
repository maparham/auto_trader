// Per-cell undo/redo for chart content (drawings, indicators, AVWAP anchors).
//
// History records (storage key, before, after) deltas at the persistence choke
// points in lib/persist/artifacts.ts. Deltas landing within GROUP_MS group into
// one step, so a drag gesture (repeated persists of one key) and a composite
// action (indicator remove writes `indicators` + `indicatorConfig`) each undo
// as a single Ctrl+Z. Undo re-enters storage through save()/removeKeyEverywhere
// so the backend mirror and cross-tab broadcast stay correct; writing
// localStorage directly here would be reverted by hydrateFromBackend.
import { save, removeKeyEverywhere, PREFIX } from "./persist/core";

export interface AppliedDelta {
  suffix: string;
  before: unknown;
  after: unknown;
}

interface HistoryDelta {
  key: string; // full storage key: `${PREFIX}.${scope}.${suffix}`
  before: unknown; // undefined = key absent before the write
  after: unknown;
}
interface HistoryStep {
  deltas: HistoryDelta[];
  // Last capture time. 0 marks the step CLOSED to further merging (set when a
  // step crosses the stacks): "draw, undo, draw again fast" must not merge the
  // new gesture into the pre-undo step.
  lastAt: number;
}

const GROUP_MS = 800;
const CAP = 100;

// Fired after a HistoryManager undo/redo lands its restored values in storage
// (applier already run). Unlike emitLayoutChanged — which applyTop deliberately
// skips so template autosave never fires for undo-only edits — this channel
// exists solely so App-level indicator sync can mirror a restored scope to its
// siblings (Sync indicators layout toggle).
type AppliedListener = (scope: string) => void;
const appliedListeners = new Set<AppliedListener>();
export function onHistoryApplied(cb: AppliedListener): () => void {
  appliedListeners.add(cb);
  return () => appliedListeners.delete(cb);
}

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// --- suppression -------------------------------------------------------------
// Guards programmatic writes that must not be undoable: undo/redo application
// itself and strategy-overlay auto-adds. Same idiom as withLayoutEventsSuppressed.
let suppressed = 0;
export function withHistorySuppressed<T>(fn: () => T): T {
  suppressed++;
  try {
    return fn();
  } finally {
    suppressed--;
  }
}

// --- registry ----------------------------------------------------------------
// scope -> the live cell's manager. Captures for unregistered scopes are
// no-ops, which keeps migrations and background-scope writes out of the stacks.
// Template applies are NOT protected by this — the cell registers at controller
// construction, before the async mount-time auto-apply runs — so templates.ts
// wraps its apply paths in withHistorySuppressed; that wrapper is the guard.
const registry = new Map<string, HistoryManager>();
export function registerHistory(scope: string, mgr: HistoryManager): void {
  registry.set(scope, mgr);
}
export function unregisterHistory(scope: string, mgr: HistoryManager): void {
  if (registry.get(scope) === mgr) registry.delete(scope);
}
// Remote push invalidation (App.onBackendPush): another tab/device edited this
// key, so the owning cell's history would undo over their change. Clear it.
// Scopes nest (`tab.T` is a tab's primary cell, `tab.T.cell.C` a sub-cell), so
// a bare prefix test would let a sub-cell's key clear the primary cell's stacks
// too. Clear only the longest-scope match — the cell that actually owns the key.
export function clearHistoryForKey(key: string): void {
  let owner: HistoryManager | null = null;
  let ownerLen = -1;
  for (const [scope, mgr] of registry) {
    if (key.startsWith(`${PREFIX}.${scope}.`) && scope.length > ownerLen) {
      owner = mgr;
      ownerLen = scope.length;
    }
  }
  owner?.clear();
}

// Called by lib/persist/artifacts.ts immediately BEFORE save(key, after) —
// `before` is read from storage here, so call order is load-bearing.
export function historyCapture(scope: string, key: string, after: unknown, now?: number): void {
  if (suppressed) return;
  const mgr = registry.get(scope);
  if (!mgr) return;
  let before: unknown;
  try {
    const raw = localStorage.getItem(key);
    before = raw == null ? undefined : (JSON.parse(raw) as unknown);
  } catch {
    before = undefined;
  }
  mgr.push(key, before, after, now);
}

/** Classify a step's touched suffixes for the applier: which live-apply paths
 *  to run, restricted to the cell's CURRENT epic (a stale epic's key is already
 *  restored in storage and rehydrates on the next symbol switch). */
export function partitionHistorySuffixes(
  suffixes: string[],
  epic: string,
): { drawings: boolean; indicators: boolean; avwapIds: string[] } {
  const out = { drawings: false, indicators: false, avwapIds: [] as string[] };
  for (const s of suffixes) {
    if (s === `drawings.${epic}`) out.drawings = true;
    else if (s === "indicators" || s === "indicatorConfig") out.indicators = true;
    else if (s.startsWith(`avwap.${epic}.`)) out.avwapIds.push(s.slice(`avwap.${epic}.`.length));
  }
  return out;
}

/** Which indicator instance ids need a live rebuild after a step is applied:
 *  ids whose config changed, plus ids whose POSITION, TYPE or INSET placement
 *  changed in an id-set-equal `indicators` delta (membership adds/removes are
 *  handled by the sync itself, which diffs stored vs live ids).
 *
 *  Three mutable dimensions, all of which must appear on BOTH sides of the
 *  comparison key: reorderSubPanes changes the index, a settings edit can change
 *  the type, and the inset toggle changes neither while still moving the instance
 *  between its own sub-pane and the candle pane's band. Leaving inset out lands
 *  the id in the sync's "keep" bucket, so undo flips storage while the chart keeps
 *  drawing in the old placement until the next reload. `inset` is written as true
 *  or absent (never false), so normalize both spellings to 0/1. */
export function rebuildIdsForDeltas(
  deltas: readonly AppliedDelta[],
): Set<string> {
  const rebuild = new Set<string>();
  const key = (i: number, x: { type: string; inset?: boolean }) =>
    `${i}:${x.type}:${x.inset ? 1 : 0}`;
  for (const d of deltas) {
    if (d.suffix === "indicatorConfig") {
      const a = (d.before ?? {}) as Record<string, unknown>;
      const b = (d.after ?? {}) as Record<string, unknown>;
      for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (JSON.stringify(a[id]) !== JSON.stringify(b[id])) rebuild.add(id);
      }
    } else if (d.suffix === "indicators") {
      const a = (d.before ?? []) as Array<{ id: string; type: string; inset?: boolean }>;
      const b = (d.after ?? []) as Array<{ id: string; type: string; inset?: boolean }>;
      const posA = new Map(a.map((x, i) => [x.id, key(i, x)]));
      for (const [i, x] of b.entries()) {
        const pa = posA.get(x.id);
        if (pa !== undefined && pa !== key(i, x)) rebuild.add(x.id);
      }
    }
  }
  return rebuild;
}

export class HistoryManager {
  private undoStack: HistoryStep[] = [];
  private redoStack: HistoryStep[] = [];
  private applier: ((deltas: AppliedDelta[]) => void) | null = null;
  // Toolbar buttons mirror canUndo/canRedo, so every stack mutation has to be
  // observable. Same shape as lib/signals Signal.subscribe (useSyncExternalStore).
  private listeners = new Set<() => void>();

  constructor(readonly scope: string) {}

  setApplier(fn: ((deltas: AppliedDelta[]) => void) | null): void {
    this.applier = fn;
  }

  /** Notified whenever canUndo/canRedo may have changed. Returns an unsubscribe. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    this.listeners.forEach((l) => l());
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  push(key: string, before: unknown, after: unknown, now: number = Date.now()): void {
    if (this.pushDelta(key, before, after, now)) this.notify();
  }

  /** Returns whether the stacks actually changed (a no-op write must not
   *  re-render the toolbar). */
  private pushDelta(key: string, before: unknown, after: unknown, now: number): boolean {
    if (eq(before, after)) return false;
    this.redoStack.length = 0;
    const top = this.undoStack[this.undoStack.length - 1];
    if (top && top.lastAt !== 0 && now - top.lastAt <= GROUP_MS) {
      const d = top.deltas.find((d) => d.key === key);
      if (d) d.after = after; // coalesce: keep first before, take last after
      else top.deltas.push({ key, before, after });
      top.lastAt = now;
      // A gesture that ended exactly where it started (drag out and back) is
      // not an undo step at all.
      if (top.deltas.every((d) => eq(d.before, d.after))) this.undoStack.pop();
      return true;
    }
    this.undoStack.push({ deltas: [{ key, before, after }], lastAt: now });
    if (this.undoStack.length > CAP) this.undoStack.shift();
    return true;
  }

  undo(): boolean {
    return this.applyTop(this.undoStack, this.redoStack, "before");
  }
  redo(): boolean {
    return this.applyTop(this.redoStack, this.undoStack, "after");
  }

  clear(): void {
    if (!this.undoStack.length && !this.redoStack.length) return;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.notify();
  }

  private applyTop(from: HistoryStep[], to: HistoryStep[], field: "before" | "after"): boolean {
    const step = from[from.length - 1];
    if (!step) return false;
    const ok = withHistorySuppressed(() => {
      let allOk = true;
      // Undo applies deltas newest-first, redo oldest-first.
      const deltas = field === "before" ? [...step.deltas].reverse() : step.deltas;
      // Undo/redo writes deliberately skip emitLayoutChanged so template autosave does not fire for undo-only edits; switch-time flushTemplateCapture reads storage directly and heals it.
      for (const d of deltas) {
        const v = d[field];
        if (v === undefined) removeKeyEverywhere(d.key);
        else if (!save(d.key, v)) allOk = false; // quota: report failure, leave step
      }
      return allOk;
    });
    if (!ok) return false;
    from.pop();
    step.lastAt = 0; // closed: later captures never merge into a crossed step
    to.push(step);
    // Surviving top must not swallow the next gesture either (see grouping test).
    const survivor = from[from.length - 1];
    if (survivor) survivor.lastAt = 0;
    const prefix = `${PREFIX}.${this.scope}.`;
    this.applier?.(step.deltas.map((d) => ({ suffix: d.key.slice(prefix.length), before: d.before, after: d.after })));
    this.notify();
    appliedListeners.forEach((l) => l(this.scope));
    return true;
  }
}
