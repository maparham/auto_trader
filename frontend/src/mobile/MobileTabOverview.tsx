// Pull-down overview of every tab in the mirrored layout (spec:
// 2026-09-28-mobile-tab-overview-design.md). Wrapped chips like the desktop
// tab bar: tap opens a tab, hold opens its menu, hold then drag reorders.
// Every edit goes through mobileLayoutEdit.ts.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ChartTab } from "../lib/persist";
import { toast } from "../lib/notify";
import { DEFAULT_PERIOD } from "../app/workspace";
import {
  mirroredWorkspace,
  mobileLayoutList,
  setMobileLayout,
  mobileWorkspaceVersion,
  lastCellByTab,
} from "./mobileWorkspace";
import {
  addMobileTab,
  closeMobileTab,
  setMobileTabOrder,
  setMobileTabSymbol,
  UNDO_MS,
} from "./mobileLayoutEdit";
import {
  mobileChartScope,
  mobilePeriod,
  requestSymbolPick,
  setMobileSymbol,
} from "./mobileChartState";
import { useHoldDrag } from "./useHoldDrag";
import { startPullDrag } from "./usePullPanel";

export function openTab(tab: ChartTab, cellIndex: number): void {
  const i = Math.min(Math.max(cellIndex, 0), tab.cells.length - 1);
  const cell = tab.cells[i];
  lastCellByTab.set(tab.id, i);
  setMobileSymbol(cell.symbol, undefined, cell.scope);
  mobilePeriod.set(cell.period);
}

const shows = (tab: ChartTab, chartScope: { epic: string; scope: string } | null | undefined) =>
  !!chartScope &&
  tab.cells.some((c) => c.scope === chartScope.scope && c.symbol.epic === chartScope.epic);

