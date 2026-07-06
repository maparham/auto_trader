import { useEffect, useRef, useState } from "react";
import CloseButton from "./CloseButton";
import Tooltip from "./components/Tooltip";
import type { ChartOperandSource, EmphasisTarget } from "./lib/chartOperand";
import type { Operand } from "./lib/backtestConfig";

/** Strategy-side picker: lists the focused cell's on-chart indicators/drawings,
 * one sub-item per active output line, and returns the chosen operand. Purely
 * presentational — the caller enumerates sources and handles the picked operand.
 * `onHoverSource(target|null)` lets the caller emphasize the matching on-chart
 * element (drawing overlay or indicator curve) while its row is hovered. */
export default function ChartOperandPicker({
  sources,
  onPick,
  onClose,
  onHoverSource,
}: {
  sources: ChartOperandSource[];
  onPick: (op: Operand) => void;
  onClose: () => void;
  onHoverSource?: (target: EmphasisTarget | null) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  // Always release the emphasis when the picker goes away — a row's mouseleave may
  // not fire before onPick/onClose unmount us, which would strand a drawing thickened.
  // Via a ref so this fires ONLY on unmount, not whenever the parent passes a fresh
  // handler closure (an every-render cleanup would drop the emphasis mid-hover).
  const hoverRef = useRef(onHoverSource);
  hoverRef.current = onHoverSource;
  useEffect(() => () => hoverRef.current?.(null), []);
  // Track pointer-hover and keyboard-focus targets separately so they don't fight:
  // mousing off row A while row B holds focus must emphasize B, not clear everything.
  // Hover wins over focus when both are set (the pointer is the more direct intent).
  const hovered = useRef<{ id: string; target: EmphasisTarget } | null>(null);
  const focused = useRef<{ id: string; target: EmphasisTarget } | null>(null);
  const emit = () => onHoverSource?.((hovered.current ?? focused.current)?.target ?? null);
  // Hover/focus handlers for any row that maps to an on-chart element (drawing or indicator).
  const hoverProps = (s: ChartOperandSource) =>
    onHoverSource && s.emphasis
      ? {
          onMouseEnter: () => { hovered.current = { id: s.id, target: s.emphasis! }; emit(); },
          onMouseLeave: () => { if (hovered.current?.id === s.id) hovered.current = null; emit(); },
          onFocus: () => { focused.current = { id: s.id, target: s.emphasis! }; emit(); },
          onBlur: () => { if (focused.current?.id === s.id) focused.current = null; emit(); },
        }
      : undefined;
  return (
    <div className="chart-operand-picker-backdrop" onClick={onClose}>
      <div className="chart-operand-picker" onClick={(e) => e.stopPropagation()}>
        <div className="chart-operand-picker-head">
          <span>Add from chart</span>
          <CloseButton onClick={onClose} />
        </div>
        {sources.length === 0 ? (
          <div className="al-note chart-operand-picker-empty">
            No indicators on this chart — add one from the chart toolbar.
          </div>
        ) : (
          <ul className="chart-operand-picker-list">
            {sources.map((s) => {
              const multi = s.outputs.length > 1;
              const swatch = s.color ? (
                <span className="chart-operand-swatch" style={{ background: s.color }} aria-hidden />
              ) : null;
              if (s.disabled) {
                return (
                  <li key={s.id} {...hoverProps(s)}>
                    <Tooltip content={s.disabledReason ?? "Not supported in rules yet"}>
                      <button type="button" className="chart-operand-row" disabled>
                        {swatch}
                        {s.baseLabel}
                      </button>
                    </Tooltip>
                  </li>
                );
              }
              if (!multi) {
                const only = s.outputs[0];
                return (
                  <li key={s.id} {...hoverProps(s)}>
                    <button type="button" className="chart-operand-row" onClick={() => onPick(only.operand)}>
                      {swatch}
                      {s.baseLabel}
                    </button>
                  </li>
                );
              }
              const open = expanded === s.id;
              return (
                <li key={s.id} {...hoverProps(s)}>
                  <button
                    type="button"
                    className="chart-operand-row chart-operand-row-parent"
                    aria-expanded={open}
                    onClick={() => setExpanded(open ? null : s.id)}
                  >
                    <span className={`chart-operand-chevron${open ? " open" : ""}`}>▸</span>
                    {swatch}
                    {s.baseLabel}
                  </button>
                  {open && (
                    <ul className="chart-operand-sublist">
                      {s.outputs.map((o) => (
                        <li key={o.lineIndex}>
                          <button type="button" className="chart-operand-row chart-operand-sub" onClick={() => onPick(o.operand)}>
                            {o.label}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
