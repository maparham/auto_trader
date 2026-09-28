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

export function openTab(tab: ChartTab, cellIndex: number): void {
  const i = Math.min(Math.max(cellIndex, 0), tab.cells.length - 1);
  const cell = tab.cells[i];
  lastCellByTab.set(tab.id, i);
  setMobileSymbol(cell.symbol, undefined, cell.scope);
  mobilePeriod.set(cell.period);
}

const shows = (tab: ChartTab, scope: string | undefined) =>
  !!scope && tab.cells.some((c) => c.scope === scope);

export default function MobileTabOverview({ open, onClose }: { open: boolean; onClose(): void }) {
  useSyncExternalStore(
    (fn) => mobileWorkspaceVersion.subscribe(fn),
    () => mobileWorkspaceVersion.value,
  );
  const scope = useSyncExternalStore(
    (fn) => mobileChartScope.subscribe(fn),
    () => mobileChartScope.value,
  )?.scope;
  const [query, setQuery] = useState("");
  const [menuId, setMenuId] = useState<string | null>(null);
  const [preview, setPreview] = useState<string[] | null>(null);
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

  const drag = useHoldDrag({
    onTap(id) {
      const t = byId.get(id);
      if (!t) return;
      openTab(t, lastCellByTab.get(id) ?? 0);
      onClose();
    },
    onHold(id) {
      setMenuId(id);
    },
    onOver(id, overId) {
      setPreview((cur) => {
        const ids = cur ?? visible.map((t) => t.id);
        const from = ids.indexOf(id);
        const to = ids.indexOf(overId);
        if (from < 0 || to < 0) return cur;
        const next = [...ids];
        next.splice(from, 1);
        next.splice(to, 0, id);
        return next;
      });
    },
    onDrop(id) {
      const ids = (preview ?? []).filter((x) => byId.has(x));
      setPreview(null);
      if (!byId.has(id) || !ids.length) return;
      // Visible tabs refill the slots they held in the full list; hidden tabs
      // keep theirs.
      const visibleSet = new Set(ids);
      const queue = [...ids];
      setMobileTabOrder(all.map((t) => (visibleSet.has(t.id) ? queue.shift()! : t.id)));
    },
  });

  const addTab = () =>
    requestSymbolPick((s) => {
      const t = addMobileTab(s, mobilePeriod.value ?? DEFAULT_PERIOD);
      openTab(t, 0);
      onClose();
    });

  const closeTab = (t: ChartTab) => {
    setMenuId(null);
    if (shows(t, scope)) {
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
      if (shows(t, scope)) setMobileSymbol(s, undefined, t.cells[0].scope);
    });
  };

  const menuTab = menuId ? byId.get(menuId) : undefined;

  return (
    <div className={"m-tab-ov" + (open ? " open" : "")} aria-hidden={!open}>
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
                    (shows(t, scope) ? " active" : "") +
                    (drag.liftedId === t.id ? " lifted" : "") +
                    (drag.draggingId === t.id ? " dragging" : "")
                  }
                  onPointerDown={(e) => drag.onPointerDown(e, t.id)}
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
          <div className="m-tab-ov-empty">No tab has that symbol. Tap + to open it in a new tab.</div>
        )}
      </div>
      <button className="m-tab-ov-grip" aria-label="Hide tabs" onClick={onClose}><i /></button>
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
