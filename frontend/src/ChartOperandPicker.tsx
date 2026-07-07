import { useEffect, useRef, useState } from "react";
import FloatingModal from "./components/FloatingModal";
import Tooltip from "./components/Tooltip";
import type { ChartOperandSource, EmphasisTarget } from "./lib/chartOperand";
import type { Operand } from "./lib/backtestConfig";

/** Strategy-side picker: lists the focused cell's on-chart indicators/drawings,
 * one sub-item per active output line, and returns the chosen operand. Purely
 * presentational — the caller enumerates sources and handles the picked operand.
 *
 * Deferred-add: clicking a row SELECTS it (sticky highlight + sticky on-chart
 * emphasis) without committing; the footer [Add] fires `onPick` and closes. This
 * lets the user select, look at the on-chart emphasis, compare, then commit.
 *
 * `onHoverSource(target|null)` lets the caller emphasize the matching on-chart
 * element (drawing overlay or indicator curve). The effective target is
 * hovered ?? focused ?? selected, so the selected item stays emphasized when the
 * pointer leaves the list and hovering another row previews it transiently. */
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
  // The selected output: which source row + which sub-output (0 for single-output
  // rows). Held in state (drives the highlight) AND mirrored into `selected` ref so
  // the emit() precedence can read it without a stale closure.
  const [selected, setSelected] = useState<{ sourceId: string; lineIndex: number } | null>(null);
  // Always release the emphasis when the picker goes away — a row's mouseleave may
  // not fire before onPick/onClose unmount us, which would strand a drawing thickened.
  // Via a ref so this fires ONLY on unmount, not whenever the parent passes a fresh
  // handler closure (an every-render cleanup would drop the emphasis mid-hover).
  const hoverRef = useRef(onHoverSource);
  hoverRef.current = onHoverSource;
  useEffect(() => () => hoverRef.current?.(null), []);
  // Track pointer-hover, keyboard-focus AND selection targets separately so they
  // don't fight: mousing off row A while row B holds focus must emphasize B, and the
  // selected row stays emphasized once the pointer leaves everything. Precedence:
  // hover > focus > selection (the pointer is the most direct intent).
  const hovered = useRef<{ id: string; target: EmphasisTarget } | null>(null);
  const focused = useRef<{ id: string; target: EmphasisTarget } | null>(null);
  const selectedEmphasis = useRef<{ id: string; target: EmphasisTarget } | null>(null);
  const emit = () =>
    onHoverSource?.(
      (hovered.current ?? focused.current ?? selectedEmphasis.current)?.target ?? null,
    );
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

  // Select an output row: sticky highlight + sticky emphasis (via selectedEmphasis).
  const selectOutput = (s: ChartOperandSource, lineIndex: number) => {
    setSelected({ sourceId: s.id, lineIndex });
    selectedEmphasis.current = s.emphasis ? { id: s.id, target: s.emphasis } : null;
    emit();
  };
  const isSelected = (sourceId: string, lineIndex: number) =>
    selected?.sourceId === sourceId && selected.lineIndex === lineIndex;

  // Resolve the currently-selected operand (null when nothing is selected or the
  // selection no longer maps to an output, e.g. sources changed underneath us).
  const selectedOperand: Operand | null = (() => {
    if (!selected) return null;
    const s = sources.find((s) => s.id === selected.sourceId);
    return s?.outputs.find((o) => o.lineIndex === selected.lineIndex)?.operand ?? null;
  })();

  const confirm = () => {
    if (selectedOperand) onPick(selectedOperand);
  };

  const footer =
    sources.length === 0 ? null : (
      <>
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button onClick={confirm} disabled={!selectedOperand}>Add</button>
      </>
    );

  return (
    <FloatingModal
      title="Add from chart"
      onClose={onClose}
      footer={footer}
      initialPlacement="right"
      className="chart-operand-picker"
    >
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
              const sel = isSelected(s.id, only.lineIndex);
              return (
                <li key={s.id} {...hoverProps(s)}>
                  <button
                    type="button"
                    className={`chart-operand-row${sel ? " selected" : ""}`}
                    aria-selected={sel}
                    onClick={() => selectOutput(s, only.lineIndex)}
                  >
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
                    {s.outputs.map((o) => {
                      const sel = isSelected(s.id, o.lineIndex);
                      return (
                        <li key={o.lineIndex}>
                          <button
                            type="button"
                            className={`chart-operand-row chart-operand-sub${sel ? " selected" : ""}`}
                            aria-selected={sel}
                            onClick={() => selectOutput(s, o.lineIndex)}
                          >
                            {o.label}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </FloatingModal>
  );
}
