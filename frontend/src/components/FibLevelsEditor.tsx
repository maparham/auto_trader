// The fib levels editor: extend, one row per level (on/off, ratio, colour and
// per-level width/dash) and the trend line / reverse / labels switches. Shared
// by the fib drawing tools (DrawingSettings) and the Auto Fib indicator
// (IndicatorSettings); both keep their config as a FibConfig.
import { useState } from "react";
import ColorLineStylePicker, { type LineStyleOpt } from "../ColorLineStylePicker";
import type { FibConfig, FibLevel } from "../lib/fibConfig";

interface Props {
  fib: FibConfig;
  onChange: (next: FibConfig) => void;
  /** Width/dash a level shows while it has no override of its own. */
  sharedSize: number;
  sharedStyle: "solid" | "dashed";
  /** The trendLine switch's label: the retracement's anchor connector, or a
   * fib channel's width leg. Same flag, different line. */
  trendLabel: string;
  /** Show an "All levels" colour/width/dash picker that writes one line style
   * onto every level, replacing their per-level colours and overrides. Auto Fib only: the fib
   * drawings already have their own shared Line row. */
  allLevelsStyle?: boolean;
}

const LINE_STYLES = ["solid", "dashed"] as LineStyleOpt[];

export default function FibLevelsEditor({ fib, onChange, sharedSize, sharedStyle, trendLabel, allLevelsStyle }: Props) {
  const setLevel = (i: number, patch: Partial<FibLevel>) =>
    onChange({ ...fib, levels: fib.levels.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const setAll = (patch: Partial<FibLevel>) => onChange({ ...fib, levels: fib.levels.map((x) => ({ ...x, ...patch })) });
  // The All levels picker previews the first level's effective style; after a
  // pick every level carries it, so it reads true from then on.
  const first = fib.levels[0];
  // The ratio box's raw text while it has focus. Text on the way to a number
  // ("", "-", "0.") is not one, and committing Number() of it saved 0 or NaN:
  // a NaN level is dropped on reload, and on Auto Fib the ratio also names a
  // rule operand. Only a finite parse is written; blur shows the saved value.
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const editRatio = (i: number, raw: string) => {
    setDrafts((d) => ({ ...d, [i]: raw }));
    const n = Number(raw);
    if (raw.trim() !== "" && Number.isFinite(n)) setLevel(i, { value: n });
  };
  const endRatio = (i: number) =>
    setDrafts((d) => {
      const next = { ...d };
      delete next[i];
      return next;
    });
  return (
    <>
      <div className="ind-row fib-extend-row">
        <label htmlFor="fib-extend">Extend</label>
        <select
          id="fib-extend"
          value={fib.extend}
          onChange={(e) => onChange({ ...fib, extend: e.target.value as FibConfig["extend"] })}
        >
          <option value="none">Don't extend</option>
          <option value="left">Extend left</option>
          <option value="right">Extend right</option>
          <option value="both">Extend both</option>
        </select>
      </div>
      {allLevelsStyle && (
        <div className="ind-row fib-extend-row">
          <label>All levels</label>
          <ColorLineStylePicker
            title="Color & line style for all levels"
            color={first?.color ?? "#787b86"}
            onColor={(c) => setAll({ color: c })}
            size={first?.size ?? sharedSize}
            onSize={(s) => setAll({ size: s })}
            lineStyle={first?.style ?? sharedStyle}
            onLineStyle={(s) => setAll({ style: s === "dashed" ? "dashed" : "solid" })}
            lineStyleOptions={LINE_STYLES}
          />
        </div>
      )}
      <div className="fib-levels">
        {fib.levels.map((l, i) => (
          <div className="fib-level" key={i}>
            <input
              type="checkbox"
              aria-label={`Level ${l.value}`}
              checked={l.enabled}
              onChange={(e) => setLevel(i, { enabled: e.target.checked })}
            />
            <input
              type="number"
              step="any"
              aria-label={`Level ${i + 1} ratio`}
              value={drafts[i] ?? String(l.value)}
              onChange={(e) => editRatio(i, e.target.value)}
              onBlur={() => endRatio(i)}
            />
            {/* Everything here is THIS level's: colour, and width/dash stored
                as per-level overrides that win over the shared line style.
                Unset overrides display the shared values. */}
            <ColorLineStylePicker
              color={l.color}
              onColor={(c) => setLevel(i, { color: c })}
              size={l.size ?? sharedSize}
              onSize={(s) => setLevel(i, { size: s })}
              lineStyle={l.style ?? sharedStyle}
              onLineStyle={(s) => setLevel(i, { style: s === "dashed" ? "dashed" : "solid" })}
              lineStyleOptions={LINE_STYLES}
            />
          </div>
        ))}
      </div>
      <label className="ind-check">
        <input type="checkbox" checked={fib.trendLine} onChange={(e) => onChange({ ...fib, trendLine: e.target.checked })} />
        <span>{trendLabel}</span>
      </label>
      <label className="ind-check">
        <input type="checkbox" checked={fib.reverse} onChange={(e) => onChange({ ...fib, reverse: e.target.checked })} />
        <span>Reverse</span>
      </label>
      <label className="ind-check">
        <input type="checkbox" checked={fib.labels} onChange={(e) => onChange({ ...fib, labels: e.target.checked })} />
        <span>Levels</span>
      </label>
    </>
  );
}
