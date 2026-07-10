// MA/EMA and AVWAP Inputs-tab panels, their `apply*` writers, and the
// currentConfig() delegates. State (maLength/source/offset/smoothType/
// smoothLen/timeframe for MA; avwapSource/bandMode/bands for AVWAP) stays in
// the shell (read directly by the persistence mega-effect and
// currentConfig()); `applyMa` also stays reachable from the shell's
// `setParam` (MA Length can be edited via the generic calcParam path too), so
// it's built here as a factory the shell assigns to a local `applyMa` it can
// call from both the panel props and setParam.
import type { Chart } from "klinecharts";
import InfoTip from "../components/InfoTip";
import { PRICE_SOURCES, SMOOTHING_TYPES } from "../lib/indicatorMeta";
import { applyMaTimeframe } from "../lib/mtfCoordinator";
import type { MaExtend, AvwapExtend, BandMode, BandSetting } from "../lib/customIndicators";

// --- MA/EMA -------------------------------------------------------------------

// Push a moving-average config (chart-TF or MTF) through the coordinator, which
// refetches HTF data when a timeframe is set. Reads explicit overrides so it
// never races setState.
export function makeApplyMa(
  chart: Chart,
  epic: string,
  name: string,
  paneId: string,
  brokerId: string,
  type: string,
  state: {
    maLength: number;
    source: string;
    offset: number;
    smoothType: string;
    smoothLen: number;
    timeframe: string;
  },
) {
  return function applyMa(
    next: Partial<{
      length: number;
      source: string;
      offset: number;
      smoothType: string;
      smoothLen: number;
      timeframe: string;
    }> = {},
  ) {
    const length = next.length ?? state.maLength;
    const src = (next.source ?? state.source) as MaExtend["source"];
    const off = next.offset ?? state.offset;
    const st = next.smoothType ?? state.smoothType;
    const sl = next.smoothLen ?? state.smoothLen;
    const tf = next.timeframe ?? state.timeframe;
    const options: MaExtend = {
      source: src,
      offset: off,
      smoothing: st === "none" ? undefined : { type: st as "sma" | "ema", length: sl },
    };
    void applyMaTimeframe(
      chart,
      epic,
      name,
      paneId,
      { kind: type === "EMA" ? "ema" : "sma", length, options },
      tf === "chart" ? null : tf,
      brokerId,
    );
  };
}

