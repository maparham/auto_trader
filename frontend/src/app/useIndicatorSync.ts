// Sync-indicators layouts: mirror one cell's persisted indicator state onto
// its siblings and reconcile the mounted sibling charts, fed by live layout
// edits and by undo/redo.
import { useCallback, useEffect, useRef } from "react";
import type { ChartTab } from "../lib/persist";
import { onHistoryApplied, withHistorySuppressed } from "../lib/history";
import { mirrorIndicatorState } from "../lib/indicatorSync";
import { syncIndicatorsFromStorage } from "../lib/indicators";
import { onLayoutChanged } from "../lib/persist/layoutEvents";
import type { ReadyCells, Ref } from "./types";

export function useIndicatorSync({
  tabs,
  readyRef,
}: {
  tabs: ChartTab[];
  readyRef: Ref<ReadyCells>;
}) {
  // --- Sync indicators (layout toggle): storage-level mirror ------------------
  // Copy `origin`'s persisted indicator state to every other cell of `tab`, then
  // reconcile each mounted sibling chart in place. Mirror writes are event- and
  // history-suppressed, so this never re-triggers itself.
  const replicateIndicators = useCallback((tab: ChartTab, originCellId: string) => {
    const origin = tab.cells.find((c) => c.id === originCellId);
    if (!origin) return;
    for (const sib of tab.cells) {
      if (sib.id === originCellId) continue;
      const changed = mirrorIndicatorState(
        { scope: origin.scope, epic: origin.symbol.epic },
        { scope: sib.scope, epic: sib.symbol.epic },
      );
      const entry = readyRef.current.get(sib.id);
      if (entry && changed.length > 0) {
        withHistorySuppressed(() =>
          syncIndicatorsFromStorage(
            entry.chart, entry.controller, sib.scope, sib.symbol.epic,
            sib.period.resolution, new Set(changed),
          ),
        );
      }
    }
    // readyRef is App's ref, stable for the component's life, so the deps stay as they were in App.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Toggle-on: the focused cell's set becomes the layout's set (destructive to
  // siblings by design — consistent with the other sync toggles acting
  // immediately; no confirmation).
  const seedIndicatorSync = replicateIndicators;

  // Live tabs for the subscription below (a subscription must not re-bind per
  // render). Named distinctly from App's own `tabsRef` (the agent bridge's), which
  // this hook doesn't see.
  const syncTabsRef = useRef(tabs);
  syncTabsRef.current = tabs;
  const replicateRef = useRef(replicateIndicators);
  replicateRef.current = replicateIndicators;

  useEffect(() => {
    // Coalesce the several writes of one gesture (applyIndicator writes config +
    // list + anchor back-to-back) into one mirror pass per origin scope. Fed by
    // both onLayoutChanged (live edits) and onHistoryApplied (undo/redo, which
    // deliberately skips emitLayoutChanged — see lib/history.ts) so a sibling
    // never keeps a pre-undo indicator set.
    const pending = new Set<string>();
    let queued = false;
    const onScopeTouched = (changedScope: string) => {
      const tab = syncTabsRef.current.find(
        (t) => t.syncIndicators && t.cells.some((c) => c.scope === changedScope),
      );
      if (!tab) return;
      pending.add(changedScope);
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        const scopes = [...pending];
        pending.clear();
        for (const scope of scopes) {
          const t = syncTabsRef.current.find(
            (tt) => tt.syncIndicators && tt.cells.some((c) => c.scope === scope),
          );
          const cell = t?.cells.find((c) => c.scope === scope);
          if (t && cell) replicateRef.current(t, cell.id);
        }
      });
    };
    const offLayout = onLayoutChanged(onScopeTouched);
    const offHistory = onHistoryApplied(onScopeTouched);
    return () => {
      offLayout();
      offHistory();
    };
  }, []);
  return { seedIndicatorSync, replicateRef };
}
