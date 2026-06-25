// The multi-chart layout picker (TradingView-style □), lifted out of the toolbar
// into the top tab bar. It chooses the active tab's split and carries the per-tab
// sync ("link") toggles. Self-contained: owns its open state + outside-click close;
// its data (layout / sync flags) is passed in from App.

import { useEffect, useRef, useState } from "react";
import type { LayoutKind } from "./lib/persist";

interface Props {
  layout: LayoutKind;
  onLayout: (l: LayoutKind) => void;
  syncSymbol: boolean;
  syncInterval: boolean;
  syncCrosshair: boolean;
  syncTime: boolean;
  locked: boolean;
  onToggleSync: (kind: "symbol" | "interval" | "crosshair" | "time") => void;
  onToggleLock: () => void;
}

// A tiny SVG that draws an outer frame plus the dividers for a given split, so
// each picker icon actually depicts the layout it selects (TradingView-style).
function LayoutGlyph({ kind }: { kind: LayoutKind }) {
  // Divider line positions inside the 16×16 frame (frame inset by 1px).
  const dividers: Record<LayoutKind, [number, number, number, number][]> = {
    "1": [],
    "2h": [[8, 1, 8, 15]], // one vertical split → two columns
    "2v": [[1, 8, 15, 8]], // one horizontal split → two rows
    "3": [
      [6, 1, 6, 15],
      [11, 1, 11, 15],
    ], // two vertical splits → three columns
    "4": [
      [8, 1, 8, 15],
      [1, 8, 15, 8],
    ], // vertical + horizontal → 2×2 grid
  };
  return (
    <svg
      className="layout-glyph"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      <rect x="1" y="1" width="14" height="14" rx="1.5" />
      {dividers[kind].map(([x1, y1, x2, y2], i) => (
        <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />
      ))}
    </svg>
  );
}

// Layout picker options: a label per supported split (glyph drawn by LayoutGlyph).
const LAYOUTS: { kind: LayoutKind; label: string }[] = [
  { kind: "1", label: "Single" },
  { kind: "2h", label: "Two columns" },
  { kind: "2v", label: "Two rows" },
  { kind: "3", label: "Three columns" },
  { kind: "4", label: "Grid (2×2)" },
];

export default function LayoutPicker({
  layout,
  onLayout,
  syncSymbol,
  syncInterval,
  syncCrosshair,
  syncTime,
  locked,
  onToggleSync,
  onToggleLock,
}: Props) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current && !menuRef.current.contains(t)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="menu layout-menu" ref={menuRef}>
      <button
        className={`tabbar-action${open ? " on" : ""}`}
        title="Chart layout"
        onClick={() => setOpen((v) => !v)}
      >
        <LayoutGlyph kind={layout} /> ▾
      </button>
      {open && (
        <div className="dropdown layout-dropdown">
          <ul>
            {LAYOUTS.map((l) => (
              <li
                key={l.kind}
                className={l.kind === layout ? "on" : ""}
                onClick={() => {
                  onLayout(l.kind);
                  setOpen(false);
                }}
              >
                <LayoutGlyph kind={l.kind} />
                {l.label}
              </li>
            ))}
          </ul>
          {/* Per-tab sync ("link") toggles — only meaningful with >1 cell. Each
              carries an info icon whose tooltip explains what it links. "Lock
              charts" is a master override: while on, the individual toggles are
              forced (interval/crosshair/date-range on, symbol off) and greyed. */}
          <div className="layout-sync">
            <label className="ls-lock">
              <input
                type="checkbox"
                checked={locked}
                onChange={() => onToggleLock()}
              />
              <span className="ls-label">Lock charts</span>
              <span
                className="ls-info"
                title="Locks the charts together: panning, zooming, or changing the timeframe on any chart applies to all of them, as if your cursor were on each. Each chart keeps its own symbol."
              >
                ⓘ
              </span>
            </label>
            <div className={`ls-group${locked ? " ls-disabled" : ""}`}>
            <label>
              <input
                type="checkbox"
                checked={locked ? false : syncSymbol}
                disabled={locked}
                onChange={() => onToggleSync("symbol")}
              />
              <span className="ls-label">Sync symbol</span>
              <span
                className="ls-info"
                title="Changing the symbol in the focused chart changes it in every chart of this layout."
              >
                ⓘ
              </span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={locked ? true : syncInterval}
                disabled={locked}
                onChange={() => onToggleSync("interval")}
              />
              <span className="ls-label">Sync interval</span>
              <span
                className="ls-info"
                title="Changing the timeframe in the focused chart changes it in every chart of this layout."
              >
                ⓘ
              </span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={locked ? true : syncCrosshair}
                disabled={locked}
                onChange={() => onToggleSync("crosshair")}
              />
              <span className="ls-label">Sync crosshair</span>
              <span
                className="ls-info"
                title="Hovering one chart draws a matching time guide on the others (aligns the cursor by time)."
              >
                ⓘ
              </span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={locked ? true : syncTime}
                disabled={locked}
                onChange={() => onToggleSync("time")}
              />
              <span className="ls-label">Sync date range</span>
              <span
                className="ls-info"
                title="Scrolling or zooming the time axis in one chart shows the same date range on the others (matched by time, across intervals)."
              >
                ⓘ
              </span>
            </label>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