export function MaInputsPanel({
  maLength,
  setMaLength,
  source,
  setSource,
  offset,
  setOffset,
  smoothType,
  setSmoothType,
  smoothLen,
  setSmoothLen,
  timeframe,
  setTimeframe,
  higherTimeframes,
  applyMa,
}: {
  maLength: number;
  setMaLength: (n: number) => void;
  source: string;
  setSource: (s: string) => void;
  offset: number;
  setOffset: (n: number) => void;
  smoothType: string;
  setSmoothType: (s: string) => void;
  smoothLen: number;
  setSmoothLen: (n: number) => void;
  timeframe: string;
  setTimeframe: (tf: string) => void;
  higherTimeframes: { resolution: string; label: string }[];
  applyMa: (next: Partial<{
    length: number;
    source: string;
    offset: number;
    smoothType: string;
    smoothLen: number;
    timeframe: string;
  }>) => void;
}) {
  return (
    <>
      <div className="ind-row">
        <label>Length</label>
        <input
          type="number"
          min={1}
          value={maLength}
          onChange={(e) => {
            const v = Number(e.target.value);
            setMaLength(v);
            applyMa({ length: v });
          }}
        />
      </div>
      <div className="ind-row">
        <label>Source</label>
        <select
          value={source}
          onChange={(e) => {
            setSource(e.target.value);
            applyMa({ source: e.target.value });
          }}
        >
          {PRICE_SOURCES.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="ind-row">
        <label>Offset</label>
        <input
          type="number"
          step={1}
          value={offset}
          onChange={(e) => {
            const v = Number(e.target.value);
            setOffset(v);
            applyMa({ offset: v });
          }}
        />
      </div>

      <div className="ind-group">Smoothing</div>
      <div className="ind-row">
        <label>Type</label>
        <select
          value={smoothType}
          onChange={(e) => {
            setSmoothType(e.target.value);
            applyMa({ smoothType: e.target.value });
          }}
        >
          {SMOOTHING_TYPES.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      {smoothType !== "none" && (
        <div className="ind-row">
          <label>Length</label>
          <input
            type="number"
            min={1}
            value={smoothLen}
            onChange={(e) => {
              const v = Number(e.target.value);
              setSmoothLen(v);
              applyMa({ smoothLen: v });
            }}
          />
        </div>
      )}

      <div className="ind-group">Calculation</div>
      <div className="ind-row">
        <label>Timeframe</label>
        <select
          value={timeframe}
          onChange={(e) => {
            setTimeframe(e.target.value);
            applyMa({ timeframe: e.target.value });
          }}
        >
          <option value="chart">Chart</option>
          {higherTimeframes.map((p) => (
            <option key={p.resolution} value={p.resolution}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <span className="ind-row-head">
        <label className="ind-check">
          <input type="checkbox" checked disabled readOnly />
          <span>Wait for timeframe closes</span>
        </label>
        <InfoTip
          title="Wait for timeframe closes"
          text="Uses only closed higher-timeframe bars. No peeking at the current, unfinished bar."
        />
      </span>
    </>
  );
}

// currentConfig() MA delegate: source/offset/smoothing/mtf timeframe.
export function maConfig(
  extendData: Record<string, unknown>,
  source: string,
  offset: number,
  smoothType: string,
  smoothLen: number,
  timeframe: string,
) {
  extendData.source = source;
  extendData.offset = offset;
  if (smoothType !== "none") extendData.smoothing = { type: smoothType, length: smoothLen };
  if (timeframe !== "chart") extendData.mtf = { timeframe };
}

// --- AVWAP ---------------------------------------------------------------------

// AVWAP source/bands apply: write the config onto extendData and let calc
// re-run (the generic `apply` only touches calcParams/visible/styles, so it
// would NOT recompute on a source/band change). Reads explicit overrides so it
// never races setState, and merges live extendData to preserve hideLegendValue.
export function makeApplyAvwap(
  chart: Chart,
  name: string,
  paneId: string,
  state: {
    avwapSource: string;
    bandMode: BandMode;
    bands: [BandSetting, BandSetting, BandSetting];
  },
) {
  return function applyAvwap(
    next: Partial<{
      source: string;
      bandMode: BandMode;
      bands: [BandSetting, BandSetting, BandSetting];
      lineHidden: Record<string, boolean>;
    }> = {},
  ) {
    const live = chart.getIndicatorByPaneId(paneId, name) as import("klinecharts").Indicator | null;
    const ext: AvwapExtend = {
      ...((live?.extendData as AvwapExtend) ?? {}),
      source: (next.source ?? state.avwapSource) as AvwapExtend["source"],
      bandMode: next.bandMode ?? state.bandMode,
      bands: next.bands ?? state.bands,
      ...(next.lineHidden ? { lineHidden: next.lineHidden } : {}),
    };
    chart.overrideIndicator({ name, extendData: ext }, paneId);
  };
}

export function AvwapInputsPanel({
  bandMode,
  setBandMode,
  bands,
  setBands,
  avwapSource,
  setAvwapSource,
  applyAvwap,
}: {
  bandMode: BandMode;
  setBandMode: (m: BandMode) => void;
  bands: [BandSetting, BandSetting, BandSetting];
  setBands: (b: [BandSetting, BandSetting, BandSetting]) => void;
  avwapSource: string;
  setAvwapSource: (s: string) => void;
  applyAvwap: (next: Partial<{
    source: string;
    bandMode: BandMode;
    bands: [BandSetting, BandSetting, BandSetting];
    lineHidden: Record<string, boolean>;
  }>) => void;
}) {
  return (
    <>
      <div className="ind-group">Bands Settings</div>
      <div className="ind-row">
        <label>Mode</label>
        <select
          className="ind-wide-select"
          value={bandMode}
          onChange={(e) => {
            const v = e.target.value as BandMode;
            setBandMode(v);
            applyAvwap({ bandMode: v });
          }}
        >
          <option value="stdev">Standard Deviation</option>
          <option value="percentage">Percentage</option>
        </select>
      </div>
      {bands.map((b, i) => (
        <div className="ind-row" key={i}>
          <label className="ind-check ind-check-inline">
            <input
              type="checkbox"
              checked={b.on}
              onChange={(e) => {
                const nextB = bands.map((x, j) =>
                  j === i ? { ...x, on: e.target.checked } : x,
                ) as [BandSetting, BandSetting, BandSetting];
                setBands(nextB);
                applyAvwap({ bands: nextB });
              }}
            />
            <span>Bands Multiplier #{i + 1}</span>
          </label>
          <input
            type="number"
            step={0.1}
            min={0}
            value={b.mult}
            onChange={(e) => {
              const nextB = bands.map((x, j) =>
                j === i ? { ...x, mult: Number(e.target.value) } : x,
              ) as [BandSetting, BandSetting, BandSetting];
              setBands(nextB);
              applyAvwap({ bands: nextB });
            }}
          />
        </div>
      ))}
      <div className="ind-row">
        <label>Source</label>
        <select
          value={avwapSource}
          onChange={(e) => {
            setAvwapSource(e.target.value);
            applyAvwap({ source: e.target.value });
          }}
        >
          {PRICE_SOURCES.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}

// currentConfig() AVWAP delegate: source/bandMode/bands.
export function avwapConfig(
  extendData: Record<string, unknown>,
  avwapSource: string,
  bandMode: BandMode,
  bands: [BandSetting, BandSetting, BandSetting],
) {
  extendData.source = avwapSource;
  extendData.bandMode = bandMode;
  extendData.bands = bands;
}
