import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Tooltip from "../components/Tooltip";
import { BellIcon, MenuIcons } from "../lib/menuIcons";
import { firedText } from "../lib/timeFormat";
import type { LegendAlertBell } from "./legendAlertBells";

export type AlertBellActions = {
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
  onRearm?: (id: string) => void;
  onHide?: (id: string) => void;
};

/**
 * The bell on an indicator's legend row. A click (or Enter, or a right click)
 * opens a list under it with one row per alert: clicking a live alert's row
 * edits it, and it has Edit and Delete buttons; a fired "once" alert still
 * in History has Re-arm and Hide. The
 * bell is faint when every alert on it has fired.
 */
export default function AlertBell({ list, actions }: { list: LegendAlertBell[]; actions: AlertBellActions }) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const allFired = list.every((b) => b.firedAt != null);
  const noun = list.length === 1 ? "1 alert" : `${list.length} alerts`;
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <>
      <Tooltip asChild disabled={open} content={list.map((b) => b.label)} note="Click to edit or delete">
        <button
          ref={btnRef}
          type="button"
          className={`cl-alert-bell${allFired ? " fired" : ""}${open ? " open" : ""}${list.length > 1 ? " has-count" : ""}`}
          aria-label={`Indicator alerts: ${noun}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
          onDoubleClick={stop}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOpen(true);
          }}
        >
          <BellIcon size={13} />
          {list.length > 1 && <span className="cl-alert-count">{list.length}</span>}
        </button>
      </Tooltip>
      {open && btnRef.current &&
        createPortal(
          <AlertList anchor={btnRef.current} list={list} actions={actions} onClose={() => setOpen(false)} />,
          document.body,
        )}
    </>
  );
}

function AlertList({
  anchor,
  list,
  actions,
  onClose,
}: {
  anchor: HTMLElement;
  list: LegendAlertBell[];
  actions: AlertBellActions;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Under the bell, left-aligned to it, kept inside the window.
  useLayoutEffect(() => {
    const a = anchor.getBoundingClientRect();
    const el = ref.current;
    const w = el?.offsetWidth ?? 0;
    const h = el?.offsetHeight ?? 0;
    const below = a.bottom + 4;
    setPos({
      left: Math.max(4, Math.min(a.left, window.innerWidth - w - 4)),
      top: below + h > window.innerHeight - 4 ? Math.max(4, a.top - h - 4) : below,
    });
  }, [anchor, list.length]);

  // Keyboard: the list opens with focus on its first row, so Tab walks its
  // rows and buttons.
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="button"], button')?.focus();
  }, []);

  useEffect(() => {
    const outside = (e: Event) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !anchor.contains(t)) onClose();
    };
    // Escape closes the list and nothing else: caught on the window in the
    // capture phase, before App (maximize restore) and the chart (tool
    // cancel) see it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      onClose();
      anchor.focus();
    };
    // A fixed list does not follow the bell: close it when the page moves.
    const moved = (e: Event) => {
      if (!(e.target instanceof Node && ref.current?.contains(e.target))) onClose();
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("touchstart", outside, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", moved);
    window.addEventListener("scroll", moved, true);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("touchstart", outside, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", moved);
      window.removeEventListener("scroll", moved, true);
    };
  }, [anchor, onClose]);

  const act = (fn: ((id: string) => void) | undefined, id: string) => () => {
    onClose();
    fn?.(id);
  };

  return (
    <div
      ref={ref}
      className="alert-bell-list"
      role="dialog"
      aria-label="Indicator alerts"
      // Portaled to body, but React still bubbles its events up the component
      // tree to the legend row (select, settings, an armed "Pick from chart").
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      style={pos ? { left: pos.left, top: pos.top } : { visibility: "hidden", left: 0, top: 0 }}
    >
      {list.map((b) => {
        const fired = b.firedAt != null;
        return (
          // A live row is itself the Edit action (the pencil says so too);
          // a fired alert has nothing to edit, only its two buttons.
          <div
            key={b.id}
            className={`abl-row${fired ? " fired" : ""}`}
            {...(fired
              ? {}
              : {
                  role: "button",
                  tabIndex: 0,
                  onClick: act(actions.onEdit, b.id),
                  onKeyDown: (e: React.KeyboardEvent) => {
                    if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      act(actions.onEdit, b.id)();
                    }
                  },
                })}
          >
            <span className="abl-label">
              {b.label}
              {fired && <span className="abl-when">{firedText(b.firedAt!)}</span>}
            </span>
            {fired ? (
              <>
                <RowButton label="Re-arm" icon={MenuIcons.bell} onClick={act(actions.onRearm, b.id)} />
                <RowButton label="Hide" icon={MenuIcons.hide} onClick={act(actions.onHide, b.id)} />
              </>
            ) : (
              <>
                <RowButton label="Edit" icon={MenuIcons.pencil} onClick={act(actions.onEdit, b.id)} />
                <RowButton label="Delete" icon={MenuIcons.remove} danger onClick={act(actions.onDelete, b.id)} />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RowButton({ label, icon, danger, onClick }: { label: string; icon: React.ReactNode; danger?: boolean; onClick: () => void }) {
  return (
    <Tooltip asChild content={label}>
      <button
        type="button"
        className={`abl-btn${danger ? " danger" : ""}`}
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation(); // not the row's own Edit
          onClick();
        }}
      >
        {icon}
      </button>
    </Tooltip>
  );
}
