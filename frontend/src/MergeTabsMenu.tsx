// Checklist popover behind the tab context-menu's "Merge into this tab": lists
// every OTHER tab; ticked tabs merge into the target in tab-bar order. Rows
// whose cells would push the merged tab past 4 are disabled, live — ticking a
// row updates which of the rest still fit. Closes on outside-click / Escape
// (same idiom as ContextMenu). The search box filters rows by any cell's
// display name or epic, so "Intel" and "INTC" find the same tab.

import { useEffect, useRef, useState } from "react";
import type { ChartTab } from "./lib/persist";
import SymbolIcon from "./SymbolIcon";
import Tooltip from "./components/Tooltip";

interface Props {
  x: number;
  y: number;
  tabs: ChartTab[];
  targetId: string;
  onMerge: (sourceIds: string[]) => void;
  onClose: () => void;
}

export default function MergeTabsMenu({ x, y, tabs, targetId, onMerge, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const target = tabs.find((t) => t.id === targetId);
  if (!target) return null;
  const others = tabs.filter((t) => t.id !== targetId);
  const total =
    target.cells.length +
    others.filter((t) => picked.has(t.id)).reduce((n, t) => n + t.cells.length, 0);

  const q = query.trim().toLowerCase();
  const shown = q
    ? others.filter((t) =>
        t.cells.some(
          (c) =>
            c.symbol.name.toLowerCase().includes(q) || c.symbol.epic.toLowerCase().includes(q),
        ),
      )
    : others;
  const fitsRow = (t: ChartTab) => picked.has(t.id) || total + t.cells.length <= 4;

  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };

  return (
    <div
      ref={ref}
      className="ctxmenu merge-menu"
      style={{ left: Math.min(x, window.innerWidth - 260), top: y }}
    >
      <div className="merge-menu-title">Merge into this tab</div>
      <input
        className="merge-menu-search"
        type="text"
        placeholder="Search name or symbol"
        value={query}
        autoFocus
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          // Enter ticks the first row that matches and still fits.
          if (e.key !== "Enter") return;
          const first = shown.find(fitsRow);
          if (first) toggle(first.id);
        }}
      />
      {shown.length === 0 && <div className="merge-menu-empty">No matching tabs</div>}
      {shown.map((t) => {
        const lead = t.cells.find((c) => c.id === t.activeCellId) ?? t.cells[0];
        const on = picked.has(t.id);
        const fits = fitsRow(t);
        return (
          // Wrapper, not asChild: a disabled button may not fire mouse events.
          <Tooltip key={t.id} content={fits ? null : "Would exceed 4 charts"}>
            <button
              className={`ctx-item merge-row${on ? " on" : ""}`}
              disabled={!fits}
              onClick={() => toggle(t.id)}
            >
              <span className="ctx-item-label">
                <input type="checkbox" checked={on} readOnly tabIndex={-1} />
                <SymbolIcon epic={lead.symbol.epic} type={lead.symbol.type} className="tab-icon" />
                {lead.symbol.name} · {lead.period.label}
                {t.cells.length > 1 && <span className="tab-count">{t.cells.length}</span>}
              </span>
            </button>
          </Tooltip>
        );
      })}
      <button
        className="ctx-item merge-confirm"
        disabled={picked.size === 0}
        onClick={() => {
          // Merge in tab-bar order, not tick order — predictable cell layout.
          onMerge(others.filter((t) => picked.has(t.id)).map((t) => t.id));
          onClose();
        }}
      >
        Merge
      </button>
    </div>
  );
}
