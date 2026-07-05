// A TradingView-style color + line-style picker popover (the swatch you click in a
// Style tab). The trigger is a small swatch button; clicking it opens a portaled
// panel — anchored to the trigger's rect and rendered to <body> so it escapes the
// settings modal's clipping / stacking context (same approach as InfoTip). The
// panel offers, top to bottom:
//   • a fixed palette grid (TradingView's hues + a greyscale top row)
//   • a "+" tile that opens the native colour picker for an arbitrary colour
//   • an opacity slider + % readout            (only when `opacity` is supplied)
//   • thickness presets, drawn at their real weight   (only when `size` is supplied)
//   • line-style presets (solid / dashed / dotted)    (only when `lineStyle` is set)
//
// The component speaks a NEUTRAL vocabulary — hex colour, 0..1 opacity, numeric
// size, "solid"|"dashed"|"dotted" — so indicator lines and drawings (which store
// these differently) both map onto it. A call site passes only the props it
// supports; unsupported sections are hidden, so the same popover degrades to a
// plain colour picker for fills.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Tooltip from "./components/Tooltip";

export type LineStyleOpt = "solid" | "dashed" | "dotted";

interface Props {
  color: string; // hex (#RRGGBB)
  onColor: (hex: string) => void;
  // Opacity 0..1. Omit to hide the opacity slider (e.g. drawings / solid fills).
  opacity?: number;
  onOpacity?: (a: number) => void;
  // Line thickness in px. Omit to hide the thickness presets.
  size?: number;
  onSize?: (s: number) => void;
  // Dash style. Omit to hide the line-style presets. `lineStyleOptions` narrows the
  // offered set (drawings support solid/dashed only — klinecharts has no dotted).
  lineStyle?: LineStyleOpt;
  onLineStyle?: (s: LineStyleOpt) => void;
  lineStyleOptions?: LineStyleOpt[];
  disabled?: boolean;
  title?: string;
}

// TradingView's swatch palette: a greyscale top row, then six tint/shade rows of
// the core hue wheel. Picking one sets the hex; opacity is a separate axis.
const PALETTE: string[] = [
  // greyscale
  "#ffffff", "#d1d4dc", "#9598a1", "#787b86", "#5d606b", "#434651", "#363a45", "#2a2e39", "#1e222d", "#131722",
  // saturated
  "#f7525f", "#ff9800", "#ffeb3b", "#4caf50", "#089981", "#00bcd4", "#2962ff", "#673ab7", "#9c27b0", "#e91e63",
  // light tints
  "#fccbcc", "#ffe0b2", "#fff9c4", "#c8e6c9", "#b2dfdb", "#b2ebf2", "#bbd9fb", "#d1c4e9", "#e1bee7", "#f8bbd0",
  "#faa1a4", "#ffcc80", "#fff59d", "#a5d6a7", "#80cbc4", "#80deea", "#90bff9", "#b39ddb", "#ce93d8", "#f48fb1",
  // dark shades
  "#f77c80", "#ffb74d", "#fff176", "#81c784", "#4db6ac", "#4dd0e1", "#6f9df7", "#9575cd", "#ba68c8", "#f06292",
  "#b71c1c", "#e65100", "#f9a825", "#1b5e20", "#004d40", "#006064", "#0d47a1", "#311b92", "#4a148c", "#880e4f",
];

const SIZES = [1, 2, 3, 4];

const LINE_STYLE_LABEL: Record<LineStyleOpt, string> = {
  solid: "Solid",
  dashed: "Dashed",
  dotted: "Dotted",
};
// dasharray for the preview stroke of each style.
const LINE_STYLE_DASH: Record<LineStyleOpt, string | undefined> = {
  solid: undefined,
  dashed: "5 4",
  dotted: "1.5 3",
};

