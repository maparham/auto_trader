// Picking-mode chrome for chart replay: pick a start point on the chart (behind
// the curtain that hides everything to its right) or jump to a random point in a
// window. Presentational only — all state lives in chart/useReplay.ts.
import { useEffect, useRef, useState } from "react";
import InfoTip from "./components/InfoTip";
import Tooltip from "./components/Tooltip";
import { JUMP_WINDOWS, type JumpWindowKey } from "./lib/replaySession";

interface Props {
  loading: boolean;
  error: string | null;
  /** Jump to a random point inside `windowMs` before now. */
  onJump(windowMs: number, masked: boolean): void;
  /** Arm the masking choice. It governs BOTH paths: the curtain click reads it,
   * and Jump passes it through. Owned by the caller so it survives a cancel and
   * re-enter; the checkbox below renders it, never a local copy. */
  onMaskedChange(masked: boolean): void;
  masked: boolean;
  onCancel(): void;
}

const DAY_MS = 86_400_000;

export default function ReplayStartPanel({
  loading,
  error,
  onJump,
  onMaskedChange,
  masked,
  onCancel,
}: Props) {
  const [windowKey, setWindowKey] = useState<JumpWindowKey>("1M");
  const [customDays, setCustomDays] = useState("90");
  const rootRef = useRef<HTMLDivElement>(null);

  // Esc cancels picking (the curtain is a modal-ish mode).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // Outside click cancels picking, like every other popover in the app. But a
  // click on THIS CELL'S CHART is the pick itself, so the whole .chart-wrap counts
  // as "inside": dismissing there would fight the very gesture the panel is asking
  // for. A click on another cell / the toolbar / a sidebar is genuinely outside and
  // ends picking. mousedown runs before click, and this handler returns early for
  // in-cell targets, so the pick's own click still lands.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const root = rootRef.current;
      const target = e.target as Node | null;
      if (!root || !target) return;
      if (root.contains(target)) return;
      if (root.closest(".chart-wrap")?.contains(target)) return;
      onCancel();
    };
    // Capture: klinecharts' canvas can stopPropagation on pointer events, so
    // listen on the way down (same reason ColorLineStylePicker does).
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [onCancel]);

  // JUMP_WINDOWS' "custom" entry carries ms: 0 — a span the picker would read as a
  // degenerate jump at the live edge. The days field supplies the real one.
  const windowMs = () => {
    if (windowKey === "custom") return Math.max(1, Number(customDays) || 1) * DAY_MS;
    return JUMP_WINDOWS.find((w) => w.key === windowKey)?.ms ?? 30 * DAY_MS;
  };

  return (
    <div className="replay-start-panel" ref={rootRef}>
      <div className="rsp-title">
        Start replay
        <InfoTip
          title="Bar replay"
          text={[
            "Pick a point in the past and play the bars forward one at a time.",
            "Click the chart to set the start (everything to the right is hidden), or jump to a random point.",
          ]}
        />
      </div>

      <div className="rsp-hint">Click the chart to pick a start point.</div>

      <div className="rsp-row">
        <span className="rsp-label">Random jump</span>
        <select
          className="rsp-select"
          aria-label="Random jump window"
          value={windowKey}
          onChange={(e) => setWindowKey(e.target.value as JumpWindowKey)}
        >
          {JUMP_WINDOWS.map((w) => (
            <option key={w.key} value={w.key}>
              {w.label}
            </option>
          ))}
        </select>
      </div>

      {windowKey === "custom" && (
        <div className="rsp-row">
          <span className="rsp-label">Days back</span>
          <input
            className="rsp-input"
            type="number"
            min={1}
            aria-label="Days back"
            value={customDays}
            onChange={(e) => setCustomDays(e.target.value)}
          />
        </div>
      )}

      {/* ONE checkbox, DEFAULT CHECKED, governing BOTH the manual pick and the
          jump: its value is passed straight through on both paths. This diverges
          from spec §3 ("ON for random jumps, OFF for manual picks") on purpose. A
          single control cannot honestly carry two defaults, and the earlier
          attempt at it (a `touched` ref) rendered the box unchecked while Jump
          silently applied masking. Blind-by-default is the feature's stated
          purpose (removing hindsight bias); one click opts out before picking. */}
      <label className="rsp-check">
        <input
          type="checkbox"
          checked={masked}
          onChange={(e) => onMaskedChange(e.target.checked)}
        />
        Hide dates
        <InfoTip
          title="Hide dates"
          text="Blind session: the axis, crosshair and tooltip show Day 1, Day 2 (and so on) instead of real dates. The real dates are revealed when you exit."
        />
      </label>

      <div className="rsp-actions">
        <Tooltip content="Jump to a random point in the window">
          <button
            type="button"
            className="rsp-jump"
            disabled={loading}
            onClick={() => onJump(windowMs(), masked)}
          >
            {loading ? "Finding candles..." : "Jump"}
          </button>
        </Tooltip>
        <Tooltip content="Roll again for a different point">
          <button
            type="button"
            className="rsp-reroll"
            disabled={loading}
            aria-label="Re-roll"
            onClick={() => onJump(windowMs(), masked)}
          >
            ⚄
          </button>
        </Tooltip>
        <button type="button" className="rsp-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>

      {error && <div className="rsp-error">{error}</div>}
    </div>
  );
}
