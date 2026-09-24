import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SweepArchiveSummary } from "../api";
import Tooltip from "../components/Tooltip";
import type { SessionPreset } from "../lib/backtestConfig";
import { SESSION_PRESETS, formatDayWindow, sessionWindowInTz } from "../lib/backtestSchedule";
import { TrashIcon } from "./icons";

// "Fill from session" menu — a button, not a <select>. Picking a preset is a
// one-shot action (it fills From/To + tz + weekdays, then everything stays
// editable), so a stateful selector would lie about the current mask. A menu
// button reads as an action and never shows a stale "selected" value. Portaled
// to <body> so it escapes the modal's scroll clip.
const SESSION_MENU_WIDTH = 240;

export function SessionFillMenu({ disabled, chartTz, onPick }: {
  disabled: boolean;
  chartTz: string;
  onPick: (key: SessionPreset) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  function toggle() {
    if (disabled) return;
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.left, window.innerWidth - SESSION_MENU_WIDTH - 8));
      setPos({ top: r.bottom + 4, left });
    }
    setOpen((v) => !v);
  }

  return (
    <div className="bt-session-menu">
      <button
        ref={btnRef}
        type="button"
        className={`bt-session-btn${open ? " open" : ""}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Fill from a market session"
        onClick={toggle}
      >
        <span>presets</span>
        <span className="bt-session-caret" aria-hidden="true">▾</span>
      </button>
      {open &&
        pos &&
        createPortal(
          <ul
            ref={popRef}
            className="dropdown bt-session-dropdown"
            role="listbox"
            style={{ position: "fixed", top: pos.top, left: pos.left }}
          >
            {Object.entries(SESSION_PRESETS).map(([k, v]) => {
              // Hours shown converted into the chart timezone — the exact
              // numbers a pick fills into From/To (the mask is read there).
              const hrs = formatDayWindow(sessionWindowInTz(v.window, v.tz, chartTz, Date.now()) ?? undefined);
              return (
                <li
                  key={k}
                  role="option"
                  aria-selected={false}
                  onClick={() => {
                    onPick(k as SessionPreset);
                    setOpen(false);
                  }}
                >
                  {hrs ? `${v.label} (${hrs})` : v.label}
                </li>
              );
            })}
          </ul>,
          document.body,
        )}
    </div>
  );
}

// Compact past-sweeps reopen control for the sweep footer: a bare ⟳ icon button
// that opens a portaled menu of archived sweeps. Each row reopens on click and
// carries its own trash button, so the footer stays icon-width no matter which
// sweep (if any) is selected — a native <select> would truncate the long
// "date · name · best N" label into the narrow box. Opens UPWARD because it
// lives at the bottom of the panel.
const PAST_SWEEPS_MENU_WIDTH = 260;
export function PastSweepsMenu({
  sweeps,
  disabled,
  onReopen,
  onDelete,
}: {
  sweeps: SweepArchiveSummary[];
  disabled?: boolean;
  onReopen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ bottom: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const close = () => setOpen(false);
    // Scrolling INSIDE the menu (its own overflow list) must not dismiss it —
    // only an outside scroll that would move the anchor out from under it.
    const onScroll = (e: Event) => {
      if (popRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  // When the last row is deleted the menu has nothing left to show.
  useEffect(() => {
    if (sweeps.length === 0) setOpen(false);
  }, [sweeps.length]);

  function toggle() {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.left, window.innerWidth - PAST_SWEEPS_MENU_WIDTH - 8));
      setPos({ bottom: window.innerHeight - r.top + 4, left });
    }
    setOpen((v) => !v);
  }

  return (
    <div className="bt-past-sweeps">
      <Tooltip content="Reopen a past sweep">
        <button
          ref={btnRef}
          type="button"
          className={`bt-past-sweeps-btn${open ? " open" : ""}`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Reopen a past sweep"
          disabled={disabled}
          onClick={toggle}
        >
          ⟳
        </button>
      </Tooltip>
      {open &&
        pos &&
        createPortal(
          <ul
            ref={popRef}
            className="dropdown bt-past-sweeps-list"
            role="menu"
            style={{ position: "fixed", top: "auto", bottom: pos.bottom, left: pos.left, width: PAST_SWEEPS_MENU_WIDTH }}
          >
            {sweeps.map((s) => (
              <li key={s.id} role="menuitem" className="bt-past-sweeps-item">
                <button
                  type="button"
                  className="bt-past-sweeps-reopen"
                  onClick={() => {
                    onReopen(s.id);
                    setOpen(false);
                  }}
                >
                  {new Date(s.created_at * 1000).toLocaleDateString()} · {s.name || `${s.n_rows} combos`} · best {s.best_net_pnl == null ? "n/a" : s.best_net_pnl.toFixed(0)}
                </button>
                <Tooltip content="Delete this sweep">
                  <button
                    type="button"
                    className="bt-past-sweeps-del"
                    aria-label="Delete this sweep"
                    onClick={() => onDelete(s.id)}
                  >
                    <TrashIcon />
                  </button>
                </Tooltip>
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </div>
  );
}
