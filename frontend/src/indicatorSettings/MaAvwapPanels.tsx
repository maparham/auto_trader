// MA/EMA and AVWAP Inputs-tab panels, their `apply*` writers, and the
// currentConfig() delegates. State (maLength/source/offset/smoothType/
// smoothLen/timeframe for MA; avwapSource/bandMode/bands for AVWAP) stays in
// the shell (read directly by the persistence mega-effect and
// currentConfig()); `applyMa` also stays reachable from the shell's
// `setParam` (MA Length can be edited via the generic calcParam path too), so
// it's built here as a factory the shell assigns to a local `applyMa` it can
// call from both the panel props and setParam.
import type { Chart } from "klinecharts";
import { getIndicator } from "../lib/indicators";
import InfoTip from "../components/InfoTip";
import { PRICE_SOURCES, SMOOTHING_TYPES } from "../lib/indicatorMeta";
import { applyMaTimeframe } from "../lib/mtfCoordinator";
import type { MaExtend, AvwapExtend, BandMode, BandSetting } from "../lib/customIndicators";
import { normalizeMaKind, type MaKind } from "../lib/mtf";
import { maFigures, maLegendLabel, templateMaKind } from "../lib/indicators/ma";

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
    maType: string;
    envelope: boolean;
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
      maType: string;
      envelope: boolean;
    }> = {},
  ) {
    const length = next.length ?? state.maLength;
    const src = (next.source ?? state.source) as MaExtend["source"];
    const off = next.offset ?? state.offset;
    const st = next.smoothType ?? state.smoothType;
    const sl = next.smoothLen ?? state.smoothLen;
    const tf = next.timeframe ?? state.timeframe;
    const templateKind: MaKind = templateMaKind(type);
    const kind = normalizeMaKind(next.maType ?? state.maType, templateKind);
    const envelope = next.envelope ?? state.envelope;
    const options: MaExtend = {
      source: src,
      offset: off,
      smoothing: st === "none" ? undefined : { type: st as "sma" | "ema", length: sl },
      maType: kind,
      envelope,
    };
    // A never-flipped instance keeps its template label ("MA", not "SMA"):
    // the kind label only appears when the chosen kind differs from the
    // template's own kind.
    const label = maLegendLabel(kind, templateKind);
    // The MTF path carries the base line only (computeMa never emits bandHi/
    // bandLo there), so band figures must stay title-less on a higher
    // timeframe or the DOM legend shows two permanent "n/a" rows.
    const figures = maFigures(label, envelope && tf === "chart");
    // Legend follows the chosen kind: retitle the figures and the row name.
    // (klinecharts' override applies figures/shortName per instance.) Skipped
    // when nothing changed: a fresh figures array sets klinecharts' calc flag,
    // so an unconditional override would recompute the whole series twice per
    // Length/Source/Offset tweak.
    const live = getIndicator(chart, paneId, name) as {
      shortName?: string;
      figures?: Array<{ title?: string }>;
    } | null;
    const sameLabels =
      live?.shortName === label &&
      (live?.figures ?? []).length === figures.length &&
      figures.every((f, i) => live?.figures?.[i]?.title === f.title);
    if (!sameLabels) {
      chart.overrideIndicator({ paneId, name, shortName: label, figures });
    }
    void applyMaTimeframe(
      chart,
      epic,
      name,
      paneId,
      { kind, length, options },
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
  maType,
  setMaType,
  envelope,
  setEnvelope,
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
  maType: string;
  setMaType: (s: string) => void;
  envelope: boolean;
  setEnvelope: (b: boolean) => void;
  applyMa: (next: Partial<{
    length: number;
    source: string;
    offset: number;
    smoothType: string;
    smoothLen: number;
    timeframe: string;
    maType: string;
    envelope: boolean;
  }>) => void;
}) {
  return (
    <>
      <div className="ind-row">
        <label>Type</label>
        <select
          value={maType}
          onChange={(e) => {
            setMaType(e.target.value);
            applyMa({ maType: e.target.value });
          }}
        >
          <option value="ema">EMA</option>
          <option value="sma">SMA</option>
          <option value="vwma">VWMA</option>
          <option value="evwma">EVWMA</option>
        </select>
      </div>
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
      <span className="ind-row-head">
        <label className="ind-check">
          <input
            type="checkbox"
            checked={envelope}
            onChange={(e) => {
              setEnvelope(e.target.checked);
              applyMa({ envelope: e.target.checked });
            }}
          />
          <span>Envelope</span>
        </label>
        <InfoTip
          title="Envelope"
          text="Adds upper and lower bands: the same moving average taken over each bar's high and low."
        />
      </span>

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
  type: string,
  source: string,
  offset: number,
  smoothType: string,
  smoothLen: number,
  timeframe: string,
  maType: string,
  envelope: boolean,
) {
  extendData.source = source;
  extendData.offset = offset;
  if (smoothType !== "none") extendData.smoothing = { type: smoothType, length: smoothLen };
  if (timeframe !== "chart") extendData.mtf = { timeframe };
  // Persist maType only when actually flipped. Writing the template's own kind
  // would mutate every instance whose settings were merely OPENED (the persist
  // effect fires on mount) and split its operands' recipe hashes from ones
  // picked before the modal existed. Delete covers a stale default inherited
  // from the live extendData.
  const tk = templateMaKind(type);
  const kind = normalizeMaKind(maType, tk);
  if (kind !== tk) extendData.maType = kind;
  else delete extendData.maType;
  if (envelope) extendData.envelope = true;
  else delete extendData.envelope;
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
    const live = getIndicator(chart, paneId, name) as import("klinecharts").Indicator | null;
    const ext: AvwapExtend = {
      ...((live?.extendData as AvwapExtend) ?? {}),
      source: (next.source ?? state.avwapSource) as AvwapExtend["source"],
      bandMode: next.bandMode ?? state.bandMode,
      bands: next.bands ?? state.bands,
      ...(next.lineHidden ? { lineHidden: next.lineHidden } : {}),
    };
    chart.overrideIndicator({ paneId, name, extendData: ext });
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
