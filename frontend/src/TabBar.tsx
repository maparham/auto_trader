// TradingView-style chart tabs along the top of the app. Each tab is an
// independent chart view (instrument + interval); the active tab drives the
// single ChartCore. Per-tab state lives entirely in App (see persist.ChartTab) —
// this component is presentational plus drag-to-reorder.

import { useEffect, useState, type ReactNode } from "react";
import type { ChartTab } from "./lib/persist";
import SymbolIcon from "./SymbolIcon";
import ContextMenu from "./ContextMenu";
import MergeTabsMenu from "./MergeTabsMenu";

// Format an ISO-8601 UTC next-open time for the closed-badge tooltip, in the
// viewer's local zone. "today"/"tomorrow" when near; otherwise a dated weekday
// (e.g. "Mon, Jun 29 22:00") since the next open can be up to a week out and the
// weekday alone can't tell this week from next. Falls back to the raw string if
// it doesn't parse.
function fmtNextOpen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = d.toLocaleString(undefined, { hour: "2-digit", minute: "2-digit" });
  const startOfDay = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(d) - startOfDay(new Date())) / 86_400_000);
  if (days <= 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  const date = d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return `${date} ${time}`;
}

interface Props {
  tabs: ChartTab[];
  activeId: string;
  // Market-closed state keyed by EPIC (polled at the App level for every tab's
  // lead epic, so it's live for background tabs too). A tab shows a crescent-moon
  // badge when its lead cell's epic is closed; nextOpen feeds the badge tooltip.
  closedEpics: Record<string, { closed: boolean; nextOpen: string | null }>;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onClose: (id: string) => void;
  onReorder: (from: number, to: number) => void;
  // Merge gestures (see App.mergeTabs). canMerge gates UI affordances by the
  // 4-cell cap; onMerge performs the merge (sources merge in the given order).
  canMerge: (sourceId: string, targetId: string) => boolean;
  onMerge: (targetId: string, sourceIds: string[]) => void;
  // A chip drag started/ended (id or null) — App shows ChartGrid's merge
  // overlay while a chip is in flight.
  onDragActive: (tabId: string | null) => void;
  // Workspace-level controls pinned to the right of the bar (Backtest, workspace
  // layouts, the split picker, theme toggle) — they aren't specific to one chart.
  trailing?: ReactNode;
}

