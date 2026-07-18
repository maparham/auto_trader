// In-place editor for one swept numeric axis. Replaces the field's value input
// while its sweep axis is on: a compact accent badge showing the run count
// ("9×", or "∞" for a degenerate range) with the from/to/step spelled out in its
// tooltip, and a click-to-open popover holding the from/to/step fields plus a
// "Remove from sweep" action. Retires the old injected SweepAxisRow line.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { comboCount, type RangeAxis } from "../lib/sweep";
import NumberField from "./NumberField";
import Tooltip from "./Tooltip";

const POP_WIDTH = 230;

// The field's current scalar shown read-only beside its RangeChip, so the base
// value a plain backtest would use stays visible while the field is swept. Edit
// it by switching back to Backtest mode (where the plain input returns).
export function SweepBaseValue({ children }: { children: React.ReactNode }) {
  return (
    <Tooltip content="Current value. Switch to Backtest mode to edit.">
      <span className="sweep-base">{children}</span>
    </Tooltip>
  );
}

export function RangeChip({
  axis,
  onPatch,
  onRemove,
  disabled = false,
}: {
  axis: RangeAxis;
  onPatch: (patch: Partial<Pick<RangeAxis, "from" | "to" | "step">>) => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const close = () => setOpen(false);
    // Capture phase: the backtest modal stops mousedown from bubbling past
    // itself, which would swallow a bubble-phase listener (see OperatorPicker).
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
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.left, window.innerWidth - POP_WIDTH - 8));
      setPos({ top: r.bottom + 4, left });
    }
    setOpen((v) => !v);
  }

  const n = comboCount([axis]);
  const bad = !isFinite(n);
  return (
    <>
      <Tooltip
        title={disabled ? undefined : `Sweep ${axis.label}`}
        content={
          disabled
            ? "Switch to Sweep mode to edit sweep ranges"
            : bad
              ? "This range never ends (check the step). Click to edit."
              : [`${axis.from} … ${axis.to} step ${axis.step}`, `${n} runs. Click to edit.`]
        }
      >
        <button
          ref={btnRef}
          type="button"
          className={`range-chip${bad ? " range-chip-bad" : ""}${open ? " open" : ""}`}
          aria-label={`Sweep ${axis.label}: ${axis.from} to ${axis.to} step ${axis.step}`}
          aria-expanded={open}
          disabled={disabled}
          onClick={toggle}
        >
          {bad ? "∞" : `${n}×`}
        </button>
      </Tooltip>
      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            className="dropdown range-chip-pop"
            style={{ position: "fixed", top: pos.top, left: pos.left }}
          >
            <label className="range-chip-field">
              <span>From</span>
              <NumberField value={axis.from} onChange={(v) => onPatch({ from: v })} signed className="bt-num" />
            </label>
            <label className="range-chip-field">
              <span>To</span>
              <NumberField value={axis.to} onChange={(v) => onPatch({ to: v })} signed className="bt-num" />
            </label>
            <label className="range-chip-field">
              <span>Step</span>
              <NumberField value={axis.step} onChange={(v) => onPatch({ step: v })} signed className="bt-num" />
            </label>
            <div className="range-chip-pop-foot">
              <span className="range-chip-pop-count">{bad ? "∞ runs" : `${n} runs`}</span>
              <button type="button" className="ghost range-chip-remove" onClick={() => { setOpen(false); onRemove(); }}>
                Remove from sweep
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
