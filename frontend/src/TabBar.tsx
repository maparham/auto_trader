// TradingView-style chart tabs along the top of the app. Each tab is an
// independent chart view (instrument + interval); the active tab drives the
// single ChartCore. Per-tab state lives entirely in App (see persist.ChartTab) —
// this component is presentational plus drag-to-reorder.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ChartCell, ChartTab } from "./lib/persist";
import { dropTarget, previewDeltas, type DragTarget, type Rect } from "./lib/tabDrag";
import SymbolIcon from "./SymbolIcon";
import Tooltip from "./components/Tooltip";
import ContextMenu from "./ContextMenu";
import MergeTabsMenu from "./MergeTabsMenu";
import { isSynthetic } from "./lib/syntheticRegistry";

// Must match .tab-bar-tabs { gap } in App.css — the flow simulation that
// slides chips apart uses it to predict where each chip lands.
const TAB_GAP = 6;

// 1x1 transparent GIF handed to setDragImage so the browser's faded chip
// snapshot never shows — the .tab-float clone below is the visible drag image.
const emptyImg = typeof Image === "undefined" ? null : new Image();
if (emptyImg != null)
  emptyImg.src =
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

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

// The chip's inner markup, shared by the real tab and its floating drag clone
// so the two can't drift (the clone previously copy-pasted this and lost the
// closed-market badge). The close button stays chip-only, outside this.
function ChipContent({
  lead,
  cellCount,
  closedTip,
}: {
  lead: ChartCell;
  cellCount: number;
  closedTip: string | null;
}) {
  return (
    <>
      <SymbolIcon epic={lead.symbol.epic} type={lead.symbol.type} className="tab-icon" />
      <span className="tab-symbol">
        {isSynthetic(lead.symbol.epic) ? (lead.symbol.name ?? lead.symbol.epic) : lead.symbol.epic}
      </span>
      <span className="tab-period">{lead.period.label}</span>
      {cellCount > 1 && <span className="tab-count">{cellCount}</span>}
      {/* Crescent-moon badge pinned to the tab's top-right when the lead cell's
          market is closed (CSS positions it absolutely). The tooltip names the
          next opening time when known. */}
      {closedTip != null && (
        <span className="tab-closed-badge" title={closedTip} aria-label={closedTip}>
          {/* Solid crescent (currentColor) — keeps the chrome monochrome rather
              than the lone colored 🌙 emoji it replaced. */}
          <svg viewBox="0 0 24 24" width="10" height="10" aria-hidden="true">
            <path fill="currentColor" d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        </span>
      )}
    </>
  );
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
  // Drag-to-reorder state. The dragged tab is tracked by ID, not index (see
  // the effect below); `target` is where a drop right now would land — an
  // insertion slot (chips slide apart to preview it) or a merge into a chip
  // (highlight, middle ~40% of the chip, exactly the old zone). Geometry is
  // measured ONCE at dragstart into dragGeom: the preview transforms change
  // getBoundingClientRect, so live measurement would feed back into itself.
  // `anim` gates the transform transition, so a committed drop can apply the
  // real new order without every chip animating its transform back to zero.
  const [dragId, setDragId] = useState<string | null>(null);
  const [target, setTarget] = useState<DragTarget | null>(null);
  const [anim, setAnim] = useState(false);
  const barRef = useRef<HTMLDivElement | null>(null);
  const floatRef = useRef<HTMLDivElement | null>(null);
  const dragGeom = useRef<{
    rects: Rect[];
    // Tab ids in order AT dragstart. If the live `tabs` sequence diverges from
    // this (a cross-window state push replaced the array mid-drag), the cached
    // rects/indices no longer describe the DOM — abort rather than mis-target.
    ids: string[];
    containerWidth: number;
    grabDx: number;
    grabDy: number;
    // Clamp range for the clone's translate: the chip rides the tab bar only
    // (Chrome-style), sliding horizontally along it no matter where the
    // cursor goes — including down onto the chart's merge overlay.
    bounds: { minX: number; maxX: number; minY: number; maxY: number };
  } | null>(null);
  // The cancelled-drag anim-off timer (see cancelDrag) — held in a ref so a new
  // drag started within its 200ms window can cancel it before it strips the
  // transition mid-gesture.
  const animTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draggedTab = dragId != null ? (tabs.find((t) => t.id === dragId) ?? null) : null;
  const fromIdx = dragId != null ? tabs.findIndex((t) => t.id === dragId) : -1;

  const clearAnimTimer = () => {
    if (animTimer.current != null) {
      clearTimeout(animTimer.current);
      animTimer.current = null;
    }
  };

  // Shared cancel cleanup for a drag that ends WITHOUT committing (dragend, or
  // the tab list changing under the drag): drop the drag state but leave `anim`
  // on so the preview gap can slide closed, clearing it once the 150ms App.css
  // transition has played. The single owner of the cancel path (Fix C).
  const cancelDrag = useCallback(() => {
    setDragId(null);
    setTarget(null);
    dragGeom.current = null;
    onDragActive(null);
    if (animTimer.current != null) clearTimeout(animTimer.current);
    animTimer.current = setTimeout(() => {
      setAnim(false);
      animTimer.current = null;
    }, 200);
  }, [onDragActive]);

  useEffect(() => {
    // Any mid-drag change to the tab list invalidates the dragstart geometry
    // snapshot: the dragged tab merging away (its chip unmounts before dragend,
    // which Chrome swallows on a detached node), OR a cross-window state push
    // replacing `tabs`. Either way the cached rects/indices no longer describe
    // the DOM — abort rather than index into stale data.
    if (dragId == null) return;
    const g = dragGeom.current;
    const idsChanged =
      g != null && (g.ids.length !== tabs.length || g.ids.some((id, i) => tabs[i]?.id !== id));
    if (draggedTab == null || idsChanged) cancelDrag();
  }, [dragId, draggedTab, tabs, cancelDrag]);

  useEffect(() => {
    // The clone tracks the cursor for the whole gesture — so listen at the
    // document — but its position is clamped to the tab bar (bounds cached at
    // dragstart): the chip slides only along the bar, Chrome-style, even while
    // the cursor is down over the chart's merge overlay or off the window.
    // It's positioned via style.transform directly: dragover fires roughly
    // per frame, and a React state update per event would re-render the bar.
    if (dragId == null) return;
    const move = (e: DragEvent) => {
      const g = dragGeom.current;
      const el = floatRef.current;
      if (g == null || el == null) return;
      const x = Math.min(Math.max(e.clientX - g.grabDx, g.bounds.minX), g.bounds.maxX);
      const y = Math.min(Math.max(e.clientY - g.grabDy, g.bounds.minY), g.bounds.maxY);
      el.style.transform = `translate(${x}px, ${y}px) scale(1.05)`;
    };
    document.addEventListener("dragover", move);
    return () => document.removeEventListener("dragover", move);
  }, [dragId]);

  // Right-click menu on a chip and the follow-up merge checklist, anchored
  // where the user clicked.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const [mergePick, setMergePick] = useState<{ x: number; y: number; tabId: string } | null>(null);

  // committed = the drop landed and the real order is about to change: kill
  // the transition in the same commit, otherwise every chip animates its
  // transform back to 0 while the layout also jumps. A cancelled drag keeps
  // the transition on so the preview gap visibly slides closed.
  const endDrag = (committed: boolean) => {
    // Idempotent: dragend fires after a committed drop too, so onDrop's
    // endDrag(true) is followed by onDragEnd's endDrag(false). This closure is
    // from the post-drop render (dragId already flushed to null), so the
    // trailing call no-ops instead of re-arming the cancel timer.
    if (dragId == null) return;
    if (committed) {
      setDragId(null);
      setTarget(null);
      clearAnimTimer();
      setAnim(false);
      dragGeom.current = null;
      onDragActive(null);
    } else {
      cancelDrag();
    }
  };

  // A drag in flight when the bar unmounts leaves a pending cancel timer.
  useEffect(() => () => clearAnimTimer(), []);

  // Slide-apart preview: for an insertion target, each chip's translate to
  // where it would sit with the dragged chip moved there. null = no shifts
  // (no drag, or hovering a merge target).
  const deltas =
    fromIdx !== -1 && target?.kind === "insert" && dragGeom.current != null
      ? previewDeltas(
          dragGeom.current.rects,
          dragGeom.current.containerWidth,
          TAB_GAP,
          fromIdx,
          target.index,
        )
      : null;

  const floatLead =
    draggedTab != null
      ? (draggedTab.cells.find((c) => c.id === draggedTab.activeCellId) ??
        draggedTab.cells[0])
      : null;
  // The clone shows the same closed-market badge as the chip it lifted off —
  // recomputed here because the chip's per-row closedTip is scoped to the map.
  const floatMeta = floatLead != null ? closedEpics[floatLead.symbol.epic] : undefined;
  const floatClosedTip = floatMeta?.closed
    ? floatMeta.nextOpen
      ? `Market closed · opens ${fmtNextOpen(floatMeta.nextOpen)}`
      : "Market closed"
    : null;

  return (
    <div className="tab-bar">
      {/* Tabs scroll horizontally on overflow; the trailing actions stay pinned. */}
      <div
        className={"tab-bar-tabs" + (anim ? " drag-anim" : "")}
        role="tablist"
        ref={barRef}
        onDragOver={(e) => {
          // Track where a drop would land, working entirely off the rects
          // cached at dragstart. A foreign drag (no chip dragstart happened
          // in this bar, so draggedTab is null) is not a drop target at all.
          const g = dragGeom.current;
          if (draggedTab == null || g == null) {
            // A foreign drag (no chip dragstart in this bar) isn't a drop
            // target, but must still be captured so the browser's default drop
            // — navigating the app to a dropped file — never fires.
            e.preventDefault();
            e.dataTransfer.dropEffect = "none";
            return;
          }
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const next = dropTarget(g.rects, e.clientX, e.clientY, fromIdx, (i) =>
            tabs[i] != null && canMerge(draggedTab.id, tabs[i].id),
          );
          setTarget((cur) =>
            cur != null && cur.kind === next.kind && cur.index === next.index
              ? cur
              : next,
          );
        }}
        onDragLeave={(e) => {
          // Cursor left the strip (e.g. heading for the chart's merge overlay):
          // close the preview gap. rt === null means the cursor left the window
          // entirely — which happens through the bar's own top edge too, so no
          // coordinate special-case: any exit that isn't into the bar closes it.
          const rt = e.relatedTarget as Node | null;
          const bar = barRef.current;
          if (bar == null) return;
          if (rt != null && bar.contains(rt)) return;
          setTarget(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          // `target` indexes the dragstart snapshot; if `tabs` changed under the
          // drag (cross-window push), those indices now point at different tabs,
          // so a merge/reorder would hit the wrong one — skip the mutation when
          // the live id sequence no longer matches the snapshot.
          const g = dragGeom.current;
          const snapshotValid =
            g != null &&
            g.ids.length === tabs.length &&
            g.ids.every((id, i) => tabs[i]?.id === id);
          // A drop can only fire here after our own dragover preventDefault,
          // so `target` is always current. Foreign drags never get that far.
          if (snapshotValid && draggedTab != null && target != null) {
            if (target.kind === "merge") {
              onMerge(tabs[target.index].id, [draggedTab.id]);
            } else if (
              fromIdx !== -1 &&
              // from and from+1 are the two slots around the chip's own spot —
              // both are no-op moves.
              target.index !== fromIdx &&
              target.index !== fromIdx + 1
            ) {
              onReorder(fromIdx, target.index);
            }
          }
          endDrag(true);
        }}
      >
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
          // DOM hook for anchoring floating UI to a specific chip (the merge
          // undo snackbar positions itself under the merged tab).
          data-tab-id={t.id}
          aria-selected={t.id === activeId}
          className={[
            "tab",
            t.id === activeId ? "on" : "",
            dragId === t.id ? "dragging" : "",
            target?.kind === "merge" && target.index === i && dragId !== t.id
              ? "drop-merge"
              : "",
          ]
            .filter(Boolean)
            .join(" ")}
          style={
            // deltas is sized to the dragstart snapshot; if `tabs` grew under
            // the drag, deltas[i] is undefined for the new chips (guarded).
            deltas != null && deltas[i] != null && (deltas[i].dx !== 0 || deltas[i].dy !== 0)
              ? { transform: `translate(${deltas[i].dx}px, ${deltas[i].dy}px)` }
              : undefined
          }
          onClick={() => onSelect(t.id)}
          title={closedTip ? `${titleText} · ${closedTip}` : titleText}
          draggable
          onDragStart={(e) => {
            // Cache every chip's rect NOW — the preview transforms change
            // getBoundingClientRect, so all later hit-testing works off this
            // snapshot (chip order can't change mid-drag except the
            // merged-away case, which the effect above resets).
            const bar = barRef.current;
            if (bar == null) return;
            const rects: Rect[] = Array.from(
              bar.querySelectorAll<HTMLElement>(":scope > .tab"),
            ).map((c) => {
              const r = c.getBoundingClientRect();
              return { left: r.left, top: r.top, width: r.width, height: r.height };
            });
            const barRect = bar.getBoundingClientRect();
            dragGeom.current = {
              rects,
              ids: tabs.map((t) => t.id),
              // -6 for .tab-bar-tabs' padding-left (App.css) — clientWidth
              // includes it, but the flow simulation lays chips out from the
              // content box, so leaving it in overestimates where a chip wraps.
              containerWidth: bar.clientWidth - 6,
              grabDx: e.clientX - rects[i].left,
              grabDy: e.clientY - rects[i].top,
              bounds: {
                minX: barRect.left,
                maxX: barRect.right - rects[i].width,
                minY: barRect.top,
                maxY: barRect.bottom - rects[i].height,
              },
            };
            if (emptyImg != null) e.dataTransfer.setDragImage(emptyImg, 0, 0);
            // Firefox refuses to start an HTML5 drag when no drag data is set;
            // the payload itself is unused (state carries the dragged id).
            e.dataTransfer.setData("text/plain", t.id);
            e.dataTransfer.effectAllowed = "move";
            setDragId(t.id);
            // A cancelled drag's pending anim-off timer would strip the
            // transition mid-gesture if it fired during this new drag.
            clearAnimTimer();
            setAnim(true);
            onDragActive(t.id);
          }}
          onDragEnd={() => endDrag(false)}
          onContextMenu={(e) => {
            e.preventDefault();
            // With one tab, the only context-menu action ("Merge into this
            // tab…") has nothing to target, and the menu is render-gated on
            // tabs.length > 1 — setting state here would never clear.
            if (tabs.length > 1) setCtxMenu({ x: e.clientX, y: e.clientY, tabId: t.id });
          }}
        >
          <ChipContent lead={lead} cellCount={t.cells.length} closedTip={closedTip} />
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
      <Tooltip content="New tab">
        <button className="tab-add" onClick={onAdd}>
          +
        </button>
      </Tooltip>
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
      {/* The cursor-following clone of the grabbed chip. Starts on the chip's
          own rect; the document dragover listener above steers it. */}
      {draggedTab != null &&
        floatLead != null &&
        dragGeom.current != null &&
        fromIdx !== -1 &&
        // fromIdx indexes live `tabs`; if the array grew past the snapshot the
        // rect is undefined — skip the clone rather than read a bad transform.
        dragGeom.current.rects[fromIdx] != null &&
        createPortal(
          <div
            className="tab tab-float"
            ref={floatRef}
            style={{
              transform: `translate(${dragGeom.current.rects[fromIdx].left}px, ${dragGeom.current.rects[fromIdx].top}px) scale(1.05)`,
            }}
          >
            <ChipContent
              lead={floatLead}
              cellCount={draggedTab.cells.length}
              closedTip={floatClosedTip}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}