export default function MobileTabOverview({
  open,
  onClose,
  onPull,
  onPullEnd,
}: {
  open: boolean;
  onClose(): void;
  onPull?(dy: number): void;
  onPullEnd?(dy: number): void;
}) {
  useSyncExternalStore(
    (fn) => mobileWorkspaceVersion.subscribe(fn),
    () => mobileWorkspaceVersion.value,
  );
  const chartScope = useSyncExternalStore(
    (fn) => mobileChartScope.subscribe(fn),
    () => mobileChartScope.value,
  );
  const [query, setQuery] = useState("");
  const [menuId, setMenuId] = useState<string | null>(null);
  const [preview, setPreviewState] = useState<string[] | null>(null);
  // Mirrors `preview` synchronously so onDrop can read the latest reorder
  // even when it runs in the same tick as the last onOver, without waiting
  // for a render to land between the last move and pointerup.
  const previewRef = useRef<string[] | null>(null);
  const setPreview = (next: string[] | null) => {
    previewRef.current = next;
    setPreviewState(next);
  };
  const bodyRef = useRef<HTMLDivElement>(null);

  const mirror = mirroredWorkspace();
  const all = mirror?.ws.tabs ?? [];
  const byId = new Map(all.map((t) => [t.id, t]));
  const q = query.trim().toUpperCase();
  const visible = all.filter(
    (t) => !q || t.cells.some((c) => c.symbol.epic.toUpperCase().includes(q) || (c.symbol.name ?? "").toUpperCase().includes(q)),
  );
  const shown = (preview ?? visible.map((t) => t.id)).map((id) => byId.get(id)).filter((t): t is ChartTab => !!t);

  useEffect(() => {
    if (!open) return;
    const el = bodyRef.current?.querySelector<HTMLElement>(".m-tab-ov-chip.active");
    if (el && bodyRef.current) bodyRef.current.scrollTop = Math.max(0, el.offsetTop - 10);
  }, [open]);

  const openChip = (id: string) => {
    const t = byId.get(id);
    if (!t) return;
    openTab(t, lastCellByTab.get(id) ?? 0);
    onClose();
  };

  const drag = useHoldDrag({
    onTap: openChip,
    onHold(id) {
      setMenuId(id);
    },
    onOver(id, overId) {
      const cur = previewRef.current ?? visible.map((t) => t.id);
      const from = cur.indexOf(id);
      const to = cur.indexOf(overId);
      if (from < 0 || to < 0) return;
      const next = [...cur];
      next.splice(from, 1);
      next.splice(to, 0, id);
      setPreview(next);
    },
    onDrop(id) {
      const ids = (previewRef.current ?? []).filter((x) => byId.has(x));
      setPreview(null);
      if (!byId.has(id) || !ids.length) return;
      // Visible tabs refill the slots they held in the full list; hidden tabs
      // keep theirs.
      const visibleSet = new Set(ids);
      const queue = [...ids];
      setMobileTabOrder(all.map((t) => (visibleSet.has(t.id) ? queue.shift()! : t.id)));
    },
  });

  // A drag that ends without a drop (pointercancel, or a new pointerdown
  // superseding the gesture) never calls onDrop, so it never clears the
  // local reorder preview on its own. The hook always drops draggingId back
  // to null when a gesture ends, dropped or not, so that transition is the
  // one place left to catch it and revert to the real order.
  useEffect(() => {
    if (drag.draggingId === null) setPreview(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag.draggingId]);

  const addTab = () =>
    requestSymbolPick((s) => {
      const t = addMobileTab(s, mobilePeriod.value ?? DEFAULT_PERIOD);
      setQuery("");
      openTab(t, 0);
      onClose();
    });

  const closeTab = (t: ChartTab) => {
    setMenuId(null);
    if (shows(t, chartScope)) {
      const i = all.indexOf(t);
      const neighbour = all[i + 1] ?? all[i - 1];
      if (neighbour) openTab(neighbour, 0);
    }
    const undo = closeMobileTab(t.id);
    if (undo) toast("Tab closed. Tap to undo", { onClick: undo, duration: UNDO_MS });
  };

  const changeSymbol = (t: ChartTab) => {
    setMenuId(null);
    requestSymbolPick((s) => {
      setMobileTabSymbol(t.id, s);
      if (shows(t, chartScope)) setMobileSymbol(s, undefined, t.cells[0].scope);
    });
  };

  const menuTab = menuId ? byId.get(menuId) : undefined;

  return (
    <div className={"m-tab-ov" + (open ? " open" : "")} aria-hidden={!open} inert={!open}>
      <div className="m-tab-ov-head">
        <select
          id="m-tab-ov-layout"
          aria-label="Layout"
          value={mirror?.id ?? ""}
          onChange={(e) => { setQuery(""); setMobileLayout(e.target.value); }}
        >
          {mobileLayoutList().map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
        <input
          id="m-tab-ov-find"
          type="search"
          aria-label="Find tab"
          placeholder="Find tab"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="m-tab-ov-add" aria-label="New tab" onClick={addTab}>+</button>
      </div>
      <div className="m-tab-ov-count">
        {q ? `${visible.length} of ${all.length} tabs` : `${all.length} tabs`}
      </div>
      <div className="m-tab-ov-body" ref={bodyRef}>
        {shown.length ? (
          <div className="m-tab-ov-chips">
            {shown.map((t) => {
              const c = t.cells[0];
              return (
                <button
                  key={t.id}
                  data-drag-id={t.id}
                  className={
                    "m-tab-ov-chip" +
                    (shows(t, chartScope) ? " active" : "") +
                    (drag.liftedId === t.id ? " lifted" : "") +
                    (drag.draggingId === t.id ? " dragging" : "")
                  }
                  onPointerDown={(e) => drag.onPointerDown(e, t.id)}
                  // The hook only reacts to pointer gestures, so a keyboard
                  // activation (Enter/Space on a focused button) would
                  // otherwise do nothing. Browsers fire a synthetic click
                  // with detail 0 for those; a real mouse click has
                  // detail >= 1 and is already handled via onPointerDown, so
                  // gating on detail === 0 avoids a double-open there.
                  onClick={(e) => { if (e.detail === 0) openChip(t.id); }}
                  onContextMenu={(e) => e.preventDefault()}
                >
                  {c.symbol.epic} {c.period.label}
                  {t.cells.length > 1 && (
                    <>
                      {" "}
                      <span className="m-tab-ov-more">+{t.cells.length - 1}</span>
                    </>
                  )}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="m-tab-ov-empty">
            {q ? "No tab has that symbol. Tap + to open it in a new tab." : "No tabs yet. Tap + to open one."}
          </div>
        )}
      </div>
      <button
        className="m-tab-ov-grip"
        aria-label="Hide tabs"
        onPointerDown={(e) => startPullDrag(e, onPull, onPullEnd)}
        onClick={(e) => {
          if (e.detail === 0) onClose();
        }}
      >
        <i />
      </button>
      {menuTab && (
        <div className="m-tab-ov-scrim" onClick={(e) => { if (e.target === e.currentTarget) setMenuId(null); }}>
          <div className="m-tab-ov-menu">
            {menuTab.cells.length === 1 && (
              <button onClick={() => changeSymbol(menuTab)}>Change symbol</button>
            )}
            <button className="danger" disabled={all.length === 1} onClick={() => closeTab(menuTab)}>
              Close tab
            </button>
            <button onClick={() => setMenuId(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
