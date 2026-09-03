// The "Slope" tab: color the MA's main line by slope state (spec
// 2026-07-06-slope-colored-ma-design.md). Pure controlled panel — all writes
// go through patch(); the modal owns live-apply + persistence.
import { useState } from "react";
import InfoTip from "../components/InfoTip";
import ColorLineStylePicker from "../ColorLineStylePicker";
import { defaultSlopeColor, type SlopeColorConfig, type SlopeStateStyle } from "../lib/indicators/slopeColor";
import { IntInput, parseColor, toColor } from "./shared";

const STATE_ROWS: { key: "up" | "down" | "flat"; label: string }[] = [
  { key: "up", label: "Rising" },
  { key: "down", label: "Falling" },
  { key: "flat", label: "Flat" },
];

// Persist extendData.slopeColor only when enabled, or customized away from the
// fixed defaults — a plain (disabled, default) instance carries no key at all.
export function slopeColorConfig(
  extendData: Record<string, unknown>,
  sc: SlopeColorConfig | null,
): void {
  if (sc && (sc.enabled || JSON.stringify(sc) !== JSON.stringify(defaultSlopeColor()))) {
    extendData.slopeColor = sc;
  } else {
    delete extendData.slopeColor;
  }
}

export default function SlopeColorPanel({
  sc,
  patch,
}: {
  sc: SlopeColorConfig;
  patch: (p: Partial<SlopeColorConfig>) => void;
}) {
  // Flat-band %/bar: keep a string draft while focused, like IntInput's
  // falsy-zero trap, since it applies to floats too — commit only keystrokes
  // that parse via Number() and are >= 0; blur drops the draft.
  const [flatDraft, setFlatDraft] = useState<string | null>(null);

  return (
    <>
      <label className="ind-check">
        <input
          type="checkbox"
          checked={sc.enabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
        />
        <span>Color by slope</span>
        <InfoTip
          title="Color by slope"
          text="Color the main line by its slope: rising, falling, or flat within the ± band."
        />
      </label>
      <div className={`ind-row${sc.enabled ? "" : " is-off"}`}>
        <label>Lookback</label>
        <IntInput
          value={sc.len}
          min={1}
          disabled={!sc.enabled}
          commit={(n) => patch({ len: Math.max(1, n) })}
        />
      </div>
      <div className={`ind-row${sc.enabled ? "" : " is-off"}`}>
        <label>Flat band ±</label>
        <input
          type="number"
          min={0}
          step={0.05}
          disabled={!sc.enabled}
          value={flatDraft ?? sc.flatBandPct}
          onChange={(e) => {
            setFlatDraft(e.target.value);
            const n = Number(e.target.value);
            if (e.target.value !== "" && Number.isFinite(n) && n >= 0) patch({ flatBandPct: n });
          }}
          onBlur={() => setFlatDraft(null)}
        />
        <span className="ind-note">%/bar</span>
      </div>
      <div className="ind-group">Colors</div>
      {STATE_ROWS.map(({ key, label }) => {
        const style: SlopeStateStyle = sc[key];
        const { hex, alpha } = parseColor(style.color);
        return (
          <div className={`ind-row ind-style-row${sc.enabled ? "" : " is-off"}`} key={key}>
            <span className="ind-row-head">
              <label>{label}</label>
            </span>
            <div className="ind-line-controls">
              <ColorLineStylePicker
                color={hex}
                onColor={(c) => patch({ [key]: { ...style, color: toColor(c, alpha) } } as Partial<SlopeColorConfig>)}
                opacity={alpha}
                onOpacity={(a) => patch({ [key]: { ...style, color: toColor(hex, a) } } as Partial<SlopeColorConfig>)}
                size={style.size ?? 1}
                onSize={(s) => patch({ [key]: { ...style, size: s } } as Partial<SlopeColorConfig>)}
                lineStyle={style.style ?? "solid"}
                onLineStyle={(s) => patch({ [key]: { ...style, style: s } } as Partial<SlopeColorConfig>)}
                disabled={!sc.enabled}
              />
            </div>
          </div>
        );
      })}
    </>
  );
}