export default function TabBar({
  tabs,
  activeId,
  closedEpics,
  onSelect,
  onAdd,
  onClose,
  onReorder,
  canMerge,
  onMerge,
  onDragActive,
  trailing,
}: Props) {
  // Index of the tab being dragged, the index being hovered, and which zone of
  // that tab the cursor is on — drives the drop-indicator line/highlight and
  // the target slot. All null when no drag is in progress. "before"/"after"
  // let you drop on either edge (the right half of the last tab included,
  // which a pure drop-before scheme can't express); "merge" is the middle
  // ~40% of the chip and only applies when the dragged tab can merge into it.
  type DropZone = "before" | "after" | "merge";
  // Track the dragged tab by ID, not index. Dragging a chip onto the chart
  // area (ChartGrid's merge-drop overlay) can MERGE that tab away while the
  // gesture is still "in flight": the chip's DOM node unmounts before the
  // browser fires dragend on it, and Chrome swallows dragend on a detached
  // node, so endDrag() never runs. An index would then keep pointing at
  // whichever tab slides into the vacated slot. The effect below clears drag
  // state the moment the tracked id disappears from `tabs`, so no zone logic
  // ever has to fall back on a stale/out-of-range index, and a later foreign
  // drag (no chip dragstart) can never see a leftover drag as "in progress".
  const [dragId, setDragId] = useState<string | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const [overSide, setOverSide] = useState<DropZone>("before");
  const draggedTab = dragId != null ? (tabs.find((t) => t.id === dragId) ?? null) : null;

  useEffect(() => {
    // The dragged tab merged away mid-gesture (dragend never fired) — drop
    // the stranded state and tell App the drag is over.
    if (dragId != null && draggedTab == null) {
      setDragId(null);
      setOverIdx(null);
      setOverSide("before");
      onDragActive(null);
    }
  }, [dragId, draggedTab, onDragActive]);

  // Right-click menu on a chip and the follow-up merge checklist, anchored
  // where the user clicked.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const [mergePick, setMergePick] = useState<{ x: number; y: number; tabId: string } | null>(null);

  const endDrag = () => {
    setDragId(null);
    setOverIdx(null);
    setOverSide("before");
    onDragActive(null);
  };

  return (
    <div className="tab-bar">
      {/* Tabs scroll horizontally on overflow; the trailing actions stay pinned. */}
      <div className="tab-bar-tabs" role="tablist">
      {tabs.map((t, i) => {
        // The tab chip represents the layout by its focused (or first) cell; a
        // multi-cell layout adds a small count badge. The title lists every cell.
        const lead =
          t.cells.find((c) => c.id === t.activeCellId) ?? t.cells[0];
        const leadMeta = closedEpics[lead.symbol.epic];
        const leadClosed = !!leadMeta?.closed;
        const closedTip = leadClosed
          ? leadMeta?.nextOpen
            ? `Market closed · opens ${fmtNextOpen(leadMeta.nextOpen)}`
            : "Market closed"
          : null;
        const titleText = t.cells
          .map((c) => `${c.symbol.name} · ${c.period.label}`)
          .join("   |   ");
        return (
        <div
          key={t.id}
          role="tab"
          aria-selected={t.id === activeId}
          className={[
            "tab",
            t.id === activeId ? "on" : "",
            dragId === t.id ? "dragging" : "",
            overIdx === i && dragId !== t.id
              ? overSide === "merge"
                ? "drop-merge"
                : overSide === "after"
                  ? "drop-after"
                  : "drop-before"
              : "",
          ]
            .filter(Boolean)
            .join(" ")}
          onClick={() => onSelect(t.id)}
          title={closedTip ? `${titleText} — ${closedTip}` : titleText}
          draggable
          onDragStart={(e) => {
            setDragId(t.id);
            // Firefox refuses to start an HTML5 drag when no drag data is set;
            // the payload itself is unused (state carries the dragged id).
            e.dataTransfer.setData("text/plain", t.id);
            e.dataTransfer.effectAllowed = "move";
            onDragActive(t.id);
          }}
          onDragOver={(e) => {
            // Allow dropping and track the hovered slot + zone the cursor is
            // in, so the drop can land before, after, or merge into this tab.
            // A foreign drag (no chip dragstart happened in this TabBar, so
            // draggedTab is null) never qualifies for merge and only ever
            // shows the plain reorder indicator — it can't merge or reorder.
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            const r = e.currentTarget.getBoundingClientRect();
            const frac = (e.clientX - r.left) / r.width;
            // Middle ~40% of the chip = merge drop (when allowed); the outer
            // edges keep meaning reorder, so the gestures don't fight.
            const mergeOk =
              draggedTab != null && draggedTab.id !== t.id && canMerge(draggedTab.id, t.id);
            const side: DropZone =
              mergeOk && frac >= 0.3 && frac <= 0.7
                ? "merge"
                : frac < 0.5
                  ? "before"
                  : "after";
            if (overIdx !== i) setOverIdx(i);
            if (overSide !== side) setOverSide(side);
          }}
          onDrop={(e) => {
            e.preventDefault();
            // Translate (target index, zone) into either a merge or the
            // destination index for App's reorder (remove-then-insert;
            // dropping after tab i targets slot i+1). Foreign drags (no
            // draggedTab) are ignored outright.
            if (draggedTab != null) {
              if (overSide === "merge" && draggedTab.id !== t.id) {
                onMerge(t.id, [draggedTab.id]);
              } else {
                const from = tabs.findIndex((x) => x.id === draggedTab.id);
                if (from !== -1) {
                  const to = overSide === "after" ? i + 1 : i;
                  if (to !== from) onReorder(from, to);
                }
              }
            }
            endDrag();
          }}
          onDragEnd={endDrag}
          onContextMenu={(e) => {
            e.preventDefault();
            // With one tab, the only context-menu action ("Merge into this
            // tab…") has nothing to target, and the menu is render-gated on
            // tabs.length > 1 — setting state here would never clear.
            if (tabs.length > 1) setCtxMenu({ x: e.clientX, y: e.clientY, tabId: t.id });
          }}
        >
          <SymbolIcon epic={lead.symbol.epic} type={lead.symbol.type} className="tab-icon" />
          <span className="tab-symbol">{lead.symbol.epic}</span>
          <span className="tab-period">{lead.period.label}</span>
          {t.cells.length > 1 && <span className="tab-count">{t.cells.length}</span>}
          {/* Crescent-moon badge pinned to the tab's top-right when the lead
              cell's market is closed (CSS positions it absolutely). The tooltip
              names the next opening time when known. */}
          {leadClosed && (
            <span
              className="tab-closed-badge"
              title={closedTip ?? "Market closed"}
              aria-label={closedTip ?? "Market closed"}
            >
              {/* Solid crescent (currentColor) — keeps the chrome monochrome
                  rather than the lone colored 🌙 emoji it replaced. */}
              <svg viewBox="0 0 24 24" width="10" height="10" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"
                />
              </svg>
            </span>
          )}
          <button
            className="tab-close"
            // Closing must not also select the tab.
            onClick={(e) => {
              e.stopPropagation();
              onClose(t.id);
            }}
            title="Close tab"
          >
            ×
          </button>
        </div>
        );
      })}
      <button className="tab-add" onClick={onAdd} title="New tab">
        +
      </button>
      </div>
      {trailing && <div className="tab-bar-actions">{trailing}</div>}
      {ctxMenu && tabs.length > 1 && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={[
            {
              label: "Merge into this tab…",
              onClick: () => setMergePick(ctxMenu),
            },
          ]}
          onClose={() => setCtxMenu(null)}
        />
      )}
      {mergePick && (
        <MergeTabsMenu
          x={mergePick.x}
          y={mergePick.y}
          tabs={tabs}
          targetId={mergePick.tabId}
          onMerge={(sourceIds) => onMerge(mergePick.tabId, sourceIds)}
          onClose={() => setMergePick(null)}
        />
      )}
    </div>
  );
}
