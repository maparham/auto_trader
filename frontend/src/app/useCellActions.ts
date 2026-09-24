// Edits to the active tab's cells: symbol and interval changes (with the
// replay-loss confirm and the tab's sync links), the split layout and its
// track sizes, the per-tab sync toggles and the master lock.
import { flushPendingAutoSaves } from "../lib/templateAutosave";
import {
  rangeSync,
  readVisibleRange,
  readExactAnchor,
  getAlignAnchor,
  clearAlignAnchor,
  isCellReplaying,
} from "../lib/chartSync";
import { cellsChangingSymbol, replayLossMessage } from "../lib/replaySymbolGuard";
import { requestConfirm } from "../lib/signals";
import type { Instrument, Period } from "../lib/feed";
import {
  purgeScope,
  primaryCellScope,
  cellScope,
  LAYOUT_CELLS,
  type ChartTab,
  type LayoutKind,
  type ChartCell,
} from "../lib/persist";
import { mirrorIndicatorState } from "../lib/indicatorSync";
import { newCellId, effectiveSyncSymbol, effectiveSyncInterval } from "./workspace";
import type { Dispatch, SetStateAction } from "react";
import type { ReadyCells, Ref } from "./types";

export function useCellActions({
  active,
  focusedCell,
  setTabs,
  tabsRef,
  readyRef,
  replicateRef,
  seedIndicatorSync,
  reportCellView,
}: {
  active: ChartTab | undefined;
  focusedCell: ChartCell | undefined;
  setTabs: Dispatch<SetStateAction<ChartTab[]>>;
  tabsRef: Ref<ChartTab[]>;
  readyRef: Ref<ReadyCells>;
  replicateRef: Ref<(tab: ChartTab, originCellId: string) => void>;
  seedIndicatorSync: (tab: ChartTab, originCellId: string) => void;
  reportCellView: (cellId: string) => void;
}) {
  // A replay cursor addresses ONE instrument's bars, so a symbol change ends any
  // session on the cells it touches (chart/useReplay's symbol-change guard) and
  // drops their persisted record with it: the practice book, the cursor, and on a
  // blind session the only place the hidden dates were ever written down. The
  // guard toasts AFTER the fact, which is no use to someone who has just lost an
  // hour of a study session to a stray click on a symbol row.
  //
  // So ask first, and only when there is actually something to lose — a cell not
  // replaying goes straight through, which is every ordinary symbol change.
  // Takes the cells it is ABOUT to change, not the focused one: with symbol-sync
  // on, the change lands on siblings that never had focus.
  const confirmReplayLoss = (cellIds: string[], run: () => void) => {
    const hit = cellIds.filter(isCellReplaying);
    if (!hit.length) {
      run();
      return;
    }
    requestConfirm({
      title: "End the replay session?",
      message: replayLossMessage(hit.length),
      confirmLabel: "End and switch",
      onConfirm: run,
    });
  };

  // Update the focused cell's instrument / interval. With symbol-sync on, the
  // change broadcasts to every cell in the tab (TradingView's "link" control).
  const setSymbol = (s: Instrument) => {
    if (!active || !focusedCell) return;
    // Lock keeps each cell's own symbol (effectiveSyncSymbol forces sync OFF), so
    // only the focused cell changes symbol even when syncSymbol was on underneath.
    const broadcast = effectiveSyncSymbol(active);
    confirmReplayLoss(
      cellsChangingSymbol(active.cells, {
        focusedId: focusedCell.id,
        broadcast,
        nextEpic: s.epic,
      }),
      () => {
        setTabs((ts) =>
          ts.map((t) =>
            t.id !== active.id
              ? t
              : {
                  ...t,
                  cells: t.cells.map((c) =>
                    broadcast || c.id === focusedCell.id ? { ...c, symbol: s } : c,
                  ),
                },
          ),
        );
        // Synced tabs: the changed cell's new epic may have no AVWAP anchors yet —
        // mirror from a sibling so the curves recompute there too. Runs on the next
        // microtask so tabs state has settled; the layout-changed subscription
        // can't cover this (a symbol change writes no indicator storage).
        if (active.syncIndicators) {
          queueMicrotask(() => {
            const t = tabsRef.current.find((tt) => tt.id === active.id);
            const other = t?.cells.find((c) => c.id !== focusedCell.id);
            if (t && other) replicateRef.current(t, other.id);
          });
        }
        // tabsRef only settles next microtask (setTabs above is async).
        queueMicrotask(() => reportCellView(focusedCell.id));
      },
    );
  };
  // Switch a SPECIFIC cell's interval. The quick-range bar uses this (it knows the
  // cell that owns it) so a keyboard-activated preset still targets the right cell
  // even when no pointer-down moved focus there first. Lock/interval-sync forces
  // the TF onto every cell — that's what keeps same-timestamp candles aligned.
  const setCellPeriod = (cellId: string, p: Period) => {
    if (!active) return;
    const broadcast = effectiveSyncInterval(active);
    setTabs((ts) =>
      ts.map((t) =>
        t.id !== active.id
          ? t
          : {
              ...t,
              cells: t.cells.map((c) =>
                broadcast || c.id === cellId ? { ...c, period: p } : c,
              ),
            },
      ),
    );
    // tabsRef only settles next microtask (setTabs above is async), so defer
    // the read-back rather than reporting stale (pre-update) period fields.
    queueMicrotask(() => reportCellView(cellId));
  };

  const setPeriod = (p: Period) => {
    if (!active || !focusedCell) return;
    setCellPeriod(focusedCell.id, p);
  };

  // Change the active tab's layout: add cells (cloning the focused cell's symbol/
  // period) or trim extras (purging their per-cell storage; the primary cell is
  // never purged). Keeps activeCellId valid.
  const setLayout = (layout: LayoutKind) => {
    if (!active) return;
    // A layout TRIM purges the dropped cells' scopes below — land pending
    // autosaves first. Growth purges nothing, so don't flush (it would eagerly
    // fire unrelated cells' debounced saves).
    if (LAYOUT_CELLS[layout] < active.cells.length) flushPendingAutoSaves();
    setTabs((ts) =>
      ts.map((t) => {
        if (t.id !== active.id) return t;
        const want = LAYOUT_CELLS[layout];
        let cells = t.cells.slice();
        if (cells.length < want) {
          const base = cells.find((c) => c.id === t.activeCellId) ?? cells[0];
          while (cells.length < want) {
            const cid = newCellId();
            cells.push({
              id: cid,
              symbol: base.symbol,
              period: base.period,
              scope: cellScope(t.id, cid),
            });
          }
          // Sync-indicators tabs seed the new cells' storage NOW (before the cell
          // mounts), so hydration finds the shared set and no template auto-apply
          // races it.
          if (t.syncIndicators) {
            for (const c of cells) {
              if (c.scope === base.scope) continue;
              mirrorIndicatorState(
                { scope: base.scope, epic: base.symbol.epic },
                { scope: c.scope, epic: c.symbol.epic },
              );
            }
          }
        } else if (cells.length > want) {
          for (const c of cells.slice(want)) {
            if (c.scope !== primaryCellScope(t.id)) purgeScope(c.scope);
          }
          cells = cells.slice(0, want);
        }
        const activeCellId = cells.some((c) => c.id === t.activeCellId)
          ? t.activeCellId
          : cells[0].id;
        return { ...t, layout, cells, activeCellId, sizes: layout === t.layout ? t.sizes : undefined };
      }),
    );
  };

  // Commit new cell-size fractions after a border drag (ChartGrid onSizes).
  const setCellSizes = (sizes: { cols: number[]; rows: number[] }) => {
    if (!active) return;
    setTabs((ts) => ts.map((t) => (t.id === active.id ? { ...t, sizes } : t)));
  };

  // Toggle a per-tab sync link (symbol, interval, or crosshair). Enabling symbol or
  // interval sync applies IMMEDIATELY — every cell adopts the focused cell's symbol /
  // timeframe right away (TradingView behaviour), not just on the next change.
  // Crosshair sync is live, so there's nothing to back-fill.
  const toggleSync = (
    kind: "symbol" | "interval" | "crosshair" | "time" | "indicators",
  ) => {
    if (!active || !focusedCell) return;
    if (kind === "indicators") {
      const turningOn = !active.syncIndicators;
      if (turningOn) {
        seedIndicatorSync(active, focusedCell.id);
      }
      setTabs((ts) =>
        ts.map((t) => (t.id === active.id ? { ...t, syncIndicators: turningOn } : t)),
      );
      return;
    }
    // Date-range link: enabling snaps the siblings to the focused cell's current
    // window once (read it now and broadcast); from then on the focused cell live-
    // broadcasts on every scroll/zoom (see ChartCore). The cells share only the
    // flag, so siblings always apply what's published — no per-cell back-fill here.
    if (kind === "time") {
      const turningOn = !active.syncTime;
      if (turningOn) {
        const src = readyRef.current.get(focusedCell.id);
        // A focused cell panned into right-edge whitespace reports an extrapolated
        // window, so siblings snap to the same view, whitespace included.
        // ...unless it is REPLAYING: its window is a hidden moment in the past,
        // and siblings would render those timestamps on their own unmasked time
        // axes. The link still turns on; the siblings just keep their view until
        // the next broadcast (which the replaying cell also withholds).
        const r = src && !isCellReplaying(focusedCell.id) ? readVisibleRange(src.chart) : null;
        if (r) rangeSync.publish(active.id, { sourceCellId: focusedCell.id, ...r });
      }
      setTabs((ts) => ts.map((t) => (t.id === active.id ? { ...t, syncTime: turningOn } : t)));
      return;
    }
    // Turning symbol-sync ON rewrites every sibling's instrument in one click,
    // which ends any replay session they hold — the same loss as a symbol change,
    // reached from a control that says nothing about symbols changing. Handled
    // ahead of the shared setTabs (like the "time" branch above) so the ask can
    // sit in front of it. Turning it OFF touches no symbol and needs no ask.
    if (kind === "symbol" && !active.syncSymbol) {
      confirmReplayLoss(
        cellsChangingSymbol(active.cells, {
          focusedId: focusedCell.id,
          broadcast: true,
          nextEpic: focusedCell.symbol.epic,
        }),
        () =>
          setTabs((ts) =>
            ts.map((t) =>
              t.id !== active.id
                ? t
                : {
                    ...t,
                    syncSymbol: true,
                    cells: t.cells.map((c) => ({ ...c, symbol: focusedCell.symbol })),
                  },
            ),
          ),
      );
      return;
    }
    setTabs((ts) =>
      ts.map((t) => {
        if (t.id !== active.id) return t;
        if (kind === "crosshair") return { ...t, syncCrosshair: !t.syncCrosshair };
        if (kind === "symbol") {
          const on = !t.syncSymbol;
          return {
            ...t,
            syncSymbol: on,
            cells: on
              ? t.cells.map((c) => ({ ...c, symbol: focusedCell.symbol }))
              : t.cells,
          };
        }
        const on = !t.syncInterval;
        return {
          ...t,
          syncInterval: on,
          cells: on
            ? t.cells.map((c) => ({ ...c, period: focusedCell.period }))
            : t.cells,
        };
      }),
    );
  };

  // Master "lock charts" toggle. Lock is a derived override (see effective* helpers),
  // so the four underlying flags aren't touched — unlock just returns to whatever
  // they were. Turning ON applies once, from the focused cell as the initial master:
  // every cell adopts its TF (so same-timestamp candles line up), and its current
  // window is broadcast on the date-range channel so siblings snap to it (from then
  // on the cell under the cursor live-broadcasts every scroll/zoom).
  const toggleLock = () => {
    if (!active || !focusedCell) return;
    const turningOn = !active.locked;
    const tabId = active.id;
    const masterId = focusedCell.id;
    const broadcastMasterWindow = () => {
      // A replaying master broadcasts nothing: its window (and the align anchor
      // it would carry) are timestamps the session deliberately hides, and a
      // sibling renders them unmasked. Gated INSIDE this closure so the deferred
      // re-broadcast below is covered too.
      if (isCellReplaying(masterId)) return;
      const src = readyRef.current.get(masterId);
      const r = src ? readVisibleRange(src.chart) : null;
      // Carry the exact-mode anchor so siblings mirror the master's window pixel-for-
      // pixel (lock forces them onto its interval) — same payload as ChartCore's onRange.
      // Honour any sticky align anchor (defaults to right edge): the deferred re-broadcast
      // below can land AFTER the user has hovered a candle, and without this it would
      // snap siblings back to the right edge, transiently undoing that alignment.
      if (r) {
        const exact = readExactAnchor(src!.chart, getAlignAnchor(tabId));
        rangeSync.publish(tabId, { sourceCellId: masterId, ...r, ...exact });
      }
    };
    if (turningOn) {
      // Snap siblings to the master's window now (covers cells already on the
      // master's TF). Cells whose TF actually changes refetch history and reset to
      // the latest bars (applyNewData in ChartCore), which wipes this snap — so
      // re-broadcast after that reload settles. The master's own TF never changes,
      // so its window is stable to read on the deferred pass. Belt-and-braces: a
      // sibling that still misses the snap self-heals on the first pan/zoom.
      broadcastMasterWindow();
      setTimeout(broadcastMasterWindow, 350);
    } else {
      // Turning lock off: drop the sticky (hover-driven) align anchor so the next lock
      // session starts fresh at the right edge rather than a stale hovered timestamp.
      clearAlignAnchor(tabId);
    }
    setTabs((ts) =>
      ts.map((t) =>
        t.id !== tabId
          ? t
          : {
              ...t,
              locked: turningOn,
              cells: turningOn
                ? t.cells.map((c) => ({ ...c, period: focusedCell.period }))
                : t.cells,
            },
      ),
    );
  };
  return { setSymbol, setCellPeriod, setPeriod, setLayout, setCellSizes, toggleSync, toggleLock };
}