function sameColor(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

export default function ColorLineStylePicker({
  color,
  onColor,
  opacity,
  onOpacity,
  size,
  onSize,
  lineStyle,
  onLineStyle,
  lineStyleOptions = ["solid", "dashed", "dotted"],
  disabled,
  title,
}: Props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const nativeRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  // Anchor the panel under the trigger. Measured from the live rect each open, so it
  // tracks the (draggable) settings modal's current position.
  function place() {
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) setPos({ x: r.left, y: r.bottom + 6 });
  }

  // Close on outside-click / Escape while open. The trigger + portaled panel are in
  // different DOM subtrees, so the test checks both. Both listeners run in the
  // capture phase: the settings modal calls stopPropagation on mousedown, which
  // would otherwise stop the bubble-phase listener from seeing clicks inside it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation(); // don't also close the settings modal
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  function toggle() {
    if (disabled) return;
    if (!open) place();
    setOpen((v) => !v);
  }

  // The swatch shows the colour at its current opacity over a checkerboard, so a
  // faint line reads as faint right on the trigger.
  const swatchAlpha = opacity != null ? opacity : 1;
  // TradingView's field shows a line preview beside the colour chip — at the real
  // colour, thickness and dash style — whenever this picker controls a line. For
  // fill-only call sites (no size / no lineStyle) we keep just the colour chip.
  const showLinePreview = size != null || lineStyle != null;

  return (
    <>
      <Tooltip content={title ?? "Color & line style"}>
        <button
          ref={triggerRef}
          type="button"
          className={`clsp-swatch${showLinePreview ? " clsp-swatch--line" : ""}${open ? " on" : ""}`}
          disabled={disabled}
          onClick={toggle}
        >
          <span
            className="clsp-swatch-fill"
            style={{ background: color, opacity: swatchAlpha }}
          />
          {showLinePreview && (
            <svg
              className="clsp-swatch-line"
              viewBox="0 0 40 16"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <line
                x1="2"
                y1="8"
                x2="38"
                y2="8"
                stroke={color}
                strokeOpacity={swatchAlpha}
                strokeWidth={size ?? 2}
                strokeDasharray={lineStyle ? LINE_STYLE_DASH[lineStyle] : undefined}
                strokeLinecap={lineStyle === "dotted" ? "round" : "butt"}
              />
            </svg>
          )}
        </button>
      </Tooltip>
      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            className="clsp-panel"
            style={{ left: pos.x, top: pos.y }}
            role="dialog"
          >
            <div className="clsp-grid">
              {PALETTE.map((c) => (
                <Tooltip key={c} content={c}>
                  <button
                    type="button"
                    className={`clsp-cell${sameColor(c, color) ? " sel" : ""}`}
                    style={{ background: c }}
                    onClick={() => onColor(c)}
                  />
                </Tooltip>
              ))}
            </div>

            {/* Custom colour: a "+" tile delegating to the native picker (the escape
                hatch for any hue not on the grid). */}
            <div className="clsp-custom">
              <Tooltip content="Custom color">
                <button
                  type="button"
                  className="clsp-add"
                  onClick={() => nativeRef.current?.click()}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  <input
                    ref={nativeRef}
                    type="color"
                    value={/^#[0-9a-f]{6}$/i.test(color) ? color : "#000000"}
                    onChange={(e) => onColor(e.target.value)}
                  />
                </button>
              </Tooltip>
            </div>

            {opacity != null && onOpacity && (
              <div className="clsp-section">
                <div className="clsp-label">Opacity</div>
                <div className="clsp-opacity-row">
                  <input
                    type="range"
                    className="clsp-opacity"
                    min={0}
                    max={100}
                    value={Math.round(opacity * 100)}
                    onChange={(e) => onOpacity(Number(e.target.value) / 100)}
                  />
                  <span className="clsp-opacity-val">{Math.round(opacity * 100)}%</span>
                </div>
              </div>
            )}

            {size != null && onSize && (
              <div className="clsp-section">
                <div className="clsp-label">Thickness</div>
                <div className="clsp-presets">
                  {SIZES.map((s) => (
                    <Tooltip key={s} content={`${s}px`}>
                      <button
                        type="button"
                        className={`clsp-preset${s === size ? " sel" : ""}`}
                        onClick={() => onSize(s)}
                      >
                        <svg viewBox="0 0 40 16" width="40" height="16" aria-hidden="true">
                          <line x1="3" y1="8" x2="37" y2="8" strokeWidth={s} />
                        </svg>
                      </button>
                    </Tooltip>
                  ))}
                </div>
              </div>
            )}

            {lineStyle != null && onLineStyle && (
              <div className="clsp-section">
                <div className="clsp-label">Line style</div>
                <div className="clsp-presets">
                  {lineStyleOptions.map((opt) => (
                    <Tooltip key={opt} content={LINE_STYLE_LABEL[opt]}>
                      <button
                        type="button"
                        className={`clsp-preset${opt === lineStyle ? " sel" : ""}`}
                        onClick={() => onLineStyle(opt)}
                      >
                        <svg viewBox="0 0 40 16" width="40" height="16" aria-hidden="true">
                          <line
                            x1="3"
                            y1="8"
                            x2="37"
                            y2="8"
                            strokeWidth={2}
                            strokeDasharray={LINE_STYLE_DASH[opt]}
                            strokeLinecap={opt === "dotted" ? "round" : "butt"}
                          />
                        </svg>
                      </button>
                    </Tooltip>
                  ))}
                </div>
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
