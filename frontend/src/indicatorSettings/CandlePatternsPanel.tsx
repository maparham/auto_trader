// CANDLE_PATTERNS' Inputs-tab editor: a grid of the 16 pattern-group toggles, a
// "Show labels" checkbox, and Bullish / Bearish / Neutral colour swatches. The
// whole indicator config is this small extendData object, so (unlike EMA/MA) the
// colours live on the Inputs tab too. Controlled: reads `ext`, writes the full
// next object through `onChange` (never mutates `ext`). Defaults come from the
// detector module so the panel shows the real on-chart values when `ext` is empty.
import {
  CANDLE_PATTERN_TOGGLES,
  DEFAULT_BULL_COLOR,
  DEFAULT_BEAR_COLOR,
  DEFAULT_NEUTRAL_COLOR,
  type CandlePatternsExtend,
} from "../lib/indicators/candlePatterns";
import ColorLineStylePicker from "../ColorLineStylePicker";

export function CandlePatternsPanel({
  ext,
  onChange,
}: {
  ext: CandlePatternsExtend;
  onChange: (next: CandlePatternsExtend) => void;
}) {
  const disabled = ext.disabled ?? {};
  const showLabels = ext.showLabels !== false; // default on
  const bullColor = ext.bullColor ?? DEFAULT_BULL_COLOR;
  const bearColor = ext.bearColor ?? DEFAULT_BEAR_COLOR;
  const neutralColor = ext.neutralColor ?? DEFAULT_NEUTRAL_COLOR;

  // A group is ON when it is not disabled; toggling copies `disabled` (never
  // mutates the incoming ext) and writes the full next object.
  function toggleGroup(id: string, enabled: boolean) {
    onChange({ ...ext, disabled: { ...disabled, [id]: !enabled } });
  }

  const colorRow = (
    label: string,
    color: string,
    key: "bullColor" | "bearColor" | "neutralColor",
  ) => (
    <div className="ind-row ind-style-row">
      <span className="ind-row-head">
        <label>{label}</label>
      </span>
      <div className="ind-line-controls">
        <ColorLineStylePicker
          color={color}
          onColor={(hex) => onChange({ ...ext, [key]: hex })}
          title={`${label} colour`}
        />
      </div>
    </div>
  );

  return (
    <div className="candle-patterns-editor">
      <div className="ind-group">Patterns</div>
      <div className="candle-patterns-grid">
        {CANDLE_PATTERN_TOGGLES.map((t) => (
          <label className="ind-check ind-check-inline" key={t.id}>
            <input
              type="checkbox"
              checked={!disabled[t.id]}
              onChange={(e) => toggleGroup(t.id, e.target.checked)}
            />
            <span>{t.label}</span>
          </label>
        ))}
      </div>

      <div className="ind-group">Display</div>
      <label className="ind-check">
        <input
          type="checkbox"
          checked={showLabels}
          onChange={(e) => onChange({ ...ext, showLabels: e.target.checked })}
        />
        <span>Show labels</span>
      </label>
      {colorRow("Bullish", bullColor, "bullColor")}
      {colorRow("Bearish", bearColor, "bearColor")}
      {colorRow("Neutral", neutralColor, "neutralColor")}
    </div>
  );
}

// currentConfig() delegate: persist only non-default keys so a fresh instance
// carries nothing and picks up future default changes (mirrors sessionsConfig).
export function candlePatternsConfig(
  extendData: Record<string, unknown>,
  ext: CandlePatternsExtend,
) {
  const disabled: Record<string, boolean> = {};
  for (const [id, off] of Object.entries(ext.disabled ?? {})) if (off) disabled[id] = true;
  if (Object.keys(disabled).length) extendData.disabled = disabled;
  if (ext.showLabels === false) extendData.showLabels = false;
  if (ext.bullColor && ext.bullColor !== DEFAULT_BULL_COLOR) extendData.bullColor = ext.bullColor;
  if (ext.bearColor && ext.bearColor !== DEFAULT_BEAR_COLOR) extendData.bearColor = ext.bearColor;
  if (ext.neutralColor && ext.neutralColor !== DEFAULT_NEUTRAL_COLOR)
    extendData.neutralColor = ext.neutralColor;
}
