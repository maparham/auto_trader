// RSI's three panel bodies (Inputs, Divergence, Style) plus the currentConfig()
// delegate. State (rsiSource/rsiSmooth/rsiDiv/rsiStyle) and their writers stay in
// the shell (IndicatorSettings.tsx) — the shell's persistence mega-effect and
// currentConfig() read them directly, and moving the useState calls down here
// would defer the writes by a render tick, corrupting the Cancel snapshot. These
// components are pure render + JSX for the family, taking state + writers as
// explicit props.
import type { ChangeEvent } from "react";
import InfoTip from "../components/InfoTip";
import ColorLineStylePicker from "../ColorLineStylePicker";
import { PRICE_SOURCES } from "../lib/indicatorMeta";
import type {
  RsiDivergenceConfig,
  RsiSmoothing,
  RsiSmoothType,
  RsiStyle,
} from "../lib/customIndicators";
import {
  RSI_DIVERGENCE_DEFAULTS,
  RSI_STYLE_DEFAULTS,
} from "../lib/customIndicators";
import {
  RSI_SMOOTHING_OPTIONS,
  IntInput,
  type RsiLineStyleOpt,
  type RsiHiddenKey,
  type LineDraft,
} from "./shared";

// --- Inputs tab -------------------------------------------------------------
export function RsiInputsPanel({
  calcParams,
  setParam,
  rsiSource,
  rsiSmooth,
  setRsiExtend,
}: {
  calcParams: number[];
  setParam: (index: number, value: number) => void;
  rsiSource: string;
  rsiSmooth: RsiSmoothing;
  setRsiExtend: (patch: { source?: string; smoothing?: RsiSmoothing }) => void;
}) {
  return (
    <>
      <div className="ind-group">RSI Settings</div>
      <div className="ind-row">
        <label>RSI Length</label>
        <input
          type="number"
          min={1}
          step={1}
          value={Number.isFinite(calcParams[0]) ? calcParams[0] : ""}
          onChange={(e) => setParam(0, Math.max(1, Math.floor(Number(e.target.value)) || 1))}
        />
      </div>
      <div className="ind-row">
        <label>Source</label>
        <select value={rsiSource} onChange={(e) => setRsiExtend({ source: e.target.value })}>
          {PRICE_SOURCES.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="ind-group">Smoothing</div>
      <div className="ind-row">
        <label>Type</label>
        <select
          value={rsiSmooth.type}
          onChange={(e) =>
            setRsiExtend({ smoothing: { ...rsiSmooth, type: e.target.value as RsiSmoothType } })
          }
        >
          {RSI_SMOOTHING_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      {/* TV always shows Length + BB StdDev, greying each when inapplicable:
          Length is off when Type is None; BB StdDev only applies to
          'SMA + Bollinger Bands'. */}
      <div className={`ind-row${rsiSmooth.type === "none" ? " is-off" : ""}`}>
        <label>Length</label>
        <input
          type="number"
          min={1}
          step={1}
          value={rsiSmooth.length}
          disabled={rsiSmooth.type === "none"}
          onChange={(e) =>
            setRsiExtend({
              smoothing: { ...rsiSmooth, length: Math.max(1, Math.floor(Number(e.target.value)) || 1) },
            })
          }
        />
      </div>
      <div className={`ind-row${rsiSmooth.type === "sma_bb" ? "" : " is-off"}`}>
        <span className="ind-row-head">
          <label>BB StdDev</label>
          <InfoTip
            title="BB StdDev"
            text="Bollinger Band width in standard deviations. Only used by 'SMA + Bollinger Bands'."
          />
        </span>
        <input
          type="number"
          min={0}
          step={0.1}
          value={rsiSmooth.bbStdDev}
          disabled={rsiSmooth.type !== "sma_bb"}
          onChange={(e) =>
            setRsiExtend({
              smoothing: { ...rsiSmooth, bbStdDev: Math.max(0, Number(e.target.value) || 0) },
            })
          }
        />
      </div>

      <div className="ind-group">Calculation</div>
      <div className="ind-row">
        <span className="ind-row-head">
          <label>Timeframe</label>
          <InfoTip title="Timeframe" text="Higher-timeframe mode is only on EMA and MA." />
        </span>
        <select value="chart" disabled>
          <option value="chart">Chart</option>
        </select>
      </div>
    </>
  );
}

// --- Divergence tab ----------------------------------------------------------
export function RsiDivergencePanel({
  rsiDiv,
  setRsiDivergence,
  resetDivergence,
}: {
  rsiDiv: RsiDivergenceConfig;
  setRsiDivergence: (patch: Partial<RsiDivergenceConfig>) => void;
  resetDivergence: () => void;
}) {
  return (
    <>
      <div className="ind-group">Divergence</div>
      <label className="ind-check">
        <input
          type="checkbox"
          checked={rsiDiv.on}
          onChange={(e) => setRsiDivergence({ on: e.target.checked })}
        />
        <span>Calculate Divergence</span>
        <InfoTip
          title="Calculate Divergence"
          text="Marks divergences on the plot: price makes a new high or low but the RSI does not."
        />
      </label>
      <div className={`ind-row ind-row-pair${rsiDiv.on ? "" : " is-off"}`}>
        <span className="ind-pair-cell">
          <span className="ind-row-head">
            <label>Lookback left</label>
            <InfoTip title="Pivot lookback left" text="Bars required to the left of a swing for it to count as a pivot." />
          </span>
          <IntInput
            min={1}
            disabled={!rsiDiv.on}
            value={rsiDiv.lookbackLeft}
            commit={(n) => setRsiDivergence({ lookbackLeft: Math.max(1, n) })}
          />
        </span>
        <span className="ind-pair-cell">
          <span className="ind-row-head">
            <label>right</label>
            <InfoTip title="Pivot lookback right" text="Bars required to the right to confirm a pivot (the detection lag)." />
          </span>
          <IntInput
            min={1}
            disabled={!rsiDiv.on}
            value={rsiDiv.lookbackRight}
            commit={(n) => {
              const lookbackRight = Math.max(1, n);
              // Keep forming right-lookback ≤ lookbackRight-1 so the shown value never
              // exceeds what detection can use after lowering the confirmed lookback.
              const formingLookbackRight = Math.min(rsiDiv.formingLookbackRight, Math.max(1, lookbackRight - 1));
              setRsiDivergence({ lookbackRight, formingLookbackRight });
            }}
          />
        </span>
      </div>
      <div className={`ind-row ind-row-pair${rsiDiv.on ? "" : " is-off"}`}>
        <span className="ind-pair-cell">
          <span className="ind-row-head">
            <label>Range min</label>
            <InfoTip title="Range min" text="Fewest bars allowed between the two pivots being compared. Always ≤ Range max." />
          </span>
          <IntInput
            min={1}
            max={rsiDiv.rangeMax}
            disabled={!rsiDiv.on}
            value={rsiDiv.rangeMin}
            commit={(n) => setRsiDivergence({ rangeMin: Math.min(rsiDiv.rangeMax, Math.max(1, n)) })}
          />
        </span>
        <span className="ind-pair-cell">
          <span className="ind-row-head">
            <label>max</label>
            <InfoTip title="Range max" text="Most bars allowed between the two pivots being compared. Always ≥ Range min." />
          </span>
          <IntInput
            min={1}
            disabled={!rsiDiv.on}
            value={rsiDiv.rangeMax}
            commit={(n) => setRsiDivergence({ rangeMax: Math.max(rsiDiv.rangeMin, n) })}
          />
        </span>
      </div>
      <label className={`ind-check${rsiDiv.on ? "" : " is-off"}`}>
        <input
          type="checkbox"
          disabled={!rsiDiv.on}
          checked={rsiDiv.bullish}
          onChange={(e) => setRsiDivergence({ bullish: e.target.checked })}
        />
        <span>Regular bullish</span>
        <InfoTip title="Regular bullish" text="Price makes a lower low while RSI makes a higher low." />
      </label>
      <label className={`ind-check${rsiDiv.on ? "" : " is-off"}`}>
        <input
          type="checkbox"
          disabled={!rsiDiv.on}
          checked={rsiDiv.bearish}
          onChange={(e) => setRsiDivergence({ bearish: e.target.checked })}
        />
        <span>Regular bearish</span>
        <InfoTip title="Regular bearish" text="Price makes a higher high while RSI makes a lower high." />
      </label>
      <label className={`ind-check${rsiDiv.on ? "" : " is-off"}`}>
        <input
          type="checkbox"
          disabled={!rsiDiv.on}
          checked={rsiDiv.hiddenBullish}
          onChange={(e) => setRsiDivergence({ hiddenBullish: e.target.checked })}
        />
        <span>Hidden bullish</span>
        <InfoTip title="Hidden bullish" text="Price makes a higher low while RSI makes a lower low." />
      </label>
      <label className={`ind-check${rsiDiv.on ? "" : " is-off"}`}>
        <input
          type="checkbox"
          disabled={!rsiDiv.on}
          checked={rsiDiv.hiddenBearish}
          onChange={(e) => setRsiDivergence({ hiddenBearish: e.target.checked })}
        />
        <span>Hidden bearish</span>
        <InfoTip title="Hidden bearish" text="Price makes a lower high while RSI makes a higher high." />
      </label>
      <label className={`ind-check${rsiDiv.on ? "" : " is-off"}`}>
        <input
          type="checkbox"
          disabled={!rsiDiv.on}
          checked={rsiDiv.showForming}
          onChange={(e) => setRsiDivergence({ showForming: e.target.checked })}
        />
        <span>Show forming divergence</span>
        <InfoTip title="Show forming divergence" text="Also show the latest still-forming divergence (dotted, may be invalidated)." />
      </label>
      <div className={`ind-row${rsiDiv.on && rsiDiv.showForming ? "" : " is-off"}`}>
        <span className="ind-row-head">
          <label>Forming lookback right</label>
          <InfoTip title="Forming lookback right" text="Right-side bars for a tentative pivot; lower = earlier but jumpier. Always < Pivot lookback right." />
        </span>
        <IntInput
          min={1}
          max={Math.max(1, rsiDiv.lookbackRight - 1)}
          disabled={!rsiDiv.on || !rsiDiv.showForming}
          value={rsiDiv.formingLookbackRight}
          commit={(n) =>
            setRsiDivergence({
              formingLookbackRight: Math.min(
                Math.max(1, rsiDiv.lookbackRight - 1),
                Math.max(1, n),
              ),
            })
          }
        />
      </div>
      <label className={`ind-check${rsiDiv.on && rsiDiv.showForming ? "" : " is-off"}`}>
        <input
          type="checkbox"
          disabled={!rsiDiv.on || !rsiDiv.showForming}
          checked={rsiDiv.formingScanBack}
          onChange={(e) => setRsiDivergence({ formingScanBack: e.target.checked })}
        />
        <span>Scan back for forming</span>
        <InfoTip title="Scan back for forming" text="If the latest tentative swing isn't diverging, look further back for an older one that is." />
      </label>
      <div className="ind-row">
        <button type="button" className="ghost" onClick={resetDivergence}>
          Reset to defaults
        </button>
        <InfoTip title="Reset to defaults" text="Restore the divergence tuning to defaults (keeps the on/off toggle)." />
      </div>
    </>
  );
}

// --- Style tab ----------------------------------------------------------------
// Mirrors TradingView's RSI Style tab. Every row has a visibility checkbox;
// line elements add a style (solid/dashed/dotted), bands add an editable level.
// The RSI line is the klinecharts figure (colour/width via setLine); the rest
// are canvas-drawn (extendData.style). A box toggles `style.hidden[key]`
// (unchecked → hidden).
export function RsiStylePanel({
  lines,
  setLine,
  rsiStyle,
  setRsiStylePatch,
}: {
  lines: LineDraft[];
  setLine: (key: string, patch: Partial<LineDraft>) => void;
  rsiStyle: RsiStyle;
  setRsiStylePatch: (patch: Partial<RsiStyle>) => void;
}) {
  const toggle = (key: RsiHiddenKey) => (e: ChangeEvent<HTMLInputElement>) =>
    setRsiStylePatch({ hidden: { ...rsiStyle.hidden, [key]: !e.target.checked } });
  const check = (key: RsiHiddenKey, label: string) => (
    <label className="ind-check ind-check-inline">
      <input type="checkbox" checked={!rsiStyle.hidden[key]} onChange={toggle(key)} />
      <span>{label}</span>
    </label>
  );
  // A line element (MA, bands): one swatch with colour + line style.
  const lineSwatch = (
    color: string,
    style: RsiLineStyleOpt,
    onColor: (c: string) => void,
    onStyle: (v: RsiLineStyleOpt) => void,
  ) => (
    <ColorLineStylePicker
      color={color}
      onColor={onColor}
      lineStyle={style}
      onLineStyle={(v) => onStyle(v as RsiLineStyleOpt)}
    />
  );
  // A fill / divergence element: colour only.
  const fillSwatch = (color: string, onColor: (c: string) => void) => (
    <ColorLineStylePicker color={color} onColor={onColor} title="Color" />
  );
  const rsiLine = lines.find((l) => l.key === "rsi");
  return (
    <div className="ind-rsi-style">
      {/* The RSI line (figure): always shown (the indicator's whole
          point), so its checkbox is permanently checked + disabled.
          Colour + thickness via setLine. */}
      <div className="ind-row ind-style-row">
        <label className="ind-check ind-check-inline">
          <input type="checkbox" checked disabled readOnly />
          <span>RSI</span>
        </label>
        <div className="ind-line-controls">
          <ColorLineStylePicker
            color={rsiLine?.color ?? "#7E57C2"}
            onColor={(hex) => setLine("rsi", { color: hex })}
            size={rsiLine?.size ?? 1}
            onSize={(s) => setLine("rsi", { size: s })}
          />
        </div>
      </div>
      {/* RSI-based MA: colour + line style. */}
      <div className="ind-row ind-style-row">
        {check("ma", "RSI-based MA")}
        <div className="ind-line-controls">
          {lineSwatch(
            rsiStyle.ma,
            rsiStyle.maLineStyle,
            (c) => setRsiStylePatch({ ma: c }),
            (v) => setRsiStylePatch({ maLineStyle: v }),
          )}
        </div>
      </div>
      {/* Divergence colours. */}
      <div className="ind-row ind-style-row">
        {check("bull", "Regular Bullish")}
        <div className="ind-line-controls">
          {fillSwatch(rsiStyle.bull, (c) => setRsiStylePatch({ bull: c }))}
        </div>
      </div>
      <div className="ind-row ind-style-row">
        {check("bear", "Regular Bearish")}
        <div className="ind-line-controls">
          {fillSwatch(rsiStyle.bear, (c) => setRsiStylePatch({ bear: c }))}
        </div>
      </div>
      {/* Band lines: colour + line style + level. */}
      {(
        [
          ["RSI Upper Band", "upper"],
          ["RSI Middle Band", "middle"],
          ["RSI Lower Band", "lower"],
        ] as Array<[string, "upper" | "middle" | "lower"]>
      ).map(([label, key]) => (
        <div className="ind-row ind-style-row" key={key}>
          {check(key, label)}
          <div className="ind-line-controls">
            {lineSwatch(
              rsiStyle[key].color,
              rsiStyle[key].lineStyle,
              (c) => setRsiStylePatch({ [key]: { ...rsiStyle[key], color: c } }),
              (v) => setRsiStylePatch({ [key]: { ...rsiStyle[key], lineStyle: v } }),
            )}
            <input
              type="number"
              min={0}
              max={100}
              step={1}
              value={rsiStyle[key].level}
              onChange={(e) =>
                setRsiStylePatch({
                  [key]: {
                    ...rsiStyle[key],
                    level: Math.max(0, Math.min(100, Math.floor(Number(e.target.value)) || 0)),
                  },
                })
              }
              title="Level"
            />
          </div>
        </div>
      ))}
      {/* Fills: colour only. */}
      {(
        [
          ["RSI Background Fill", "bgFill", "bg"],
          ["Overbought Gradient Fill", "obFill", "ob"],
          ["Oversold Gradient Fill", "osFill", "os"],
        ] as Array<[string, "bgFill" | "obFill" | "osFill", RsiHiddenKey]>
      ).map(([label, key, hk]) => (
        <div className="ind-row ind-style-row" key={key}>
          {check(hk, label)}
          <div className="ind-line-controls">
            {fillSwatch(rsiStyle[key], (c) => setRsiStylePatch({ [key]: c }))}
          </div>
        </div>
      ))}
    </div>
  );
}

// --- currentConfig() delegate --------------------------------------------------
// Source + smoothing + divergence: only persist each when it differs from the
// defaults, so a plain RSI carries no extra keys. Mutates the passed extendData
// object (matching the shell's currentConfig() convention for other families).
export function rsiConfig(
  extendData: Record<string, unknown>,
  rsiSource: string,
  rsiSmooth: RsiSmoothing,
  rsiDiv: RsiDivergenceConfig,
  rsiStyle: RsiStyle,
) {
  if (rsiSource !== "close") extendData.source = rsiSource;
  if (rsiSmooth.type !== "none") extendData.smoothing = rsiSmooth;
  const isDefault = (Object.keys(RSI_DIVERGENCE_DEFAULTS) as Array<keyof RsiDivergenceConfig>).every(
    (k) => rsiDiv[k] === RSI_DIVERGENCE_DEFAULTS[k],
  );
  if (!isDefault) extendData.divergence = rsiDiv;
  if (JSON.stringify(rsiStyle) !== JSON.stringify(RSI_STYLE_DEFAULTS)) extendData.style = rsiStyle;
}
