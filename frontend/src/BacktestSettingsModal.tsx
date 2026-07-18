// Backtest strategy builder: time range + history depth, entry/exit rule
// groups, costs, and named presets. Matches the app's other modals exactly
// (useDraggable/useCloseOnEscape/CloseButton, .modal-backdrop/.modal/.modal-head/
// .modal-foot) — no shared wrapper, no portal.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import CloseButton from "./CloseButton";
import ChartOperandPicker from "./ChartOperandPicker";
import InfoTip from "./components/InfoTip";
import NumberField from "./components/NumberField";
import RunBar, { ModeSeg } from "./components/RunBar";
import Tooltip from "./components/Tooltip";
import { msToLocalInput, localInputToMs } from "./lib/alertUi";
import {
  requestGoLive,
  requestConfirm,
  backtestClearRequest,
  backtestRunningSignal,
  backtestDurationSignal,
  sweepDurationSignal,
  backtestMessagesSignal,
  sweepAxesSignal,
  holdoutEvalSignal,
  sweepStateSignal,
  requestSweepCancel,
  sweepTargetSignal,
  saveSweepTarget,
  sweepCombosOverrideSignal,
  sweepArchivedSignal,
} from "./lib/signals";
import { resumeSweep } from "./lib/sweepResume";
import { enumerateChartOperands } from "./lib/chartOperandEnumerate";
import type { EmphasisTarget } from "./lib/chartOperand";
import { resolveWindow } from "./lib/backtestWindow";
import { TIMEZONES, offsetLabel } from "./lib/timezones";
import { RESOLUTION_SECONDS, PERIOD_GROUPS } from "./lib/feed";
import {
  longestIndicatorLength,
  type BacktestConfig,
  type RangeConfig,
  type RangeMode,
  type HistoryDepth,
  type RuleGroup,
  type Rule,
  type Operand,
  type IndicatorKind,
  type PriceField,
  type Operator,
  type Combine,
  type Costs,
  type SlippageModel,
  cloneRule,
  slopeLen,
  type RiskConfig,
  type StopKind,
  type TargetKind,
  type ScalingConfig,
  type RecurrenceMask,
  type SessionPreset,
  type DayTimeWindow,
  swapSides,
  ruleFromChartOperand,
  OP_REVERSE,
} from "./lib/backtestConfig";
import { SESSION_PRESETS, buildRangeChips, coverage, formatDayWindow, isActive, minToTime, resolveMask, sessionWindowInTz } from "./lib/backtestSchedule";
import type { ChartController } from "./lib/chartController";
import BacktestPanel from "./BacktestPanel";
import StrategyPicker from "./StrategyPicker";
import { RangeChip, SweepBaseValue } from "./components/RangeChip";
import { StrategyParams } from "./components/StrategyParams";
import { SweepResults } from "./SweepResults";
import { comboCount, materializePeriodAxes, mirrorRiskAxes, opAxisTarget, ruleAxisTarget, SWEEP_WARN_COMBOS, type RangeAxis, type SweepAxis, type SweepCombo, type SweepOption } from "./lib/sweep";
import { refineAxesAround, sampleCombos } from "./lib/sweepSearch";
import { useStableCallback } from "./lib/useStableCallback";
import { sweepAxisLabel, withSweepLabels, type LabelConfig } from "./lib/sweepLabels";
import {
  sweepContext, recallSweepRange, recordSweepRanges,
  loadSweepAxes, saveSweepAxes, pruneSweepAxes,
} from "./lib/sweepMemory";
import { loadHoldout, saveHoldoutPct, recordPeek, splitHoldout } from "./lib/holdout";
import { applyRiskSync, riskPatch, riskSyncOn } from "./lib/riskSync";
import { formatPeriodRange } from "./lib/backtestPeriods";
import { fmtRunDuration } from "./lib/duration";
import { fetchStrategies, computeStatus, listSweepArchives, getSweepArchive, deleteSweepArchive, getCostProfile, putCostProfile, refetchCostProfile, type StrategyInfo, type ParamSpec, type SweepArchiveSummary, type CostProfile } from "./api";
import {
  loadCodedCfg,
  saveCodedCfg,
  defaultCodedCfg,
  resolveParamValues,
  type CodedStrategyConfig,
} from "./lib/codedConfig";
import {
  loadBacktestPresets,
  saveBacktestPreset,
  deleteBacktestPreset,
  saveBacktestLastUsed,
  loadBacktestSide,
  saveBacktestSide,
  loadBacktestSplit,
  saveBacktestSplit,
  loadBacktestPanelWidth,
  saveBacktestPanelWidth,
  BACKTEST_PANEL_DEFAULT_WIDTH,
  loadBacktestMode,
  saveBacktestMode,
  type BacktestRunMode,
  loadSweepResultId,
  saveSweepResultId,
  clearSweepResultId,
  loadBacktestResultsSideBySide,
  saveBacktestResultsSideBySide,
  loadBacktestResultsColWidth,
  saveBacktestResultsColWidth,
  BACKTEST_RESULTS_COL_DEFAULT_WIDTH,
} from "./lib/persist";

interface Props {
  initial: BacktestConfig;
  epic: string;
  // The active broker id, so the Costs tab can prefill/refetch the instrument
  // cost profile (spread, slippage, financing) from that broker.
  brokerId: string;
  resolution: string;
  // The focused chart cell, so "Pick Range" can arm a drag-select on it. Null when
  // no cell is focused — the button is then disabled.
  controller: ChartController | null;
  // The chart's display timezone (already resolved to a concrete IANA zone —
  // never ""). The schedule mask, calendar chips and clock filters are all
  // evaluated in this one zone: there is no separate backtest timezone. To gate
  // on a market's real hours, set the chart to that market's zone.
  chartTimezone: string;
  onRun: (cfg: BacktestConfig) => void;
  onClose: () => void;
}

const RANGE_MODES: { value: RangeMode; label: string }[] = [
  { value: "bars", label: "Bars" },
  { value: "lastDay", label: "Day" },
  { value: "lastWeek", label: "Week" },
  { value: "lastMonth", label: "Month" },
  { value: "lastYear", label: "Year" },
  { value: "custom", label: "Custom" },
];

type BacktestTab = "period" | "strategy" | "costs" | "presets";
const BACKTEST_TABS: { value: BacktestTab; label: string }[] = [
  { value: "period", label: "Period" },
  { value: "strategy", label: "Strategy" },
  { value: "costs", label: "Costs" },
  { value: "presets", label: "Presets" },
];

// Which suggestion-chip unit each range tab shows (Bars/Custom show none).
const CHIP_UNIT: Partial<Record<RangeMode, "day" | "week" | "month" | "year">> = {
  lastDay: "day",
  lastWeek: "week",
  lastMonth: "month",
  lastYear: "year",
};

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// The schedule mask is always evaluated in the chart's display timezone. Stamp
// it onto the mask right before a run so the backend gate and the frontend
// preview agree, regardless of whatever tz an older saved config carried.
// Friendly label for a resolved IANA zone, e.g. "Tokyo (UTC+09:00)". Falls back
// to the raw id when it's not in the curated list (an arbitrary browser zone).
function tzDisplay(tz: string): string {
  const city = TIMEZONES.find((t) => t.value === tz)?.label ?? tz;
  const off = offsetLabel(tz);
  return off ? `${city} ${off}` : city;
}

function withChartTz(cfg: BacktestConfig, tz: string): BacktestConfig {
  const m = cfg.range.mask;
  if (!m) return cfg; // no mask, no gate — tz is irrelevant
  return { ...cfg, range: { ...cfg.range, mask: { ...m, tz } } };
}

function toggle(list: number[] | undefined, v: number): number[] {
  const s = new Set(list ?? []);
  if (s.has(v)) s.delete(v);
  else s.add(v);
  return [...s].sort((a, b) => a - b);
}
function timeToMin(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}
function withStart(w: DayTimeWindow | undefined, startMin: number): DayTimeWindow {
  return { startMin, endMin: w?.endMin ?? startMin };
}
function withEnd(w: DayTimeWindow | undefined, endMin: number): DayTimeWindow {
  return { startMin: w?.startMin ?? 0, endMin };
}

const HISTORY_DEPTHS: { value: HistoryDepth; label: string }[] = [
  { value: "full", label: "Full" },
  { value: "bars", label: "N bars" },
  { value: "minimal", label: "Auto-shortest" },
];

const INDICATORS: IndicatorKind[] = ["EMA", "SMA", "AVWAP", "RSI", "VOL", "VOLMA"];
const NO_LENGTH: IndicatorKind[] = ["AVWAP", "VOL"];
const PRICE_FIELDS: PriceField[] = ["close", "open", "high", "low"];
const STOP_KINDS: { value: StopKind; label: string }[] = [
  { value: "none", label: "None" },
  { value: "pct", label: "% from entry" },
  { value: "atr", label: "ATR ×" },
  { value: "trailPct", label: "Trailing %" },
  { value: "trailAtr", label: "Trailing ATR ×" },
  { value: "price", label: "Fixed price" },
];
const TARGET_KINDS: { value: TargetKind; label: string }[] = [
  { value: "none", label: "None" },
  { value: "pct", label: "% from entry" },
  { value: "atr", label: "ATR ×" },
  { value: "price", label: "Fixed price" },
];

export const EMPTY_RISK: RiskConfig = { stop: { kind: "none" }, target: { kind: "none" } };
const DEFAULT_SCALING: ScalingConfig = { maxConcurrent: 1 };
// `tip` is a one-line tooltip. Crosses fire ONCE on the bar the lines meet (an
// event); the comparisons are true on EVERY bar the condition holds (a state).
const OPERATORS: { value: Operator; label: string; tip: string }[] = [
  { value: "crossesAbove", label: "crosses above", tip: "Fires once, on the bar the left rises through the right." },
  { value: "crossesBelow", label: "crosses below", tip: "Fires once, on the bar the left drops through the right." },
  { value: "crosses", label: "crosses", tip: "Fires once, on the bar the left crosses the right either way." },
  { value: "gt", label: "greater than", tip: "True on every bar the left is above the right." },
  { value: "lt", label: "less than", tip: "True on every bar the left is below the right." },
  { value: "gte", label: "greater or equal", tip: "True on every bar the left is at or above the right." },
  { value: "lte", label: "less or equal", tip: "True on every bar the left is at or below the right." },
];

// Compact operator text for sweep-results cells (op-axis option labels).
const OP_CELL: Partial<Record<Operator, string>> = { gt: ">", lt: "<", gte: "≥", lte: "≤" };

// The compact glyph shown in the operator button (the row must fit on one line):
// a crossing-lines icon for the two "crosses" operators, a math symbol for the
// plain comparisons. The full wording stays in the dropdown.
function CrossGlyph({ dir }: { dir: "up" | "down" | "both" }) {
  if (dir === "both") {
    // Either-direction cross: an X over the reference line, no arrowhead.
    return (
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" className="bt-op-crossicon">
        <path d="M1 8 H15" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity="0.5" />
        <path d="M2 3 L14 13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M2 13 L14 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" className="bt-op-crossicon">
      {/* the reference line, and the series crossing through it up or down */}
      <path d="M1 8 H15" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity="0.5" />
      <path
        d={dir === "up" ? "M2 13 L14 3" : "M2 3 L14 13"}
        fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"
      />
      <path
        d={dir === "up" ? "M14 3 l-4 0 M14 3 l0 4" : "M14 13 l-4 0 M14 13 l0 -4"}
        fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

function OpGlyph({ op }: { op: Operator }) {
  if (op === "crossesAbove") return <CrossGlyph dir="up" />;
  if (op === "crossesBelow") return <CrossGlyph dir="down" />;
  if (op === "crosses") return <CrossGlyph dir="both" />;
  const g: Record<string, string> = { gt: ">", lt: "<", gte: "≥", lte: "≤" };
  return <span className="bt-op-glyph">{g[op]}</span>;
}

// A rough, illustrative bar count for the window timeline — not the exact fetch
// math BacktestButton uses (which also depends on "now" and the live broker's
// actual history limit), just enough to make the history-vs-window split
// tangible while the user is configuring it. Custom ranges without both dates
// set fall back to a nominal week.
const NOMINAL_WINDOW_BARS = 168;

// A number <input> happily keeps a leading zero the model can't represent —
// "0200", or the "0" left behind after you clear the field (Number("") is 0) and
// type your number after it, giving "0200". React won't re-render that away on
// its own when the parsed value is unchanged, so strip it off the raw string in
// place. Returns the cleaned string (may be "" — callers coerce with Number()).
function cleanNumInput(el: HTMLInputElement): string {
  const cleaned = el.value.replace(/^(-?)0+(?=\d)/, "$1");
  if (cleaned !== el.value) el.value = cleaned;
  return cleaned;
}

// Count/length/magnitude fields must stay positive (an EMA of 0 or -5 bars is
// meaningless). Block the keystrokes that would enter a negative or exponent so
// one can't be typed at all...
function blockNegKeys(e: ReactKeyboardEvent<HTMLInputElement>) {
  if (e.key === "-" || e.key === "+" || e.key === "e" || e.key === "E") e.preventDefault();
}
// ...and on blur snap a value that came out ≤ 0 (or was left empty mid-edit) up
// to the field's floor, so leaving the field can't commit a non-positive number.
// `commit` is 0-arg because the caller already knows the clamped value to write.
function clampPosOnBlur(el: HTMLInputElement, floor: number, commit: (n: number) => void) {
  if (!(Number(el.value) > 0)) commit(floor);
}

// The actual calendar span implied by the current range choice, so "Month" etc.
// aren't left abstract — shown relative to now for the fixed presets ("Bars"
// depends on the resolution too, since a bar count only maps to a duration once
// you know the timeframe).
function rangeDateLabel(cfg: BacktestConfig, resSeconds: number): string {
  const r = cfg.range;
  if (r.mode === "custom" && !(r.fromMs && r.toMs && r.toMs > r.fromMs)) {
    return "Pick a from and to date";
  }
  // resolveWindow already applies a chip's absolute fromMs/toMs anchor.
  const { fromMs, toMs } = resolveWindow(cfg, resSeconds, Date.now());
  return formatPeriodRange(fromMs, toMs);
}

function estimateWindowBars(cfg: BacktestConfig, resSeconds: number): number {
  const r = cfg.range;
  if (r.mode === "bars") return r.bars ?? 500;
  if (r.mode === "custom" && !(r.fromMs && r.toMs && r.toMs > r.fromMs)) {
    return NOMINAL_WINDOW_BARS;
  }
  const { fromMs, toMs } = resolveWindow(cfg, resSeconds, Date.now());
  return Math.max(1, Math.round((toMs - fromMs) / 1000 / resSeconds));
}

/** The history-vs-trading-window split, illustrated to scale — this is the one
 * idea (D6, in the design notes) that's hardest to explain in words: the range
 * picker only decides where TRADES happen, while indicators warm up over
 * however much history is loaded before it. "Full" depth has no known size
 * (it's whatever the broker will actually serve), so it's drawn as an
 * open-ended fade rather than a fabricated number. */
function WindowTimeline({ cfg, resolution }: { cfg: BacktestConfig; resolution: string }) {
  const resSeconds = RESOLUTION_SECONDS[resolution] ?? 60;
  const windowBars = estimateWindowBars(cfg, resSeconds);
  const depth = cfg.range.history ?? "minimal";
  const historyBars =
    depth === "bars" ? cfg.range.historyBars ?? 500 : depth === "minimal" ? longestIndicatorLength(cfg) : null;

  const historyShare = historyBars === null ? 0.62 : historyBars / (historyBars + windowBars);
  const windowShare = 1 - historyShare;

  return (
    <div className="bt-timeline" aria-hidden="true">
      <div className="bt-timeline-track">
        <div
          className={`bt-timeline-history${historyBars === null ? " open-ended" : ""}`}
          style={{ flexGrow: historyShare }}
        />
        <div className="bt-timeline-marker" title="Trades can only open from here on" />
        <div className="bt-timeline-window" style={{ flexGrow: windowShare }} />
      </div>
      <div className="bt-timeline-labels">
        <span>{historyBars === null ? "as much history as the broker has" : `${historyBars.toLocaleString()} bars warm-up`}</span>
        <span className="bt-timeline-window-label">{windowBars.toLocaleString()} bars traded</span>
      </div>
    </div>
  );
}

function defaultOperand(): Operand {
  return { kind: "indicator", indicator: "EMA", length: 9 };
}

function defaultRule(): Rule {
  return { left: defaultOperand(), op: "gt", right: { kind: "const", value: 0 } };
}

// Session-lived cache of fetched instrument cost profiles, keyed by epic, so the
// Costs tab fetches a profile once per epic per session (re-opening the modal for
// the same epic reuses it). Exported reset is for tests.
const costProfileCache = new Map<string, CostProfile>();
export function resetCostProfileCache(): void {
  costProfileCache.clear();
}

// The instrument-cost fields a CostProfile carries into a Costs object. Quantity,
// commission and starting cash are panel-only and never ride the profile.
function profileToCostsPatch(p: CostProfile): Partial<Costs> {
  return {
    spread: p.spread,
    slippage: p.slippage,
    finLongDailyPct: p.finLongDailyPct,
    finShortDailyPct: p.finShortDailyPct,
  };
}


export default function BacktestSettingsModal({ initial, epic, brokerId, resolution, controller, chartTimezone, onRun, onClose }: Props) {
  // "Copy immediately" half of the SL/TP sync: a config arriving with sync on
  // but the sides drifted apart (saved before the option existed, or edited
  // while off) is normalized on load, the side being viewed winning.
  const [cfg, setCfg] = useState<BacktestConfig>(() => applyRiskSync(initial, loadBacktestSide()));
  // True while "Pick Range" is armed on the chart (mirrors the controller signal),
  // so the button reflects the active state.
  const [pickingRange, setPickingRange] = useState(false);
  const [presets, setPresets] = useState(() => loadBacktestPresets());
  const [presetName, setPresetName] = useState("");
  const [loadName, setLoadName] = useState("");
  // The instrument cost profile behind the Costs tab: source note + refetch. Seeded
  // from the session cache so re-opening for the same epic shows the note without a
  // refetch. null until the first fetch resolves (or when it fails).
  const [costProfile, setCostProfile] = useState<CostProfile | null>(() => costProfileCache.get(epic) ?? null);
  // Restore the last-viewed tab (device-local) and persist it on switch, so
  // re-opening the modal returns to the side you were working on.
  const [side, setSide] = useState<"long" | "short">(loadBacktestSide);
  const [tab, setTab] = useState<BacktestTab>("period");
  // Backtest vs Sweep mode. The mode gates what Run does and which results the
  // bottom region shows — NOT whether results exist: both result sets stay
  // populated, so flipping the switch flips the view with nothing cleared.
  // Device-local, restored on open; a sweep still running when the modal opens
  // (re-attach below) forces "sweep" so its progress is immediately visible.
  const [btMode, setBtMode] = useState<BacktestRunMode>(() =>
    sweepStateSignal.value ? "sweep" : loadBacktestMode(),
  );
  const selectMode = (m: BacktestRunMode) => {
    setBtMode(m);
    saveBacktestMode(m);
  };
  // Auto-persist the config on every edit, so changes like deleting a rule stick
  // even if the modal is closed without running. Previously the last-used config
  // was saved ONLY on Run, so an edit made and then abandoned reappeared on the
  // next reload (loadBacktestLastUsed returned the stale saved copy). The backend
  // mirror (save() → PUT) is un-debounced, so we coalesce edits with a short timer
  // rather than firing a request per keystroke. `initial` already came from
  // loadBacktestLastUsed(), so skip the mount pass to avoid a redundant re-mirror.
  const firstCfgSave = useRef(true);
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  useEffect(() => {
    if (firstCfgSave.current) {
      firstCfgSave.current = false;
      // The copy-on-load risk-sync normalization (applyRiskSync above, which
      // returns `initial` unchanged when it's a no-op) must reach storage right
      // away: the run payload is rebuilt from loadBacktestLastUsed(), so a
      // drifted stored side would run a stop the panel no longer displays.
      if (cfg !== initial) saveBacktestLastUsed(cfg);
      return;
    }
    const t = setTimeout(() => saveBacktestLastUsed(cfg), 400);
    return () => clearTimeout(t);
  }, [cfg]);
  // Flush the latest config when the modal unmounts, so an edit made inside the
  // debounce window right before closing isn't dropped by the timer cleanup above.
  useEffect(() => () => saveBacktestLastUsed(cfgRef.current), []);
  // "Pick Range" ↔ chart wiring: mirror the armed flag for the button state, and
  // when the chart publishes a picked range drop it into the Custom from/to (and
  // switch to Custom mode). Re-subscribes if the focused cell changes.
  useEffect(() => {
    if (!controller) {
      setPickingRange(false);
      return;
    }
    setPickingRange(controller.rangePickArmed.value);
    const unsubArmed = controller.rangePickArmed.subscribe(setPickingRange);
    const unsubResult = controller.rangePickResult.subscribe((res) => {
      if (!res) return;
      setCfg((c) => ({ ...c, range: { ...c.range, mode: "custom", fromMs: res.fromMs, toMs: res.toMs } }));
      controller.rangePickResult.set(null); // consume one-shot
    });
    return () => {
      unsubArmed();
      unsubResult();
      controller.rangePickArmed.set(false); // don't leave the chart armed if the panel closes mid-pick
    };
  }, [controller]);

  const selectSide = (s: "long" | "short") => {
    setSide(s);
    saveBacktestSide(s);
  };
  // Whether the side being edited is armed (opens/closes positions). Drives the
  // arm switch that sits beside the Long/Short tabs.
  const sideEnabled = (side === "long" ? cfg.longEnabled : cfg.shortEnabled) !== false;

  // Coded strategies (mode === "coded"): the discovered file list is fetched
  // HERE (not inside StrategyPicker) so this modal can also read the selected
  // file's `params` schema for the Parameters/Risk/Exit sections below the
  // picker — StrategyPicker just renders whatever list it's given.
  const [strategyList, setStrategyList] = useState<StrategyInfo[]>([]);
  const [strategyListError, setStrategyListError] = useState<string | null>(null);
  const reloadStrategies = () => {
    fetchStrategies()
      .then((list) => {
        setStrategyList(list);
        setStrategyListError(null);
      })
      .catch((e) => setStrategyListError(e instanceof Error ? e.message : "failed to load strategies"));
  };
  useEffect(() => void reloadStrategies(), []);
  const selectedStrategy = strategyList.find((s) => s.filename === cfg.codedStrategy);

  // The per-strategy-file panel config (params + risk + exit groups), loaded
  // from the "backtest" coded set whenever the selected file changes. Every
  // edit writes straight through to storage via updateCoded.
  // applyRiskSync: same copy-on-load normalization as `cfg` above; both side
  // blocks are visible at once here, so long wins.
  const [codedCfg, setCodedCfg] = useState<CodedStrategyConfig>(() =>
    applyRiskSync(cfg.codedStrategy ? loadCodedCfg("backtest", cfg.codedStrategy) : defaultCodedCfg(), "long"),
  );
  useEffect(() => {
    const stored = cfg.codedStrategy ? loadCodedCfg("backtest", cfg.codedStrategy) : defaultCodedCfg();
    const nextCoded = applyRiskSync(stored, "long");
    setCodedCfg(nextCoded);
    // Write the normalization back: the run payload is rebuilt from storage
    // (BacktestButton's loadCodedCfg), not from this state — leaving the stored
    // copy drifted would show one stop kind while the run sends the other.
    // applyRiskSync returns the same reference when it changed nothing.
    if (cfg.codedStrategy && nextCoded !== stored) saveCodedCfg("backtest", cfg.codedStrategy, nextCoded);
    // Coded axes are per-file: switching files swaps in that file's saved set.
    if (cfg.mode === "coded") {
      setSweepAxes(pruneSweepAxes(loadSweepAxes(sweepContext("coded", cfg.codedStrategy)), nextCoded));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.codedStrategy]);
  const updateCoded = (c: CodedStrategyConfig) => {
    setCodedCfg(c);
    if (cfg.codedStrategy) saveCodedCfg("backtest", cfg.codedStrategy, c);
  };
  // Sweep axes: persisted per context (rules / coded file) so the setup
  // survives close, apply, reload, and mode switches. Restored axes are pruned
  // against the current config so a deleted rule cannot leave a phantom axis.
  // labelCfg() is declared below (TDZ), so the initializer inlines the ternary.
  // Any number of axes; SWEEP_WARN_COMBOS is only a soft warning on run size
  // (the footer count highlights it). Written to sweepAxesSignal right before a run so
  // BacktestButton can branch on it.
  const [sweepAxes, setSweepAxes] = useState<SweepAxis[]>(() =>
    pruneSweepAxes(
      loadSweepAxes(sweepContext(cfg.mode, cfg.codedStrategy)),
      cfg.mode === "coded" ? codedCfg : cfg,
    ),
  );
  // The axes that actually ran, materialized (period → concrete windows) at run
  // time — SweepResults labels against these, not the still-editable sweepAxes.
  const [ranAxes, setRanAxes] = useState<SweepAxis[]>([]);
  // Past sweeps archived server-side for this epic, for the reopen picker.
  const [pastSweeps, setPastSweeps] = useState<SweepArchiveSummary[]>([]);
  const [pickedSweep, setPickedSweep] = useState("");
  // The reopen picker stays a SHARED per-epic library (a past-sweeps history any
  // cell can pull from). It no longer auto-reopens the newest sweep — which
  // result is SHOWN is now bound per tab+cell via the sweep pointer (see the
  // restore effect below), so two cells on the same epic don't inherit each
  // other's sweep.
  const refreshPastSweeps = () => {
    listSweepArchives(epic)
      .then(setPastSweeps)
      .catch((e) => console.warn("list sweeps failed", e));
  };
  // Reopen an archived sweep: load its ran-axes into the results-axes state and
  // its rows into the sweep results state, with progress cleared so apply works.
  // No-op while a sweep is running: reopening would stomp the live run's axes and
  // rows (wrong ranAxes for streaming rows, defeating applySweepCombo's running
  // guard). The picker controls are disabled while running too; this is the
  // belt-and-braces guard.
  const reopenSweep = (id: string, bind = false) => {
    if (sweepStateSignal.value?.running) return;
    getSweepArchive(id)
      .then((a) => {
        setRanAxes(a.axes);
        sweepStateSignal.set({
          rows: a.rows, done: a.rows.length, total: a.rows.length, running: false,
        });
        // A user reopen (bind) makes this archive THIS cell's bound result, so it
        // restores here — not the previous one — on the next switch/reload. The
        // silent restore path (bind=false) must NOT rewrite the pointer.
        if (bind && controller) saveSweepResultId(controller.scope, epic, id);
      })
      .catch((e) => console.warn("reopen sweep failed", e));
  };
  const removePastSweep = (id: string) => {
    deleteSweepArchive(id)
      .then(() => {
        setPickedSweep("");
        // If this cell was bound to the deleted sweep, drop the dangling pointer.
        if (controller && loadSweepResultId(controller.scope, epic) === id) {
          clearSweepResultId(controller.scope, epic);
        }
        refreshPastSweeps();
      })
      .catch((e) => console.warn("delete sweep failed", e));
  };
  // Drop the on-screen sweep results (the footer "Clear results" action). Resets
  // the picker so the same archive can be reopened right after.
  const clearSweepResults = () => {
    sweepStateSignal.set(null);
    setRanAxes([]);
    setPickedSweep("");
    // Explicit clear also unbinds this cell — nothing to restore on next switch.
    if (controller) clearSweepResultId(controller.scope, epic);
  };
  // Search strategy for a sweep: "grid" enumerates every combo; "random" draws
  // N combos uniformly from the same ranges (seed fixed at 1 for reproducibility).
  // Session-only UI preference — plain state, not persisted.
  const [searchMode, setSearchMode] = useState<"grid" | "random">("grid");
  const [randomN, setRandomN] = useState(200);
  // Appends the toggled-on axis (shared by every sweep toggle).
  const addAxis = (axes: SweepAxis[], next: SweepAxis) => [...axes, next];
  // The storage context sweep memory/axes are keyed by: "rules", or the coded
  // strategy file, so param:n on two different .py files never collide.
  const sweepCtx = () => sweepContext(cfg.mode, cfg.codedStrategy);
  // Holdout ("lockbox"): the reserved-tail config for the current strategy
  // context. Keyed identically to sweep memory (rules / coded file), so the
  // reservation follows the strategy, not the panel. Reloaded on context change.
  const [holdout, setHoldout] = useState<{ pct: number; peeks: number } | null>(
    () => loadHoldout(sweepContext(cfg.mode, cfg.codedStrategy)),
  );
  useEffect(() => {
    setHoldout(loadHoldout(sweepContext(cfg.mode, cfg.codedStrategy)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.mode, cfg.codedStrategy]);
  const changeHoldoutPct = (pct: number | null) => {
    const key = sweepCtx();
    saveHoldoutPct(key, pct);
    setHoldout(loadHoldout(key));
  };
  // In Backtest mode every sweep control is inert: the glyphs render dimmed
  // (CSS off the bt-mode-backtest root class) and the toggles below no-op, so
  // the configured axes can't change invisibly while their editors are hidden.
  const sweepEditable = btMode === "sweep";
  // What the config sections render against: in Backtest mode the axes read as
  // absent, so swept fields show their plain inputs again (the value a single
  // run actually uses) and the inline from/to/step editors hide. The real
  // sweepAxes survive untouched for the next flip back to Sweep mode.
  const displayAxes = sweepEditable ? sweepAxes : [];
  const toggleSweepAxis = (target: string, spec: ParamSpec) => {
    if (!sweepEditable) return;
    setSweepAxes((axes) => {
      if (axes.some((a) => a.target === target)) return axes.filter((a) => a.target !== target);
      const mem = recallSweepRange(sweepCtx(), target);
      const next: SweepAxis = {
        kind: "range",
        target,
        label: spec.label,
        from: mem?.from ?? spec.min ?? (spec.default as number),
        to: mem?.to ?? spec.max ?? (spec.default as number) * 2,
        step: mem?.step ?? spec.step ?? 1,
      };
      return addAxis(axes, next);
    });
  };
  // The config a rule/risk axis label resolves against: rules mode reads the
  // rule config, coded mode reads the per-file coded config (exit rules + risk).
  const labelCfg = (): LabelConfig => (cfg.mode === "coded" ? codedCfg : cfg);
  // Shared inline-editor patch: RangeChip edits flow back through here.
  const patchAxis = (target: string, patch: Partial<Pick<RangeAxis, "from" | "to" | "step">>) =>
    setSweepAxes((axes) => axes.map((a) => (a.target === target && a.kind === "range" ? { ...a, ...patch } : a)));
  // Write-through: every axes change lands in the current context's key. Deps
  // are [sweepAxes] ON PURPOSE: on a mode/file switch the axes swap in the
  // same update (or a later effect) as cfg, so this never writes one
  // context's axes under another context's key.
  useEffect(() => {
    saveSweepAxes(sweepCtx(), sweepAxes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sweepAxes]);
  // param: axes can only be validated once the strategy schema loads; drop any
  // axis naming a param the selected file no longer declares. Keyed on cfg.mode
  // too so entering coded mode (mode-switch restore passes all param: axes
  // through) re-runs the prune, not just a strategy-file change.
  useEffect(() => {
    if (cfg.mode !== "coded" || !selectedStrategy) return;
    const names = new Set(selectedStrategy.params.map((p) => p.name));
    setSweepAxes((axes) => {
      const kept = axes.filter(
        (a) => !a.target.startsWith("param:") || names.has(a.target.slice("param:".length)),
      );
      return kept.length === axes.length ? axes : kept;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStrategy, cfg.mode]);
  // Risk numeric fields have no declared min/max/step — pick sensible defaults
  // from the field's current value (from = current, to = 2x, step = a coarse
  // fraction so a first sweep is immediately useful without hand-tuning).
  const toggleRiskSweepAxis = (target: string, current: number) => {
    if (!sweepEditable) return;
    setSweepAxes((axes) => {
      if (axes.some((a) => a.target === target)) return axes.filter((a) => a.target !== target);
      const base = current || 1;
      const mem = recallSweepRange(sweepCtx(), target);
      const next: SweepAxis = {
        kind: "range",
        target,
        label: sweepAxisLabel(target, labelCfg()) ?? target.split(".").slice(1).join(" "),
        from: mem?.from ?? base,
        to: mem?.to ?? base * 2,
        step: mem?.step ?? Math.max(base / 10, 0.1),
      };
      return addAxis(axes, next);
    });
  };
  // Rule-operand numeric fields (indicator length, const value, exit count) —
  // same heuristic as toggleRiskSweepAxis (no declared min/max/step to draw
  // from), keyed on the `rule:` path built by ruleAxisTarget at the call site.
  const toggleRuleSweepAxis = (target: string, current: number) => {
    if (!sweepEditable) return;
    setSweepAxes((axes) => {
      if (axes.some((a) => a.target === target)) return axes.filter((a) => a.target !== target);
      const base = current || 1;
      const mem = recallSweepRange(sweepCtx(), target);
      const next: SweepAxis = {
        kind: "range",
        target,
        label: sweepAxisLabel(target, labelCfg()) ?? target.replace(/^rule:/, ""),
        from: mem?.from ?? base,
        to: mem?.to ?? base * 2,
        step: mem?.step ?? Math.max(base / 10, 1),
      };
      return addAxis(axes, next);
    });
  };
  // Results cells read this label; symbols keep the axis columns narrow. The
  // crosses operators have no symbol and stay as words.
  const opOption = (target: string, op: Operator): SweepOption => ({
    label: OP_CELL[op] ?? OPERATORS.find((o) => o.value === op)?.label ?? op,
    patch: { [target]: op },
  });
  // Operator axis: a discrete list seeded with the rule's current operator.
  const toggleOpSweepAxis = (target: string, current: Operator) => {
    if (!sweepEditable) return;
    setSweepAxes((axes) =>
      axes.some((a) => a.target === target)
        ? axes.filter((a) => a.target !== target)
        : addAxis(axes, {
            kind: "list", target,
            label: sweepAxisLabel(target, labelCfg()) ?? `${target.replace(/^op:/, "").replace(/\./g, " ")} op`,
            options: [opOption(target, current)],
          }));
  };
  // Tick/untick one operator in the axis's option list; unticking the last
  // option removes the axis (nothing left to sweep). Options keep OPERATORS
  // order so results enumerate in dropdown order.
  const tickOpOption = (target: string, op: Operator) => {
    setSweepAxes((axes) =>
      axes
        .map((a) => {
          if (a.target !== target || a.kind !== "list") return a;
          const has = a.options.some((o) => o.patch[target] === op);
          const options = has
            ? a.options.filter((o) => o.patch[target] !== op)
            : OPERATORS.filter((o) =>
                o.value === op || a.options.some((x) => x.patch[target] === o.value),
              ).map((o) => opOption(target, o.value));
          return { ...a, options };
        })
        .filter((a) => !(a.target === target && a.kind === "list" && a.options.length === 0)));
  };
  const timeWindowAxis = displayAxes.find((a) => a.target === "timeWindow");
  const twOption = (startMin: number, endMin: number, tz: string, label?: string): SweepOption => ({
    label: label ?? `${minToTime(startMin)}-${minToTime(endMin)} ${tz}`,
    patch: { "timeWindow:startMin": startMin, "timeWindow:endMin": endMin, "timeWindow:tz": tz },
  });
  // Time-window axis: a discrete list of intraday windows, seeded with the
  // mask's current window when one is set.
  const toggleTimeWindowSweepAxis = () => {
    if (!sweepEditable) return;
    setSweepAxes((axes) => {
      if (axes.some((a) => a.target === "timeWindow")) return axes.filter((a) => a.target !== "timeWindow");
      const t = cfg.range.mask?.timeOfDay;
      const tz = chartTimezone;
      return addAxis(axes, {
        kind: "list", target: "timeWindow", label: "Window",
        options: t ? [twOption(t.startMin, t.endMin, tz)] : [],
      });
    });
  };
  const addTimeWindowOption = (o: SweepOption) =>
    setSweepAxes((axes) => axes.map((a) =>
      a.target === "timeWindow" && a.kind === "list" && !a.options.some((x) => x.label === o.label)
        ? { ...a, options: [...a.options, o] }
        : a));
  // A session preset fills its hours converted into the chart timezone (the
  // window is read there like every other clock filter, no per-preset tz).
  const addSessionWindowOption = (key: SessionPreset | "") => {
    if (!key) return;
    const p = SESSION_PRESETS[key];
    const w = sessionWindowInTz(p.window, p.tz, chartTimezone, Date.now());
    if (!w) return; // Crypto: 24h, no window to sweep
    addTimeWindowOption(twOption(w.startMin, w.endMin, chartTimezone, p.label));
  };
  // Removing the last option empties the axis; drop it entirely (mirrors the
  // operator path in tickOpOption) so an empty kind:"list" axis can't strand a
  // slot or make comboCount return Infinity.
  const removeTimeWindowOption = (i: number) =>
    setSweepAxes((axes) => axes
      .map((a) =>
        a.target === "timeWindow" && a.kind === "list"
          ? { ...a, options: a.options.filter((_, j) => j !== i) }
          : a)
      .filter((a) => !(a.target === "timeWindow" && a.kind === "list" && a.options.length === 0)));
  const periodAxis = displayAxes.find((a) => a.target === "period");
  // Period axis: walk-forward, the range split into n equal windows. Stored as
  // just n while editing; materialized into concrete windows at run time so it
  // always reflects the range as currently configured.
  const togglePeriodSweepAxis = () => {
    if (!sweepEditable) return;
    setSweepAxes((axes) =>
      axes.some((a) => a.target === "period")
        ? axes.filter((a) => a.target !== "period")
        : addAxis(axes, { kind: "period", target: "period", label: "Period", n: 4 }));
  };
  const setPeriodN = (n: number) =>
    setSweepAxes((axes) => axes.map((a) =>
      a.kind === "period" ? { ...a, n: Math.max(2, Math.min(50, Math.round(n) || 2)) } : a));
  const sweepCombos = comboCount(sweepAxes);
  // Random search submits at most `randomN` combos (sampleCombos dedupes, so it
  // never exceeds the grid), so the footer count/estimate/warn track the actual
  // sample size, not the full grid. Grid mode runs the whole grid.
  const effectiveCombos = searchMode === "random" ? Math.min(randomN, sweepCombos) : sweepCombos;
  const effectiveWarn = !isFinite(effectiveCombos) || effectiveCombos > SWEEP_WARN_COMBOS;
  const [sweepState, setSweepState] = useState(sweepStateSignal.value);
  useEffect(() => sweepStateSignal.subscribe(setSweepState), []);
  // Bumped whenever a sweep is archived server-side (live run or re-attach). Mirror
  // it into state so the past-sweeps fetch effect re-runs and a sweep that finishes
  // while the section is open shows up in the picker without a reopen.
  const [archivedTick, setArchivedTick] = useState(sweepArchivedSignal.value);
  useEffect(() => sweepArchivedSignal.subscribe(setArchivedTick), []);
  // Where the sweep runs (local vs remote). Mirror the signal into state so the
  // footer estimate + toggle re-render when the target changes; the runner reads
  // sweepTargetSignal.value at submit time regardless.
  const [sweepTarget, setSweepTarget] = useState(sweepTargetSignal.value);
  useEffect(() => sweepTargetSignal.subscribe(setSweepTarget), []);
  // Whether remote compute is configured server-side (fetched once on open). The
  // Compute toggle is hidden until this resolves true, so a plain single-backend
  // install never sees a control it can't use.
  const [remoteCompute, setRemoteCompute] = useState(false);
  useEffect(() => {
    let alive = true;
    void computeStatus().then((s) => { if (alive) setRemoteCompute(s.remoteConfigured); });
    return () => { alive = false; };
  }, []);
  // On open, re-attach to a sweep job that survived a reload (submitted then the
  // panel/tab closed: the server job keeps running). Only when no run already
  // owns the state, so we never double-publish into a live in-session sweep.
  useEffect(() => {
    if (sweepStateSignal.value === null)
      // A re-attached job flips the view to Sweep so the landed/streaming rows
      // are visible; setBtMode (not selectMode) so an automatic flip doesn't
      // overwrite the user's saved mode preference.
      void resumeSweep().then((attached) => {
        if (attached) setBtMode("sweep");
      });
  }, []);
  // Clear any leftover sweep run/axes when the modal unmounts/closes, so a
  // stale in-flight state (or un-applied axes) from a previous session can't
  // bleed into a fresh open. Detach (server=false) rather than cancel: this
  // aborts BacktestButton's local poll loop but leaves the server job running,
  // so a reload can re-attach to it. The abort also stops that loop re-publishing
  // the state this cleanup just tore down (a ghost sweep with no axes on reopen).
  useEffect(() => () => {
    requestSweepCancel(false);
    sweepStateSignal.set(null);
    sweepAxesSignal.set([]);
  }, []);

  // Rule mode's own combo-apply — patches the operand/count a `rule:` axis
  // targets back onto cfg's rule groups. Kept separate from the coded branch
  // below (different config shape: RuleGroup arrays on `cfg`, not `codedCfg`).
  function applyRuleSweepCombo(combo: Record<string, number | boolean | string>) {
    if (sweepStateSignal.value?.running) return;
    let next = cfg;
    // timeWindow combo: patch the applied window onto the mask.
    const twS = combo["timeWindow:startMin"];
    const twE = combo["timeWindow:endMin"];
    if (typeof twS === "number" && typeof twE === "number") {
      const tz = typeof combo["timeWindow:tz"] === "string" ? combo["timeWindow:tz"] : chartTimezone;
      next = {
        ...next,
        range: {
          ...next.range,
          mask: {
            ...(next.range.mask ?? { enabled: true }),
            enabled: true,
            timeOfDay: { startMin: twS, endMin: twE },
            tz,
            session: undefined,
          },
        },
      };
    }
    // period combo: apply the window as a custom range.
    const pFrom = combo["period:from"];
    const pTo = combo["period:to"];
    if (typeof pFrom === "number" && typeof pTo === "number") {
      next = { ...next, range: { ...next.range, mode: "custom", fromMs: pFrom * 1000, toMs: pTo * 1000 } };
    }
    for (const [key, value] of Object.entries(combo)) {
      // op:<side>.<entry|exit>.<idx> carries a string operator.
      if (key.startsWith("op:") && typeof value === "string") {
        const [oside, ogroup, oidxStr] = key.slice("op:".length).split(".");
        const groupKey = `${oside}${ogroup === "entry" ? "Entry" : "Exit"}` as
          "longEntry" | "longExit" | "shortEntry" | "shortExit";
        const ruleGroup = next[groupKey];
        const idx = rawRuleIndex(ruleGroup.rules, Number(oidxStr));
        const rule = ruleGroup.rules[idx];
        if (!rule) continue;
        const rules = ruleGroup.rules.slice();
        rules[idx] = { ...rule, op: value as Operator };
        next = { ...next, [groupKey]: { ...ruleGroup, rules } };
        continue;
      }
      if (typeof value !== "number") continue;
      // SL/TP axes patch the per-side risk DTO, same shape as the coded branch.
      // risk:<side>.<stop|target>.<value|mult>
      if (key.startsWith("risk:")) {
        const [, rside, field, prop] = key.split(/[:.]/);
        const riskKey = rside === "long" ? "longRisk" : "shortRisk";
        const risk = next[riskKey] ?? EMPTY_RISK;
        next = {
          ...next,
          [riskKey]: { ...risk, [field]: { ...risk[field as "stop" | "target"], [prop]: value } },
        };
        continue;
      }
      if (!key.startsWith("rule:")) continue;
      // rule:<side>.<entry|exit>.<idx>.<left|right>.<length|value>
      // rule:<side>.<entry|exit>.<idx>.count
      const parts = key.slice("rule:".length).split(".");
      const [side, group, idxStr, ...rest] = parts;
      const groupKey = `${side}${group === "entry" ? "Entry" : "Exit"}` as
        "longEntry" | "longExit" | "shortEntry" | "shortExit";
      const ruleGroup = next[groupKey];
      const idx = rawRuleIndex(ruleGroup.rules, Number(idxStr));
      const rule = ruleGroup.rules[idx];
      if (!rule) continue;
      let patched: Rule;
      if (rest[0] === "count") {
        patched = { ...rule, count: value };
      } else {
        const [operandSide, leaf] = rest as ["left" | "right", "length" | "value"];
        const operand = rule[operandSide];
        if (operand.kind === "indicator" && leaf === "length") {
          patched = { ...rule, [operandSide]: { ...operand, length: value } };
        } else if (operand.kind === "const" && leaf === "value") {
          patched = { ...rule, [operandSide]: { ...operand, value } };
        } else {
          continue;   // stale axis (operand kind changed since the axis was created)
        }
      }
      const rules = ruleGroup.rules.slice();
      rules[idx] = patched;
      next = { ...next, [groupKey]: { ...ruleGroup, rules } };
    }
    // Synced risk axes are canonicalized to long; copy the applied values across
    // to short (no-op when unsynced or already equal).
    next = applyRiskSync(next, "long");
    setCfg(next);
    // Clear the published axes so the follow-up run is a plain backtest, and
    // flip to Backtest mode so its result is what lands on screen. The sweep
    // table survives untouched one flip away: sweepStateSignal is kept so
    // other rows can still be inspected and applied.
    sweepAxesSignal.set([]);
    selectMode("backtest");
    run(next);
  }

  function applySweepCombo(combo: Record<string, number | boolean | string>) {
    if (cfg.mode !== "coded") return applyRuleSweepCombo(combo);
    if (!cfg.codedStrategy) return;
    // I2: a streaming sweep's run() no-ops while a run is already in flight
    // (BacktestButton guards on `running`), so applying mid-sweep would clear
    // the axes/state and silently fail to re-run, stranding the panel showing
    // stale results. Rows are visually disabled while running (SweepResults);
    // this is the belt-and-braces guard against a stale click still landing.
    if (sweepStateSignal.value?.running) return;
    let next = codedCfg;
    // period/timeWindow combos live on cfg (range/mask), not codedCfg.
    let cfgNext = cfg;
    const twS = combo["timeWindow:startMin"];
    const twE = combo["timeWindow:endMin"];
    if (typeof twS === "number" && typeof twE === "number") {
      const tz = typeof combo["timeWindow:tz"] === "string" ? combo["timeWindow:tz"] : chartTimezone;
      cfgNext = {
        ...cfgNext,
        range: {
          ...cfgNext.range,
          mask: {
            ...(cfgNext.range.mask ?? { enabled: true }),
            enabled: true,
            timeOfDay: { startMin: twS, endMin: twE },
            tz,
            session: undefined,
          },
        },
      };
    }
    // period combo: apply the window as a custom range.
    const pFrom = combo["period:from"];
    const pTo = combo["period:to"];
    if (typeof pFrom === "number" && typeof pTo === "number") {
      cfgNext = { ...cfgNext, range: { ...cfgNext.range, mode: "custom", fromMs: pFrom * 1000, toMs: pTo * 1000 } };
    }
    for (const [key, value] of Object.entries(combo)) {
      if (key.startsWith("param:")) {
        const name = key.slice("param:".length);
        next = { ...next, params: { ...next.params, [name]: value } };
      } else if (key.startsWith("risk:")) {
        const [, side, field, prop] = key.split(/[:.]/); // risk:<side>.<field>.<prop>
        const riskKey = side === "long" ? "longRisk" : "shortRisk";
        const risk = next[riskKey] ?? EMPTY_RISK;
        next = {
          ...next,
          [riskKey]: { ...risk, [field]: { ...risk[field as "stop" | "target"], [prop]: value } },
        };
      }
    }
    // Synced-risk axes are canonicalized to the long side, so the combo only
    // carried risk:long.* keys — copy the applied values across to short.
    next = applyRiskSync(next, "long");
    updateCoded(next);
    if (cfgNext !== cfg) setCfg(cfgNext);
    // Published axes cleared + mode flipped so the run is a plain backtest
    // whose result lands on screen; sweepStateSignal kept so the results
    // table survives the apply one flip away (see applyRuleSweepCombo).
    sweepAxesSignal.set([]);
    selectMode("backtest");
    run(cfgNext !== cfg ? cfgNext : undefined);
  }

  // A run's 422 can name a declared param (a stale schema mid-edit) — surfaced
  // in red under the Parameters section instead of only the generic run-error
  // spot, so it's clear which knob is at fault.
  const [messages, setMessages] = useState(backtestMessagesSignal.value);
  useEffect(() => backtestMessagesSignal.subscribe(setMessages), []);
  // Anchored on the backend's exact "param '<name>':" message shape — a bare
  // substring match on the name misfires for short names (a param `n` would
  // claim "no candles in the selected range").
  const paramError =
    cfg.mode === "coded" && messages.error && selectedStrategy?.params.some((p) => messages.error!.includes(`param '${p.name}'`))
      ? messages.error
      : null;

  // Mirror the in-flight run state (owned by BacktestButton) so the footer's
  // "Run backtest" reads as unavailable while a run is going — its click was
  // already a no-op mid-run, but the button looked active.
  const [runInFlight, setRunInFlight] = useState(backtestRunningSignal.value);
  useEffect(() => backtestRunningSignal.subscribe(setRunInFlight), []);
  // Last completed run's wall-clock duration, per mode (footer readout).
  const [btDurationMs, setBtDurationMs] = useState(backtestDurationSignal.value);
  useEffect(() => backtestDurationSignal.subscribe(setBtDurationMs), []);
  const [sweepDurationMs, setSweepDurationMs] = useState(sweepDurationSignal.value);
  useEffect(() => sweepDurationSignal.subscribe(setSweepDurationMs), []);
  // Settings (top) / results (bottom) vertical split. resultsHeight 0 means
  // "unset" — the CSS default flex-basis governs until the user drags. Persisted
  // device-local so the layout survives re-opens and reloads.
  const splitRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  const [split, setSplit] = useState(loadBacktestSplit);
  useEffect(() => {
    saveBacktestSplit(split);
  }, [split]);
  const toggleResults = () => setSplit((s) => ({ ...s, collapsed: !s.collapsed }));

  // Refresh the shared per-epic reopen picker whenever the sweep results section
  // becomes visible, the epic changes, or a sweep lands server-side (archivedTick
  // re-fires so a just-finished sweep appears without a reopen). No auto-reopen —
  // which result is SHOWN is bound per tab+cell by the restore effect below.
  const sweepSectionOpen = btMode === "sweep" && !split.collapsed;
  useEffect(() => {
    if (!sweepSectionOpen) return;
    refreshPastSweeps();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sweepSectionOpen, epic, archivedTick]);

  // Bind the DISPLAYED sweep to this tab+cell: on a cell/epic switch (or when the
  // section first opens), restore THIS cell's own sweep from its persisted pointer
  // — or blank the view when it has none — so switching tabs never leaves another
  // cell's sweep on screen. Skipped while a sweep is running (never disturb a live
  // run); the running run writes its own pointer on completion. `scope` is keyed
  // so switching between two cells on the SAME epic still rebinds.
  const scope = controller?.scope ?? null;
  useEffect(() => {
    if (!sweepSectionOpen || !scope) return;
    if (sweepStateSignal.value?.running) return;
    const boundId = loadSweepResultId(scope, epic);
    if (!boundId) {
      // This cell has no sweep — blank the view (don't inherit another cell's).
      setPickedSweep("");
      sweepStateSignal.set(null);
      return;
    }
    let cancelled = false;
    setPickedSweep(boundId);
    getSweepArchive(boundId)
      .then((a) => {
        if (cancelled) return;
        setRanAxes(a.axes);
        sweepStateSignal.set({
          rows: a.rows, done: a.rows.length, total: a.rows.length, running: false,
        });
      })
      .catch(() => {
        if (cancelled) return;
        // Pointer dangles (archive deleted elsewhere or evicted past the server
        // cap): unbind and blank so a previous cell's sweep can't linger.
        clearSweepResultId(scope, epic);
        setPickedSweep("");
        sweepStateSignal.set(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, epic, sweepSectionOpen]);
  // Clearing the results (the pane's ✕, via backtestClearRequest) collapses the
  // now-empty results section — the mirror of run() expanding it. Subscribing here
  // keeps the split state (owned by this modal) in sync with the clear the panel
  // triggers. Guarded so it only collapses when currently expanded.
  useEffect(
    () =>
      backtestClearRequest.subscribe(() => setSplit((s) => (s.collapsed ? s : { ...s, collapsed: true }))),
    [],
  );
  function startResize(e: React.PointerEvent) {
    if (!splitRef.current) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragging.current = true;
  }
  function onResize(e: React.PointerEvent) {
    if (!dragging.current || !splitRef.current) return;
    const rect = splitRef.current.getBoundingClientRect();
    const h = Math.max(140, Math.min(rect.height - 180, rect.bottom - e.clientY));
    setSplit((s) => ({ ...s, resultsHeight: h }));
  }
  function endResize(e: React.PointerEvent) {
    if (!dragging.current) return;
    dragging.current = false;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  }
  // Panel width (px), dragged via the left-edge handle. Device-local view
  // preference like the split above. Clamped so the panel never eats the whole
  // viewport (keeps at least the chart's ~380px) nor shrinks below its min.
  const clampWidth = (w: number) =>
    Math.max(560, Math.min(w, Math.max(560, window.innerWidth - 380)));
  // Re-clamp on load: a width saved on a wider monitor must not swallow the
  // chart when reopened on a smaller window.
  const [panelWidth, setPanelWidth] = useState<number>(() => clampWidth(loadBacktestPanelWidth()));
  const onResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelWidth;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    let w = startW;
    const onMove = (ev: PointerEvent) => {
      // Left edge: dragging left (negative dx) grows the panel.
      w = clampWidth(startW + (startX - ev.clientX));
      setPanelWidth(w);
    };
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      saveBacktestPanelWidth(w);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    // A cancelled drag (e.g. the browser steals the pointer) must tear the
    // move listener down too, or hovering the edge would keep resizing with no
    // button held.
    el.addEventListener("pointercancel", onUp);
  };

  // Results layout: stacked (default) vs a docked column beside the panel.
  const [sideBySide, setSideBySide] = useState<boolean>(loadBacktestResultsSideBySide);
  const setResultsSideBySide = (on: boolean) => {
    setSideBySide(on);
    saveBacktestResultsSideBySide(on);
  };
  // Keep the chart at least ~200px even with the config panel + this column both docked.
  const clampColWidth = (w: number) =>
    Math.max(360, Math.min(w, Math.max(360, window.innerWidth - panelWidth - 200)));
  const [resultsColWidth, setResultsColWidth] = useState<number>(() =>
    clampColWidth(loadBacktestResultsColWidth()),
  );
  const onResultsColResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = resultsColWidth;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    let w = startW;
    const onMove = (ev: PointerEvent) => {
      // Left edge: dragging left (negative dx) grows the column.
      w = clampColWidth(startW + (startX - ev.clientX));
      setResultsColWidth(w);
    };
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      saveBacktestResultsColWidth(w);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  };

  // Inline height for the results region: unset/collapsed use CSS defaults.
  const resultsStyle: CSSProperties =
    split.collapsed || split.resultsHeight <= 0
      ? {}
      : { flex: `0 0 ${split.resultsHeight}px` };

  // Continuous scroll: all four sections live in one scroll pane (bodyRef). The
  // tab bar jumps to a section and highlights whichever is currently at the top
  // (scrollspy). setRef registers each section; suppressSpyUntil silences the
  // spy during the smooth jump so it lands on the clicked tab, not the ones it
  // scrolls past.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const sectionRefs = useRef<Record<BacktestTab, HTMLElement | null>>({
    period: null,
    strategy: null,
    costs: null,
    presets: null,
  });
  const suppressSpyUntil = useRef(0);
  const setRef = (t: BacktestTab) => (el: HTMLElement | null) => {
    sectionRefs.current[t] = el;
  };
  function jumpToTab(t: BacktestTab) {
    setTab(t);
    const el = sectionRefs.current[t];
    const c = bodyRef.current;
    if (!el || !c) return;
    suppressSpyUntil.current = Date.now() + 700;
    const top = el.getBoundingClientRect().top - c.getBoundingClientRect().top + c.scrollTop;
    c.scrollTo?.({ top, behavior: "smooth" });
  }
  function onBodyScroll() {
    if (Date.now() < suppressSpyUntil.current) return;
    const c = bodyRef.current;
    if (!c) return;
    // The active tab is the last section whose top has passed just below the
    // pane's top edge (a small 24px lead-in feels natural).
    const ctop = c.getBoundingClientRect().top;
    let current: BacktestTab = BACKTEST_TABS[0].value;
    for (const t of BACKTEST_TABS) {
      const el = sectionRefs.current[t.value];
      if (el && el.getBoundingClientRect().top - ctop <= 24) current = t.value;
    }
    setTab((prev) => (prev === current ? prev : current));
  }
  // A single copied rule, shared across all four groups so a rule can be pasted
  // between entry/exit and — the point of this — between the long and short
  // sides. Null until the user copies one; cleared only by copying another.
  const [clipboard, setClipboard] = useState<Rule | null>(null);
  // A copied set of whole-group rules, shared across all four groups the same way
  // — so every rule in one side/leg can be pasted into another at once.
  const [groupClipboard, setGroupClipboard] = useState<Rule[] | null>(null);

  // The chart-operand picker is modal-owned (opened from deep in the rule builder
  // via a threaded callback). `pickerFor` holds the pick handler; non-null = open.
  const [pickerFor, setPickerFor] = useState<((op: Operand) => void) | null>(null);
  // The chart selection that existed BEFORE the picker opened, snapshotted so closing
  // the picker restores it rather than clobbering it — the picker temporarily drives
  // the on-chart selection to preview/highlight its rows, but it never owned whatever
  // the user had selected beforehand.
  const priorSelection = useRef<{ ind: { paneId: string; name: string } | null; draw: string | null }>({
    ind: null,
    draw: null,
  });
  const openChartPicker = (onPick: (op: Operand) => void) => {
    if (controller) {
      priorSelection.current = {
        ind: controller.selectedIndicator.value,
        draw: controller.overlays.getSelectedDrawingId(),
      };
    }
    setPickerFor(() => onPick);
  };
  const pickerSources = useMemo(() => (pickerFor ? enumerateChartOperands(controller) : []), [pickerFor, controller]);
  // Drive the on-chart element behind the picker's EFFECTIVE target (hovered row,
  // else the selected row — see ChartOperandPicker) into real, persistent SELECTED
  // mode, so the selected item stays selected on the chart until the picker
  // selection changes or the picker closes:
  //  - a drawing → selectDrawing (bookkeeping/keyboard) + a thicken so it's visible
  //    (klinecharts has no programmatic native-handle API; the thicken is our cue).
  //  - an indicator → selectedIndicator (the persistent selection that shows the
  //    hollow handles and, unlike curveHover, survives the user hovering the chart).
  // Reconcile BOTH on every change; null clears whichever was active.
  const handleHoverSource = (t: EmphasisTarget | null) => {
    if (!controller) return;
    // No effective target (nothing hovered/selected in the picker, or the picker is
    // closing) → RESTORE the pre-picker selection rather than clearing it, so a
    // selection the user made before opening the picker survives the picker's close.
    if (t === null) {
      const prior = priorSelection.current;
      controller.overlays.hoverDrawing(null);
      controller.overlays.selectDrawing(prior.draw);
      controller.selectedIndicator.set(prior.ind);
      return;
    }
    const drawingId = t.kind === "drawing" ? t.id : null;
    controller.overlays.selectDrawing(drawingId);
    controller.overlays.hoverDrawing(drawingId);
    const ind = t.kind === "indicator" ? { paneId: t.paneId, name: t.name } : null;
    const cur = controller.selectedIndicator.value;
    if ((cur?.paneId ?? null) !== (ind?.paneId ?? null) || (cur?.name ?? null) !== (ind?.name ?? null)) {
      controller.selectedIndicator.set(ind);
    }
  };

  // The timeframe the run will actually use: the config override when set, else
  // the active chart timeframe (the `resolution` prop). Window math + the header
  // badge follow this so they reflect the run, not necessarily the chart.
  const effectiveRes = cfg.range.resolution ?? resolution;
  const resSeconds = RESOLUTION_SECONDS[effectiveRes] ?? 60;

  const defaultAvwapAnchor = resolveWindow(cfg, resSeconds, Date.now()).fromMs;

  const usesVolume = [cfg.longEntry, cfg.longExit, cfg.shortEntry, cfg.shortExit].some((g) =>
    g.rules.some((r) =>
      [r.left, r.right].some(
        (op) => op.kind === "indicator" && (op.indicator === "VOL" || op.indicator === "VOLMA" || op.indicator === "AVWAP"),
      ),
    ),
  );

  function setRange(patch: Partial<RangeConfig>) {
    setCfg({ ...cfg, range: { ...cfg.range, ...patch } });
  }
  function setMask(patch: Partial<RecurrenceMask>) {
    const base: RecurrenceMask = cfg.range.mask ?? { enabled: false };
    setRange({ mask: { ...base, ...patch } });
  }

  // Coverage readout + heat-strip: sample the resolved window on a coarse grid
  // (>= 1h buckets, capped) and count how many slots the mask keeps active.
  const maskPreview = useMemo(() => {
    const m = cfg.range.mask;
    if (!m?.enabled) return null;
    const { fromMs, toMs } = resolveWindow(cfg, resSeconds, Date.now());
    const stepMs = Math.max(resSeconds, 3600) * 1000;
    const grid: number[] = [];
    for (let t = fromMs; t < toMs && grid.length < 2000; t += stepMs) grid.push(t);
    const resolved = { ...resolveMask(m), tz: chartTimezone };
    return { grid, resolved, cov: coverage(grid, resolved) };

  }, [cfg, resSeconds, chartTimezone]);
  // The reserved holdout window ("from → to" of the locked-away tail), for the
  // footer/badge copy. Recomputed with the range so it tracks edits live.
  const holdoutReserved = useMemo(() => {
    if (!holdout) return null;
    const { fromMs, toMs } = resolveWindow(cfg, resSeconds, Date.now());
    const { holdoutFromMs } = splitHoldout(fromMs, toMs, holdout.pct);
    const fmt = (ms: number) => new Date(ms).toLocaleDateString();
    return `${fmt(holdoutFromMs)} to ${fmt(toMs)}`;
  }, [holdout, cfg, resSeconds]);
  function setCosts(patch: Partial<Costs>) {
    setCfg({ ...cfg, costs: { ...cfg.costs, ...patch } });
  }

  // --- instrument cost profile (Costs tab) ----------------------------------
  // The subset of Costs that mirrors the broker profile — the only fields the
  // debounced PUT sends (quantity/commission/starting cash are panel-only).
  type InstrumentCostPatch = Partial<
    Pick<Costs, "spread" | "slippage" | "finLongDailyPct" | "finShortDailyPct">
  >;
  const pendingCostPatch = useRef<InstrumentCostPatch>({});
  const costPutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The epic the pending patch belongs to. The modal is docked and reused across
  // symbol switches (no remount), so a patch must PUT to the epic it was edited
  // on, NOT whatever epic is current when the debounce timer fires.
  const pendingEpicRef = useRef(epic);
  const currentEpicRef = useRef(epic);
  currentEpicRef.current = epic;

  function flushCostPut() {
    if (costPutTimer.current) {
      clearTimeout(costPutTimer.current);
      costPutTimer.current = null;
    }
    const patch = pendingCostPatch.current;
    if (Object.keys(patch).length === 0) return;
    pendingCostPatch.current = {};
    const targetEpic = pendingEpicRef.current;
    putCostProfile(targetEpic, patch)
      .then((p) => {
        costProfileCache.set(targetEpic, p);
        // Only reflect the returned profile if the modal is still on that epic —
        // a late save for a previous epic must not overwrite the current one's note.
        if (currentEpicRef.current === targetEpic) setCostProfile(p);
      })
      .catch(() => {
        // Transient save failure: the value already lives in cfg.costs and is
        // snapshotted into the run, so the edit is not lost — only the mirror is.
      });
  }

  // Prefill the instrument-cost fields from the broker profile the first time the
  // Costs tab is shown for an epic (once per epic per session). A failed fetch
  // (broker 502/503/504 or network) keeps the current cfg values and does not
  // retry-loop: the effect only re-runs on epic/broker change and a failure is
  // not cached.
  useEffect(() => {
    const cached = costProfileCache.get(epic);
    if (cached) {
      // Already fetched this epic this session (its cache stays current because
      // every edit's PUT writes the returned profile back). Re-apply it so a
      // switch back to this epic on the same mounted modal restores its costs.
      setCostProfile(cached);
      setCfg((prev) => ({ ...prev, costs: { ...prev.costs, ...profileToCostsPatch(cached) } }));
      return;
    }
    let cancelled = false;
    getCostProfile(epic, brokerId)
      .then((p) => {
        if (cancelled) return;
        costProfileCache.set(epic, p);
        setCostProfile(p);
        setCfg((prev) => ({ ...prev, costs: { ...prev.costs, ...profileToCostsPatch(p) } }));
      })
      .catch(() => {
        /* keep current cfg; no retry */
      });
    return () => {
      cancelled = true;
    };
  }, [epic, brokerId]);

  // Flush any pending profile edit when the modal unmounts, so an edit made inside
  // the debounce window right before closing still reaches the broker profile.
  useEffect(() => () => flushCostPut(), []);

  // An instrument-cost edit: write it into cfg.costs immediately and mirror it back
  // to the broker profile on a short debounce (coalescing rapid keystrokes).
  function setInstrumentCost(patch: InstrumentCostPatch) {
    setCosts(patch);
    // An epic switch happened while a patch was pending: flush the old epic's
    // patch to its own profile before starting this epic's, so patches never
    // coalesce across instruments or PUT to the wrong one.
    if (Object.keys(pendingCostPatch.current).length && pendingEpicRef.current !== epic) {
      flushCostPut();
    }
    pendingEpicRef.current = epic;
    pendingCostPatch.current = { ...pendingCostPatch.current, ...patch };
    if (costPutTimer.current) clearTimeout(costPutTimer.current);
    costPutTimer.current = setTimeout(flushCostPut, 400);
  }

  // Re-pull spread and financing from the broker and apply the new profile.
  function refetchCosts() {
    refetchCostProfile(epic, brokerId)
      .then(({ new: fresh }) => {
        costProfileCache.set(epic, fresh);
        setCostProfile(fresh);
        setCfg((prev) => ({ ...prev, costs: { ...prev.costs, ...profileToCostsPatch(fresh) } }));
      })
      .catch(() => {
        /* broker error: keep current values */
      });
  }

  function setGroup(which: "longEntry" | "longExit" | "shortEntry" | "shortExit", group: RuleGroup) {
    setCfg({ ...cfg, [which]: group });
  }

  // Docked panel: running does NOT close it, so you can tweak and re-run
  // against the chart beside it. The header ✕ is the only close. Results live in
  // the always-visible bottom pane, so there's no tab to jump to — but a run
  // must expand the results pane if the user had collapsed it.
  // Optional override lets a caller that just computed a new cfg via setCfg
  // (a setState, not synchronous) run against that value immediately instead
  // of the stale `cfg` still in this closure — see applyRuleSweepCombo.
  function run(override?: BacktestConfig) {
    onRun(withChartTz(override ?? cfg, chartTimezone));
    setSplit((s) => (s.collapsed ? { ...s, collapsed: false } : s));
  }
  // Footer "Run backtest": publish the CURRENT sweep axes right before firing —
  // separate from applySweepCombo's own run(), which explicitly clears the
  // signal to [] first for its single-combo follow-up run.
  function runFromFooter() {
    if (btMode !== "sweep") {
      // Backtest mode: always a single run. Publish an empty axis set even
      // when axes are configured — the mode gates the run, so BacktestButton
      // must take its single-run path.
      sweepAxesSignal.set([]);
      sweepCombosOverrideSignal.set(null);
      run();
      return;
    }
    if (sweepAxes.length === 0) return; // button is disabled; belt and braces
    // A fresh sweep replaces the on-screen results, so any reopened-archive
    // selection is now stale — clear it so the picker doesn't mislabel the run.
    setPickedSweep("");
    // Synced SL/TP: stamp risk axes with their short-side mirror so the sweep
    // moves both legs together (the axes themselves stay long-side only).
    const synced = cfg.mode === "coded" ? riskSyncOn(codedCfg) : riskSyncOn(cfg);
    const mirrored = synced ? mirrorRiskAxes(sweepAxes) : sweepAxes;
    // Period axes materialize against the range as configured RIGHT NOW, so an
    // edit between toggle and run can never sweep stale windows.
    const { fromMs, toMs } = resolveWindow(cfg, resSeconds, Date.now());
    // Holdout clamp: a reserved tail shrinks the sweepable window to the training
    // span so period (window) axes never materialize over the locked-away tail.
    const effToMs = holdout ? splitHoldout(fromMs, toMs, holdout.pct).trainToMs : toMs;
    // Re-label against the config as it runs (collision-aware across all axes),
    // so results name each axis by what it swept even if a rule is edited after.
    const finalAxes = withSweepLabels(materializePeriodAxes(mirrored, fromMs, effToMs), labelCfg());
    // "Last used" range memory: recorded at run time, keyed per context.
    recordSweepRanges(sweepCtx(), sweepAxes);
    setRanAxes(finalAxes);
    sweepAxesSignal.set(finalAxes);
    // Random search: sample N combos from the fully-materialized axes and hand
    // them to BacktestButton as a one-shot override. Grid always clears it so a
    // stale sample from a prior random run can never leak into this grid run.
    // Seed fixed at 1: same ranges + N reproduce the same sample.
    sweepCombosOverrideSignal.set(
      searchMode === "random" ? sampleCombos(finalAxes, randomN, 1) : null,
    );
    run();
  }
  // Evaluate on the reserved holdout tail: a single run over [holdoutFromMs, toMs]
  // via the one-shot holdoutEvalSignal (BacktestButton skips the training clamp
  // when it sees the flag). Every look is counted — a holdout peeked at often
  // quietly stops being out-of-sample — and the count is surfaced below.
  function evaluateHoldout() {
    if (runInFlight || !holdout) return;
    const key = sweepCtx();
    sweepAxesSignal.set([]); // force BacktestButton's single-run path
    sweepCombosOverrideSignal.set(null);
    holdoutEvalSignal.set(true);
    run();
    const peeks = recordPeek(key);
    setHoldout((h) => (h ? { ...h, peeks } : h));
  }

  function savePreset() {
    const name = presetName.trim();
    if (!name) return;
    saveBacktestPreset(name, cfg);
    setPresets(loadBacktestPresets());
    setPresetName("");
  }
  function applyPreset(name: string) {
    const p = presets[name];
    if (p) setCfg(applyRiskSync(p, side));
  }
  function removePreset(name: string) {
    deleteBacktestPreset(name);
    setPresets(loadBacktestPresets());
    if (loadName === name) setLoadName("");
  }

  // Stable SweepResults props: it's memoized, and a fresh onApply/onRefine
  // closure or progress object here would re-render the whole (large) results
  // tree on every keystroke in this modal.
  const applySweepComboStable = useStableCallback(applySweepCombo);
  const refineSweepAxes = useCallback(
    (combo: Record<string, number | boolean | string>) =>
      setSweepAxes((axes) => refineAxesAround(axes, combo as SweepCombo)),
    [],
  );
  const sweepProgress = useMemo(
    () =>
      sweepState?.running
        ? {
            done: sweepState.done,
            total: sweepState.total,
            etaSeconds: sweepState.etaSeconds,
            startedAt: sweepState.startedAt,
          }
        : null,
    [sweepState],
  );

  // One results instance, rendered either in the stacked region or the docked
  // column. Follows the active Backtest|Sweep mode; nothing is duplicated.
  const resultsBody = (
    <>
      {btMode === "backtest" && <BacktestPanel />}
      {btMode === "sweep" && (
        <>
          {sweepState ? (
            <div className="sweep-panel">
              {sweepState.cancelled ? (
                <div className="al-note">Cancelled, kept {sweepState.done} of {sweepState.total}</div>
              ) : sweepState.error ? (
                <div className="al-note bt-param-error">{sweepState.error}</div>
              ) : null}
              <SweepResults
                rows={sweepState.rows}
                axes={ranAxes.length ? ranAxes : sweepAxes}
                onApply={applySweepComboStable}
                onRefine={refineSweepAxes}
                progress={sweepProgress}
              />
            </div>
          ) : (
            <div className="bt-results-empty">
              No sweep results yet. Turn on the sweep toggle next to the fields you want to
              vary, then press Run sweep.
            </div>
          )}
        </>
      )}
    </>
  );

  // The Backtest | Sweep switch lives in the Results header (docked row or
  // side column head) rather than the footer, so it sits with the view it
  // flips. Built once here because both layouts render it.
  const modeSeg = (
    <ModeSeg
      mode={btMode}
      onSelectMode={selectMode}
      modeBadge={sweepState?.running ? (
        <span className="bt-mode-badge">{sweepState.done}/{sweepState.total}</span>
      ) : btMode === "backtest" && sweepAxes.length > 0 && isFinite(sweepCombos) ? (
        <span className="bt-mode-badge">{sweepCombos}</span>
      ) : null}
    />
  );

  // The Cancel-sweep/Clear-results lead and the Run button normally sit in the
  // panel footer, but move to the docked column's own footer when it is open —
  // Go live and the sweep info (counters, Search/Compute toggles) stay behind
  // in the panel. Built once here because either footer may render them.
  const runClusterLead =
    btMode === "sweep" && sweepState ? (
      sweepState.running ? (
        <button className="ghost" onClick={() => requestSweepCancel(true)}>
          Cancel sweep
        </button>
      ) : (
        <button className="ghost" onClick={clearSweepResults}>
          Clear results
        </button>
      )
    ) : null;
  // Last completed run's wall-clock duration (session-only, final number only —
  // hidden while a run is in flight). Per mode so a backtest never shows the
  // sweep's time or vice versa. Built once: it renders in whichever footer
  // holds the Run button — the docked column's when open, else the panel's.
  const [durationMs, durationBusy] = btMode === "backtest"
    ? [btDurationMs, runInFlight]
    : [sweepDurationMs, !!sweepState?.running];
  const durationInfo = durationMs != null && !durationBusy ? (
    <span className="sweep-counter bt-run-duration">Took {fmtRunDuration(durationMs)}</span>
  ) : null;
  // Compact past-sweeps reopen picker: a bare dropdown + delete icon, shown in
  // the sweep footer only when there is archived history to reopen. No label or
  // placeholder text — the dropdown is self-evident and stays narrow.
  const pastSweepsPicker = btMode === "sweep" && pastSweeps.length > 0 ? (
    <PastSweepsMenu
      sweeps={pastSweeps}
      disabled={sweepState?.running}
      onReopen={(id) => {
        setPickedSweep(id);
        reopenSweep(id, true);
      }}
      onDelete={removePastSweep}
    />
  ) : null;
  const runLabel = runInFlight ? "Running…" : btMode === "sweep" ? "Run sweep" : "Run backtest";
  const runDisabled = runInFlight || (btMode === "sweep" && sweepAxes.length === 0);

  return (
    <>
    {sideBySide && (
      <aside className={`bt-results-col bt-mode-${btMode}`} style={{ width: resultsColWidth }}>
        <div
          className="bt-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize results column"
          onPointerDown={onResultsColResizeStart}
          onDoubleClick={() => {
            setResultsColWidth(clampColWidth(BACKTEST_RESULTS_COL_DEFAULT_WIDTH));
            saveBacktestResultsColWidth(BACKTEST_RESULTS_COL_DEFAULT_WIDTH);
          }}
        />
        <div className="bt-cfg-head">
          {/* Dock-back sits at the header's far LEFT (away from the config
              panel) and points right, toward the panel the results return to. */}
          <span className="bt-results-head-left">
            <Tooltip content="Dock results back into the panel">
              <button
                className="bt-results-layout-btn"
                aria-label="Dock results back into the panel"
                onClick={() => setResultsSideBySide(false)}
              >
                <ColumnGlyph flipped />
              </button>
            </Tooltip>
            <span className="bt-cfg-title">Results</span>
          </span>
          <span className="bt-results-head-actions">{modeSeg}</span>
        </div>
        <div className="bt-results-col-body">{resultsBody}</div>
        <div className="modal-foot bt-cfg-foot">
          <RunBar
            sweepInfo={durationInfo}
            runClusterLead={runClusterLead}
            runLabel={runLabel}
            runDisabled={runDisabled}
            onRun={runFromFooter}
          />
        </div>
      </aside>
    )}
    <aside className={`bt-cfg-panel bt-mode-${btMode}`} style={{ width: panelWidth }}>
        <div
          className="bt-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize backtest panel"
          onPointerDown={onResizeStart}
          onDoubleClick={() => {
            setPanelWidth(BACKTEST_PANEL_DEFAULT_WIDTH);
            saveBacktestPanelWidth(BACKTEST_PANEL_DEFAULT_WIDTH);
          }}
        />
        <div className="bt-cfg-head">
          <span className="bt-cfg-title">
            Backtest — <strong>{epic}</strong> <span className="bt-cfg-res">{effectiveRes}</span>
          </span>
          <CloseButton onClick={onClose} />
        </div>

        <div className="bt-split" ref={splitRef}>
        <div className="bt-settings-region">
          <nav className="bt-htabs">
            {BACKTEST_TABS.map((t) => (
              <button
                key={t.value}
                className={tab === t.value ? "on" : ""}
                onClick={() => jumpToTab(t.value)}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div className="bt-body" ref={bodyRef} onScroll={onBodyScroll}>
            <section className="bt-scroll-section" ref={setRef("period")}>
                <Section
                  title="Time range"
                  info="The span of history the backtest trades over. Pick a relative window (last day/week/month/year), a calendar period via the chips, or a custom from/to."
                >
            <div className="bt-range-mode-row">
              <div className="seg">
                {RANGE_MODES.map((m) => (
                  <button
                    key={m.value}
                    className={cfg.range.mode === m.value ? "seg-on" : ""}
                    onClick={() => setRange({ mode: m.value, fromMs: undefined, toMs: undefined })}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <label className="bt-tf-inline">
                <span className="bt-tf-label">
                  Timeframe
                  <InfoTip text="Timeframe the backtest runs on. 'Chart' follows the active chart timeframe." />
                </span>
              <select
                className="bt-tf-select"
                value={cfg.range.resolution ?? ""}
                onChange={(e) => setRange({ resolution: e.target.value || undefined })}
              >
                <option value="">Chart</option>
                {PERIOD_GROUPS.map((group) => {
                  const periods = group.periods.filter((p) => !p.liveOnly);
                  if (periods.length === 0) return null;
                  return (
                    <optgroup key={group.label} label={group.label}>
                      {periods.map((p) => (
                        <option key={p.resolution} value={p.resolution}>
                          {p.label}
                        </option>
                      ))}
                    </optgroup>
                  );
                })}
              </select>
              </label>
              <Tooltip content="Sweep the trading period: split the range into N equal windows and run each">
                <button
                  type="button"
                  className={`sp-sweep bt-period-sweep-toggle${periodAxis ? " on" : ""}`}
                  onClick={togglePeriodSweepAxis}
                >
                  <SweepGlyph />
                </button>
              </Tooltip>
              <label className="bt-tf-inline bt-robust-windows">
                <span className="bt-tf-label">
                  Windows
                  <InfoTip text="Splits the range into equal windows to score consistency. Auto picks daily, weekly, or monthly by range length; set a number to override." />
                </span>
                <input
                  type="number"
                  min={2}
                  max={50}
                  placeholder="auto"
                  value={cfg.robustWindows ?? ""}
                  onChange={(e) => {
                    // Store the raw value while typing so intermediate numbers like
                    // "1" on the way to "15" aren't clamped up to 2 mid-keystroke.
                    // Empty means auto (undefined); blur clamps to 2..50.
                    const v = e.target.value === "" ? undefined : Math.round(Number(e.target.value));
                    setCfg({ ...cfg, robustWindows: v !== undefined && Number.isFinite(v) ? v : undefined });
                  }}
                  onBlur={() => {
                    if (cfg.robustWindows !== undefined) {
                      setCfg({ ...cfg, robustWindows: Math.max(2, Math.min(50, cfg.robustWindows)) });
                    }
                  }}
                />
              </label>
              <label className="bt-tf-inline bt-holdout-inline">
                <span className="bt-tf-label">
                  Holdout
                  <InfoTip text="Reserve the last part of the range as an out-of-sample lockbox. Normal runs and sweeps stop at the training cutoff; use Evaluate on holdout to test the reserved tail. Every look is counted, because a holdout you check often stops being out-of-sample." />
                </span>
                <select
                  className="bt-tf-select"
                  value={holdout?.pct ?? 0}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    changeHoldoutPct(v === 0 ? null : v);
                  }}
                >
                  <option value={0}>None</option>
                  <option value={10}>10%</option>
                  <option value={20}>20%</option>
                  <option value={30}>30%</option>
                </select>
              </label>
            </div>
            {CHIP_UNIT[cfg.range.mode] ? (
              <div className="bt-chip-row bt-range-chip-row">
                {buildRangeChips(CHIP_UNIT[cfg.range.mode]!, Date.now(), chartTimezone).map((chip) => {
                  const on = cfg.range.fromMs === chip.fromMs && cfg.range.toMs === chip.toMs;
                  return (
                    <button
                      key={chip.label}
                      className={on ? "seg-on bt-chip" : "bt-chip"}
                      onClick={() => setRange({ fromMs: chip.fromMs, toMs: chip.toMs })}
                    >
                      {chip.label}
                    </button>
                  );
                })}
                <span className="al-note bt-range-subtitle bt-range-inline">{rangeDateLabel(cfg, resSeconds)}</span>
              </div>
            ) : (
              <div className="al-note bt-range-subtitle">{rangeDateLabel(cfg, resSeconds)}</div>
            )}
            {periodAxis?.kind === "period" && (
              <div className="sp-row sweep-axis-row bt-period-sweep">
                <span className="sp-label">Period sweep</span>
                <span className="sweep-axis-fields">
                  <span>windows</span>
                  <input
                    type="number"
                    min={2}
                    max={50}
                    step={1}
                    value={periodAxis.n}
                    onChange={(e) => setPeriodN(Number(e.target.value))}
                  />
                </span>
              </div>
            )}
            {cfg.range.mode === "bars" && (
              <label className="al-row">
                <span>Bars</span>
                <input
                  type="number"
                  min={1}
                  value={cfg.range.bars ?? 500}
                  onKeyDown={blockNegKeys}
                  onChange={(e) => setRange({ bars: Number(cleanNumInput(e.currentTarget)) })}
                  onBlur={(e) => clampPosOnBlur(e.currentTarget, 1, (n) => setRange({ bars: n }))}
                />
              </label>
            )}
            {cfg.range.mode === "custom" && (
              <div className="al-row bt-range-row">
                <label className="bt-range-field">
                  <span>From</span>
                  <input
                    type="datetime-local"
                    value={cfg.range.fromMs ? msToLocalInput(cfg.range.fromMs) : ""}
                    onChange={(e) => setRange({ fromMs: localInputToMs(e.target.value) ?? undefined })}
                  />
                </label>
                <label className="bt-range-field">
                  <span>To</span>
                  <input
                    type="datetime-local"
                    value={cfg.range.toMs ? msToLocalInput(cfg.range.toMs) : ""}
                    onChange={(e) => setRange({ toMs: localInputToMs(e.target.value) ?? undefined })}
                  />
                </label>
                <Tooltip
                  content={
                    !controller
                      ? "Focus a chart to pick a range"
                      : pickingRange
                        ? "Picking… drag across the chart's time axis, or click a start then an end. Esc cancels."
                        : "Pick the range on the chart: drag across the time axis, or click a start then an end"
                  }
                >
                  <button
                    type="button"
                    className={`bt-pick-range${pickingRange ? " on" : ""}`}
                    disabled={!controller}
                    aria-label="Pick range on chart"
                    onClick={() => {
                      if (!controller) return;
                      if (controller.rangePickArmed.value) {
                        controller.rangePickArmed.set(false);
                      } else {
                        controller.rangePickArmed.set(true);
                        controller.focusChart?.(); // so Esc reaches the chart
                      }
                    }}
                  >
                    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
                      <path
                        d="M3 4v8M13 4v8M3 8h10"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.4"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </Tooltip>
              </div>
            )}
            {/* Holdout ("lockbox") reserves the last part of the range as an
                out-of-sample tail. The picker itself lives up in the Time range
                header (next to Timeframe/Windows); here we only surface the
                reserved-tail note + Evaluate button once a holdout is set. Runs
                and sweeps clamp to the training span; the reserved tail is only
                touched by Evaluate on holdout, and every look is counted. */}
            {holdout && (
              <>
                <div className="al-note">
                  Holdout: last {holdout.pct}% reserved
                  {holdoutReserved ? ` (${holdoutReserved})` : ""}
                </div>
                <button
                  type="button"
                  className="ghost bt-holdout-eval"
                  disabled={runInFlight}
                  onClick={evaluateHoldout}
                >
                  Evaluate on holdout
                </button>
                {holdout.peeks > 0 && (
                  <div className="al-note">
                    Holdout result viewed {holdout.peeks} times. Each look makes it
                    less out-of-sample.
                  </div>
                )}
              </>
            )}
          </Section>

          <Section
            title="Repeat / active windows"
            info="Limit trading to recurring windows: weekdays, months, days of the month, or a market session. Outside them, no new positions open."
          >
            <div className="bt-mask-toggles">
              <label className="al-row bt-mask-toggle">
                <input
                  type="checkbox"
                  checked={cfg.range.mask?.enabled ?? false}
                  onChange={(e) => setMask({ enabled: e.target.checked })}
                />
                <span>Only trade during selected windows</span>
                <InfoTip text="When on, positions only open inside the windows below. Already-open positions keep running unless you also close them at session close." />
              </label>

              {cfg.range.mask?.enabled && (
                <label className="al-row bt-mask-toggle">
                  <input
                    type="checkbox"
                    checked={cfg.range.mask?.flattenAtClose ?? false}
                    onChange={(e) => setMask({ flattenAtClose: e.target.checked })}
                  />
                  <span>Close open positions at session close</span>
                  <InfoTip
                    text={[
                      "Off (default): a position opened in a window keeps running past the session boundary until its stop or target hits, or the range ends.",
                      "On: any open position is force-closed at each session close.",
                    ]}
                  />
                </label>
              )}
            </div>

            {cfg.range.mask?.enabled && (
              <>
                <div className="bt-chip-row bt-dow-row">
                  {DOW_LABELS.map((d, i) => {
                    const on = cfg.range.mask?.daysOfWeek?.includes(i) ?? false;
                    return (
                      <button
                        key={d}
                        className={on ? "seg-on bt-chip" : "bt-chip"}
                        onClick={() => setMask({ daysOfWeek: toggle(cfg.range.mask?.daysOfWeek, i) })}
                      >
                        {d}
                      </button>
                    );
                  })}
                  {/* Session filler + From/To ride the right end of the weekday row
                      so the whole window config sits on one line. */}
                  <div className="bt-dow-extras">
                    <label className="bt-range-field bt-time-field">
                      <span>From</span>
                      <input
                        type="time"
                        disabled={resSeconds >= 86400}
                        value={minToTime(cfg.range.mask?.timeOfDay?.startMin)}
                        onChange={(e) => setMask({ timeOfDay: withStart(cfg.range.mask?.timeOfDay, timeToMin(e.target.value)) })}
                      />
                    </label>
                    <label className="bt-range-field bt-time-field">
                      <span>To</span>
                      <input
                        type="time"
                        disabled={resSeconds >= 86400}
                        value={minToTime(cfg.range.mask?.timeOfDay?.endMin)}
                        onChange={(e) => setMask({ timeOfDay: withEnd(cfg.range.mask?.timeOfDay, timeToMin(e.target.value)) })}
                      />
                    </label>
                    <Tooltip content="Sweep the time window: run each of several intraday windows">
                      <button
                        type="button"
                        className={`sp-sweep bt-tw-sweep-toggle${timeWindowAxis ? " on" : ""}`}
                        disabled={resSeconds >= 86400}
                        onClick={toggleTimeWindowSweepAxis}
                      >
                        <SweepGlyph />
                      </button>
                    </Tooltip>
                    <span className="bt-range-field bt-session-field">
                      {/* Not persisted: picking a session fills the fields once and
                          leaves them all editable — an action menu, not a stateful
                          selector that would show a stale "selected" value. */}
                      <SessionFillMenu
                        disabled={resSeconds >= 86400}
                        chartTz={chartTimezone}
                        onPick={(key) => {
                          // Fill From/To with the session's hours converted into
                          // the chart timezone — the window is read there like
                          // every other clock filter (the tz is NOT set).
                          // resolveMask keeps existing weekday chips if the user set
                          // any (non-destructive), else fills the preset's weekdays.
                          const r = resolveMask({ ...cfg.range.mask, session: key });
                          const p = SESSION_PRESETS[key];
                          const timeOfDay = sessionWindowInTz(r.timeOfDay ?? null, p.tz, chartTimezone, Date.now()) ?? undefined;
                          setMask({ session: undefined, timeOfDay, daysOfWeek: r.daysOfWeek });
                        }}
                      />
                      <InfoTip text="Fills From/To (and weekdays, if none are set yet) from a market's hours. Everything stays editable after. Intraday timeframes only." />
                    </span>
                  </div>
                </div>

                <div className="bt-chip-row">
                  {MONTH_LABELS.map((mo, idx) => {
                    const m = idx + 1;
                    const on = cfg.range.mask?.monthsOfYear?.includes(m) ?? false;
                    return (
                      <button
                        key={mo}
                        className={on ? "seg-on bt-chip" : "bt-chip"}
                        onClick={() => setMask({ monthsOfYear: toggle(cfg.range.mask?.monthsOfYear, m) })}
                      >
                        {mo}
                      </button>
                    );
                  })}
                </div>

                <div className="al-note bt-tz-note">
                  Weekday, day-of-month and clock filters are read in the chart's
                  timezone: {tzDisplay(chartTimezone)}. Change it in chart Settings to
                  gate on another market's hours.
                </div>

                {timeWindowAxis?.kind === "list" && (
                  <div className="sp-row sweep-axis-row bt-tw-sweep">
                    <span className="sp-label">Window sweep</span>
                    <span className="bt-tw-options">
                      {timeWindowAxis.options.map((o, i) => (
                        <span key={o.label} className="bt-chip seg-on bt-tw-option">
                          {o.label}
                          <button
                            type="button"
                            aria-label={`Remove ${o.label}`}
                            onClick={() => removeTimeWindowOption(i)}
                          >
                            x
                          </button>
                        </span>
                      ))}
                      <button
                        type="button"
                        className="ghost"
                        disabled={!cfg.range.mask?.timeOfDay}
                        onClick={() => {
                          const t = cfg.range.mask?.timeOfDay;
                          if (t) addTimeWindowOption(twOption(t.startMin, t.endMin, chartTimezone));
                        }}
                      >
                        + current window
                      </button>
                      <select
                        aria-label="Add session window"
                        value=""
                        onChange={(e) => addSessionWindowOption(e.target.value as SessionPreset | "")}
                      >
                        <option value="">+ session</option>
                        {Object.entries(SESSION_PRESETS).map(([k, v]) => (
                          <option key={k} value={k}>{v.label}</option>
                        ))}
                      </select>
                    </span>
                  </div>
                )}

                {resSeconds >= 86400 && (
                  <div className="al-note">Clock/session filters apply on intraday timeframes only.</div>
                )}

                {maskPreview && (
                  <>
                    <div className="al-note">
                      Active on {maskPreview.cov.active} of {maskPreview.cov.total} sampled slots
                      {" "}
                      ({Math.round((maskPreview.cov.active / Math.max(1, maskPreview.cov.total)) * 100)}%)
                    </div>
                    <div className="bt-heatstrip" aria-hidden>
                      {maskPreview.grid.slice(0, 400).map((t) => (
                        <span key={t} className={isActive(maskPreview.resolved, t) ? "on" : "off"} />
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </Section>

          <Section
            title="History depth"
            info={[
              "Candles loaded before your window to warm up indicators. Never adds trades.",
              <><strong>Minimal</strong>: just enough (fastest).</>,
              <><strong>Bars</strong>: a count you set.</>,
              <><strong>Full</strong>: years of history (slow; only when warm-up can't size itself).</>,
            ]}
          >
            <div className="al-note">
              Indicators warm up on the candles loaded before your window. Trades still only open
              once the window starts.
            </div>
            <div className="seg">
              {HISTORY_DEPTHS.map((h) => (
                <button
                  key={h.value}
                  className={(cfg.range.history ?? "minimal") === h.value ? "seg-on" : ""}
                  onClick={() => setRange({ history: h.value })}
                >
                  {h.label}
                </button>
              ))}
            </div>
            {cfg.range.history === "bars" && (
              <label className="al-row">
                <span>History bars</span>
                <input
                  type="number"
                  min={1}
                  value={cfg.range.historyBars ?? 500}
                  onKeyDown={blockNegKeys}
                  onChange={(e) => setRange({ historyBars: Number(cleanNumInput(e.currentTarget)) })}
                  onBlur={(e) => clampPosOnBlur(e.currentTarget, 1, (n) => setRange({ historyBars: n }))}
                />
              </label>
            )}
            <WindowTimeline cfg={cfg} resolution={effectiveRes} />
          </Section>
            </section>

            <section className="bt-scroll-section" ref={setRef("strategy")}>
              {/* The whole side view takes on the side's identity colour — long =
                  the chart's up/green, short = down/red — via one --side variable.
                  Parking greys it out (data-parked). */}
              <div
                className="bt-strategy"
                style={{ "--side": side === "long" ? "var(--pos)" : "var(--neg)" } as CSSProperties}
                data-parked={(side === "long" ? cfg.longEnabled : cfg.shortEnabled) === false}
              >
          <div className="bt-subtabs" role="tablist" aria-label="Strategy mode">
            <button
              className={(cfg.mode ?? "rules") === "rules" ? "on" : ""}
              onClick={() => {
                // Sweep axes are mode-scoped (`param:`/`risk:` in coded, `rule:`
                // in rules) and persisted per context, so each mode switch swaps
                // to the target mode's own persisted set (restored on switch-back).
                // This keeps the other mode's axes out of applySweepCombo, which
                // would silently ignore them or send the backend a rejected combo.
                setSweepAxes(pruneSweepAxes(loadSweepAxes(sweepContext("rules", null)), cfg));
                setCfg({ ...cfg, mode: "rules" });
              }}
            >
              User Defined
            </button>
            <button
              className={cfg.mode === "coded" ? "on" : ""}
              onClick={() => {
                setSweepAxes(pruneSweepAxes(loadSweepAxes(sweepContext("coded", cfg.codedStrategy)), codedCfg));
                setCfg({ ...cfg, mode: "coded" });
              }}
            >
              Built-in
            </button>
          </div>
          {cfg.mode === "coded" ? (
            <>
              <StrategyPicker
                value={cfg.codedStrategy}
                onChange={(filename) => setCfg({ ...cfg, codedStrategy: filename })}
                list={strategyList}
                loadError={strategyListError}
                onReload={reloadStrategies}
              />
              <StrategyParams
                specs={selectedStrategy?.params ?? []}
                values={resolveParamValues(selectedStrategy?.params ?? [], codedCfg.params)}
                onChange={(params) => updateCoded({ ...codedCfg, params })}
                sweep={{ axes: displayAxes, onToggle: toggleSweepAxis, onAxisChange: patchAxis }}
              />
              {paramError && <div className="al-note bt-param-error">{paramError}</div>}
              {(["long", "short"] as const).map((s) => {
                const isLong = s === "long";
                return (
                  <div key={s} style={{ "--side": isLong ? "var(--pos)" : "var(--neg)" } as CSSProperties}>
                    <RuleGroupSection
                      title={isLong ? "Sell to close" : "Buy to close"}
                      info={`Conditions that close an open ${s} position. A stop or target can close it first.`}
                      group={isLong ? codedCfg.longExit : codedCfg.shortExit}
                      onChange={(g) => updateCoded({ ...codedCfg, [isLong ? "longExit" : "shortExit"]: g })}
                      emptyHint={`No ${s}-exit rules, so an open ${s} holds until the trading window ends.`}
                      defaultAvwapAnchor={defaultAvwapAnchor}
                      baseResolution={effectiveRes}
                      clipboard={clipboard}
                      onCopy={(rule) => setClipboard(cloneRule(rule))}
                      groupClipboard={groupClipboard}
                      onCopyAll={(rules) => setGroupClipboard(rules.map(cloneRule))}
                      openChartPicker={openChartPicker}
                      isExit
                    />
                    <RiskSection
                      risk={(isLong ? codedCfg.longRisk : codedCfg.shortRisk) ?? EMPTY_RISK}
                      onChange={(r) => updateCoded({ ...codedCfg, ...riskPatch(riskSyncOn(codedCfg), s, r) })}
                      sweep={{
                        axes: displayAxes,
                        side: s,
                        onToggle: toggleRiskSweepAxis,
                        // Synced: the axis lives on the long side regardless of
                        // which block's kind dropdown changed — drop both sides'.
                        onKindChange: (field) => {
                          const sides = riskSyncOn(codedCfg) ? (["long", "short"] as const) : ([s] as const);
                          setSweepAxes((axes) =>
                            axes.filter((a) => !sides.some((sd) => a.target.startsWith(`risk:${sd}.${field}.`))));
                        },
                        onAxisChange: patchAxis,
                      }}
                      sync={{
                        on: riskSyncOn(codedCfg),
                        onToggle: () => {
                          const on = !riskSyncOn(codedCfg);
                          updateCoded(applyRiskSync({ ...codedCfg, riskSynced: on }, s));
                          // Axes created per-side while unsynced move to the
                          // canonical long side (deduped) so they keep sweeping
                          // — and now mirror — after the switch.
                          if (on) setSweepAxes((axes) => {
                            const remapped = axes.map((a) =>
                              a.target.startsWith("risk:short.")
                                ? { ...a, target: a.target.replace(/^risk:short\./, "risk:long.") }
                                : a);
                            return remapped.filter((a, i) => remapped.findIndex((b) => b.target === a.target) === i);
                          });
                        },
                      }}
                    />
                  </div>
                );
              })}
              <div className="al-note">
                When set here, stop/target overrides any sl=/tp= the strategy file passes.
              </div>
            </>
          ) : (
            <>
          <div className="bt-side-row">
            <div className="bt-side-tabs seg">
              <button
                className={`bt-side-long${side === "long" ? " seg-on" : ""}`}
                onClick={() => selectSide("long")}
              >
                <span className={`bt-side-dot${cfg.longEnabled === false ? " off" : ""}`} aria-hidden="true" />
                Long
              </button>
              <button
                className={`bt-side-short${side === "short" ? " seg-on" : ""}`}
                onClick={() => selectSide("short")}
              >
                <span className={`bt-side-dot${cfg.shortEnabled === false ? " off" : ""}`} aria-hidden="true" />
                Short
              </button>
            </div>
            {/* Arm switch for the side being edited — parking keeps a side's rules
                but stops it opening/closing positions. The aria-label + aria-checked
                carry the accessible name and on/off; the state word is decorative.
                The switch and its state word are one right-aligned control group. */}
            <div className="bt-arm-group">
              <button
                type="button"
                role="switch"
                aria-checked={sideEnabled}
                aria-label={`Trade the ${side} side`}
                className={`bt-switch${sideEnabled ? " on" : ""}`}
                onClick={() => setCfg({ ...cfg, [side === "long" ? "longEnabled" : "shortEnabled"]: !sideEnabled })}
              >
                <span className="bt-switch-knob" />
              </button>
              <span className={`bt-arm-state${sideEnabled ? " on" : ""}`} aria-hidden="true">{sideEnabled ? "Trading" : "Parked"}</span>
            </div>
          </div>
          <SidePanel
            side={side}
            cfg={cfg}
            setCfg={setCfg}
            setGroup={setGroup}
            defaultAvwapAnchor={defaultAvwapAnchor}
            baseResolution={effectiveRes}
            clipboard={clipboard}
            onCopy={(rule) => setClipboard(cloneRule(rule))}
            groupClipboard={groupClipboard}
            onCopyAll={(rules) => setGroupClipboard(rules.map(cloneRule))}
            openChartPicker={openChartPicker}
            sweep={{
              axes: displayAxes,
              side,
              onToggle: toggleRuleSweepAxis,
              onToggleOp: toggleOpSweepAxis,
              onTickOp: tickOpOption,
              onToggleRisk: toggleRiskSweepAxis,
              // Dropping a stop/target kind drops its stale value/mult axis so a
              // now-unread field can't sweep N identical rows (matches coded mode).
              onKindChange: (field) => {
                const sides = riskSyncOn(cfg) ? (["long", "short"] as const) : ([side] as const);
                setSweepAxes((axes) =>
                  axes.filter((a) => !sides.some((sd) => a.target.startsWith(`risk:${sd}.${field}.`))));
              },
              onAxisChange: patchAxis,
            }}
          />

          {usesVolume && (
            <div className="al-note">
              Volume-based operands (Volume, Volume-MA, AVWAP) read 0 on epics that don't report
              trade volume (e.g. many forex/CFD instruments), so they never fire there.
            </div>
          )}
            </>
          )}
              </div>
            </section>

            <section className="bt-scroll-section" ref={setRef("costs")}>
          <Section
            title="Costs"
            info="Per-trade assumptions applied to every fill: position size, commission, slippage, and the starting balance the equity curve builds from."
          >
            <div className="bt-costs-grid">
              <label className="bt-field">
                <span className="bt-field-label">
                  Quantity
                  <InfoTip text="Units bought or sold per trade." />
                </span>
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={cfg.costs.quantity}
                  onKeyDown={blockNegKeys}
                  onChange={(e) => setCosts({ quantity: Number(cleanNumInput(e.currentTarget)) })}
                  onBlur={(e) => clampPosOnBlur(e.currentTarget, 1, (n) => setCosts({ quantity: n }))}
                />
              </label>
              <label className="bt-field">
                <span className="bt-field-label">
                  Commission/side
                  <InfoTip text="Flat cost charged on each entry and each exit, so a round trip pays it twice." />
                </span>
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={cfg.costs.commissionPerSide}
                  onChange={(e) => setCosts({ commissionPerSide: Number(cleanNumInput(e.currentTarget)) })}
                />
              </label>
              {/* These fields carry an InfoTip button inside the label, which a
                  wrapping <label> would associate with instead of the input, so
                  they use a div + explicit aria-label on the control. */}
              <div className="bt-field">
                <span className="bt-field-label">
                  Slippage
                  <InfoTip text="Price penalty on every fill, in the instrument's price units: you buy a bit higher and sell a bit lower." />
                </span>
                <NumberField
                  ariaLabel="Slippage"
                  value={cfg.costs.slippage.value}
                  onChange={(n) => setInstrumentCost({ slippage: { ...cfg.costs.slippage, value: n } })}
                />
              </div>
              <div className="bt-field">
                <span className="bt-field-label">
                  Slippage model
                  <InfoTip text="Fixed charges the same slippage on every fill. ATR-scaled adds a multiple of ATR(14) of the fill bar, so fast markets cost more." />
                </span>
                <select
                  aria-label="Slippage model"
                  value={cfg.costs.slippage.kind}
                  onChange={(e) =>
                    setInstrumentCost({ slippage: { ...cfg.costs.slippage, kind: e.currentTarget.value as SlippageModel["kind"] } })
                  }
                >
                  <option value="fixed">Fixed</option>
                  <option value="atr">ATR-scaled</option>
                </select>
              </div>
              {cfg.costs.slippage.kind === "atr" && (
                <div className="bt-field">
                  <span className="bt-field-label">
                    x ATR
                    <InfoTip text="Per-fill slippage is base + multiplier x ATR(14) of the bar, so fast markets cost more." />
                  </span>
                  <NumberField
                    ariaLabel="Slippage ATR multiplier"
                    value={cfg.costs.slippage.atrMult}
                    onChange={(n) => setInstrumentCost({ slippage: { ...cfg.costs.slippage, atrMult: n } })}
                  />
                </div>
              )}
              <label className="bt-field">
                <span className="bt-field-label">
                  Starting cash
                  <InfoTip text="Opening account balance the equity curve and return % build from." />
                </span>
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={cfg.costs.startingCash}
                  onKeyDown={blockNegKeys}
                  onChange={(e) => setCosts({ startingCash: Number(cleanNumInput(e.currentTarget)) })}
                  onBlur={(e) => clampPosOnBlur(e.currentTarget, 1, (n) => setCosts({ startingCash: n }))}
                />
              </label>

              {/* Instrument costs: broker-prefilled per-epic spread and financing.
                  A full-width sub-heading and source note bracket the fields. */}
              <div className="bt-costs-subhead" style={{ gridColumn: "1 / -1" }}>
                Instrument costs
              </div>
              <div className="bt-field">
                <span className="bt-field-label">
                  Spread
                  <InfoTip text="Full bid/ask spread in price units. Buys fill half a spread above the mid, sells half below." />
                </span>
                <NumberField
                  ariaLabel="Spread"
                  value={cfg.costs.spread}
                  onChange={(n) => setInstrumentCost({ spread: n })}
                />
              </div>
              <div className="bt-field">
                <span className="bt-field-label">
                  Long %/night
                  <InfoTip text="Charged per night a position is held (21:00 UTC rollover), as a percent of entry notional. Positive is a cost, negative a credit. Enter your broker's rate; fees are not fetched automatically." />
                </span>
                <NumberField
                  ariaLabel="Long %/night"
                  signed
                  value={cfg.costs.finLongDailyPct}
                  onChange={(n) => setInstrumentCost({ finLongDailyPct: n })}
                />
              </div>
              <div className="bt-field">
                <span className="bt-field-label">
                  Short %/night
                  <InfoTip text="Charged per night a position is held (21:00 UTC rollover), as a percent of entry notional. Positive is a cost, negative a credit. Enter your broker's rate; fees are not fetched automatically." />
                </span>
                <NumberField
                  ariaLabel="Short %/night"
                  signed
                  value={cfg.costs.finShortDailyPct}
                  onChange={(n) => setInstrumentCost({ finShortDailyPct: n })}
                />
              </div>
              <div className="bt-costs-source" style={{ gridColumn: "1 / -1" }}>
                <span className="bt-costs-source-note">
                  {costProfile?.source === "broker" ? "from broker quote" : "manual"}
                </span>
                <Tooltip content="Refetch spread from the broker">
                  <button type="button" className="icon-btn bt-costs-refetch" aria-label="Refetch from broker" onClick={refetchCosts}>
                    ↻
                  </button>
                </Tooltip>
              </div>
            </div>
          </Section>
            </section>

            <section className="bt-scroll-section" ref={setRef("presets")}>
          <Section
            title="Presets"
            info="Save the whole configuration (range, mask, rules, risk, costs) under a name to reload later."
          >
            <div className="bt-presets">
              <div className="al-row">
                <span>Save as</span>
                <input
                  value={presetName}
                  placeholder="Strategy name"
                  onChange={(e) => setPresetName(e.target.value)}
                />
                <button className="ghost" onClick={savePreset} disabled={!presetName.trim()}>
                  Save
                </button>
              </div>
              <div className="al-row">
                <span>Load</span>
                <select value={loadName} onChange={(e) => setLoadName(e.target.value)}>
                  <option value="">Choose a preset…</option>
                  {Object.keys(presets).map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
                <button className="ghost" onClick={() => applyPreset(loadName)} disabled={!loadName}>
                  Load
                </button>
                <button className="ghost" onClick={() => removePreset(loadName)} disabled={!loadName}>
                  Delete
                </button>
              </div>
            </div>
          </Section>
            </section>
          </div>
        </div>

        {!sideBySide && !split.collapsed && (
          <div
            className="bt-split-divider"
            role="separator"
            aria-orientation="horizontal"
            onPointerDown={startResize}
            onPointerMove={onResize}
            onPointerUp={endResize}
          >
            <span className="bt-split-grip" aria-hidden="true" />
          </div>
        )}

        {!sideBySide && (
          <div className={`bt-results-region${split.collapsed ? " collapsed" : ""}`} style={resultsStyle}>
            <div className="bt-results-head-row">
              <button className="bt-results-toggle" onClick={toggleResults} aria-expanded={!split.collapsed}>
                <span className={`bt-results-chevron${split.collapsed ? " collapsed" : ""}`} aria-hidden="true">
                  ▾
                </span>
                Results
              </button>
              <span className="bt-results-head-actions">{modeSeg}</span>
            </div>
            {!split.collapsed && resultsBody}
          </div>
        )}
        </div>

        <div className="modal-foot bt-cfg-foot">
          <RunBar
            lead={
              <Tooltip content={sideBySide ? "Dock results back into the panel" : "Show results in a side column"}>
                <button
                  className="bt-results-layout-btn"
                  aria-label={sideBySide ? "Dock results back into the panel" : "Show results in a side column"}
                  onClick={() => setResultsSideBySide(!sideBySide)}
                >
                  <ColumnGlyph flipped={sideBySide} />
                </button>
              </Tooltip>
            }
            sweepInfo={<>
              {holdout && (
                <span className="sweep-counter bt-holdout-badge">
                  Holdout: last {holdout.pct}% reserved
                </span>
              )}
              {btMode === "sweep" && sweepAxes.length === 0 && (
                <span className="sweep-counter">Turn on a field's sweep toggle to run</span>
              )}
              {/* No per-axis breakdown or "runs sampled" counter here: the
                  footer shows ONLY the total combo count (user decision). */}
              {btMode === "sweep" && sweepAxes.length > 0 && (
                <span className={`bt-sweep-estimate${effectiveWarn ? " bt-sweep-warn" : ""}`}>
                  {/* The number carries the weight; the unit stays quiet. The
                      space keeps textContent reading "275 combos". */}
                  <strong>{isFinite(effectiveCombos) ? effectiveCombos : "∞"}</strong>{" "}
                  {effectiveCombos === 1 ? "combo" : "combos"}
                </span>
              )}
              {/* Duration follows the Run button: the docked column's footer
                  shows it while the column is open, so skip it here then. */}
              {!sideBySide && durationInfo}
              {pastSweepsPicker}
              {btMode === "sweep" && sweepAxes.length > 0 && (
                <span className="bt-search-toggle">
                  <Tooltip content={[
                    "Grid: run every combination of the ranges.",
                    "Random: sample N combos (same ranges + N draw the same sample).",
                  ]}>
                    <select
                      className="bt-search-select"
                      aria-label="Search strategy"
                      value={searchMode}
                      onChange={(e) => setSearchMode(e.currentTarget.value as "grid" | "random")}
                    >
                      <option value="grid">Grid</option>
                      <option value="random">Random</option>
                    </select>
                  </Tooltip>
                  {searchMode === "random" && (
                    <label className="bt-random-n">
                      <span>N</span>
                      <input
                        type="number"
                        min={10}
                        value={randomN}
                        onKeyDown={blockNegKeys}
                        onChange={(e) => setRandomN(Number(cleanNumInput(e.currentTarget)))}
                        onBlur={(e) => clampPosOnBlur(e.currentTarget, 10, setRandomN)}
                      />
                    </label>
                  )}
                </span>
              )}
              {btMode === "sweep" && sweepAxes.length > 0 && remoteCompute && (
                <span className="bt-compute-toggle">
                  <Tooltip content={[
                    "Local: run the sweep on this machine.",
                    "Remote: run the sweep on the remote compute host.",
                  ]}>
                    <select
                      className="bt-search-select"
                      aria-label="Compute target"
                      value={sweepTarget}
                      onChange={(e) => {
                        const t = e.currentTarget.value as "local" | "remote";
                        sweepTargetSignal.set(t);
                        saveSweepTarget(t);
                      }}
                    >
                      <option value="local">Local</option>
                      <option value="remote">Remote</option>
                    </select>
                  </Tooltip>
                  {/* Host status + Start/Stop live in the toolbar's ComputeHostButton
                      now (single manual control); no chip here. */}
                </span>
              )}
            </>}
            runClusterLead={sideBySide ? null : runClusterLead}
            onGoLive={() => requestGoLive(cfg)}
            runLabel={runLabel}
            runDisabled={runDisabled}
            onRun={sideBySide ? undefined : runFromFooter}
          />
        </div>
    </aside>
      {pickerFor && (
        <ChartOperandPicker
          sources={pickerSources}
          onPick={(op) => { pickerFor(op); setPickerFor(null); }}
          onClose={() => setPickerFor(null)}
          onHoverSource={handleHoverSource}
        />
      )}
    </>
  );
}

// Results-column icon: a panel with a column pane on the left and an arrow
// pointing at it — results pop out INTO that column. `flipped` mirrors the
// whole icon for the closing direction (pane on the right = the config panel,
// arrow pointing right = results dock back into it). `currentColor` so it
// inherits the button's colour.
function ColumnGlyph({ flipped = false }: { flipped?: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="15"
      height="15"
      aria-hidden="true"
      style={flipped ? { transform: "scaleX(-1)" } : undefined}
    >
      <g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
        <path d="M5.5 2.5 V13.5" />
        <path d="M12.5 8 H8.2" />
        <path d="M10.2 5.9 L8 8 L10.2 10.1" />
      </g>
    </svg>
  );
}

// Sweep toggle icon: three equalizer faders at staggered heights — a parameter
// sweep tunes a value across a range of settings. `currentColor` so it inherits
// the button's colour, including the accent when the axis is on (.sp-sweep.on).
function SweepGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" className="bt-sweep-icon">
      <g fill="none" stroke="currentColor" strokeLinecap="round">
        <path d="M4 2.5 V13.5 M8 2.5 V13.5 M12 2.5 V13.5" strokeWidth="1.2" opacity="0.55" />
        <path d="M2.4 9 H5.6 M6.4 5 H9.6 M10.4 10.5 H13.6" strokeWidth="2.2" />
      </g>
    </svg>
  );
}

// The stop/target block for one side. A stop is one dropdown (fixed %/price/ATR
// or trailing %/ATR); a target is the same minus the trailing kinds. Off by
// default (kind "none") so existing presets are untouched. ATR kinds expose a
// length (default 14); % / trailing % expose a percent; ATR kinds expose a
// multiple; fixed price exposes an absolute level.
export function RiskSection({
  risk,
  onChange,
  sweep,
  sync,
}: {
  risk: RiskConfig;
  onChange: (r: RiskConfig) => void;
  // Task 10: optional per-side sweep toggle for the value/mult numeric fields.
  // Undefined (rule mode, Live panel) renders exactly as before.
  sweep?: {
    axes: SweepAxis[];
    side: "long" | "short";
    onToggle: (target: string, current: number) => void;
    onKindChange: (field: "stop" | "target") => void;
    onAxisChange: (target: string, patch: Partial<Pick<RangeAxis, "from" | "to" | "step">>) => void;
  };
  // "Same for long & short" header toggle. The caller owns the mirroring —
  // this component just renders the checkbox and reports clicks. Undefined
  // hides the toggle (surfaces with no per-side risk concept).
  sync?: { on: boolean; onToggle: () => void };
}) {
  // Changing a kind drops any sweep axis on that field: the axis target
  // doesn't encode the kind, so a stale `stop.value` axis under an ATR stop
  // would sweep a field the engine never reads (N identical rows), and under
  // none/none the whole risk is stripped and the backend 422s every chunk.
  const setStopKind = (kind: StopKind) => {
    sweep?.onKindChange("stop");
    const next: RiskConfig["stop"] = { kind };
    if (kind === "atr" || kind === "trailAtr") { next.mult = risk.stop.mult ?? 2; next.length = risk.stop.length ?? 14; }
    else if (kind === "pct" || kind === "trailPct") next.value = risk.stop.value ?? 2;
    else if (kind === "price") next.value = risk.stop.value ?? 0;
    onChange({ ...risk, stop: next });
  };
  const setTargetKind = (kind: TargetKind) => {
    sweep?.onKindChange("target");
    const next: RiskConfig["target"] = { kind };
    if (kind === "atr") { next.mult = risk.target.mult ?? 3; next.length = risk.target.length ?? 14; }
    else if (kind === "pct") next.value = risk.target.value ?? 4;
    else if (kind === "price") next.value = risk.target.value ?? 0;
    onChange({ ...risk, target: next });
  };
  // `floor` opts a field into positive-only: block negatives and snap ≤0 up to
  // the floor on blur. Left off for price levels / ATR multiples, which are free.
  const num = (v: number | undefined, set: (n: number) => void, step = "any", floor?: number, disabled = false) =>
    // Decimal fields go through NumberField so the dot is always the decimal
    // separator regardless of locale (native number inputs follow the locale and
    // reject "." on comma-decimal machines). Integer fields ("1" step) have no
    // separator to worry about, so keep the native input and its spinner.
    step === "any" ? (
      <NumberField value={v} onChange={set} floor={floor} className="bt-num" disabled={disabled} />
    ) : (
      <input type="number" step={step} value={v ?? 0} className="bt-num" min={floor} disabled={disabled}
        onKeyDown={floor != null ? blockNegKeys : undefined}
        onChange={(e) => set(Number(cleanNumInput(e.currentTarget)))}
        onBlur={floor != null ? (e) => clampPosOnBlur(e.currentTarget, floor, set) : undefined} />
    );

  // Sweep toggle (equalizer glyph) next to a stop/target value or ATR mult — mirrors
  // StrategyParams' per-param toggle. Only rendered when the caller (coded
  // mode) passed a `sweep` prop; absent in rule mode / the Live panel.
  // Synced SL/TP canonicalizes risk axes to the long side: both sides' toggle
  // buttons light for that one axis, and its chip renders wherever the field
  // renders, so both sides show the same synced range.
  const sweepSide = sync?.on ? "long" : sweep?.side;
  const swept = (field: "stop" | "target", prop: "value" | "mult") =>
    sweep?.axes.some((a) => a.target === `risk:${sweepSide}.${field}.${prop}`) ?? false;
  const sweepBtn = (field: "stop" | "target", prop: "value" | "mult", current: number) =>
    sweep && (
      <Tooltip content="Sweep this field">
        <button
          type="button"
          className={`sp-sweep${swept(field, prop) ? " on" : ""}`}
          onClick={() => sweep.onToggle(`risk:${sweepSide}.${field}.${prop}`, current)}
        >
          <SweepGlyph />
        </button>
      </Tooltip>
    );

  return (
    <div className="bt-risk">
      <SectionTitle
        info={sync?.on
          ? "Price-level exits. The trade ends on whichever triggers first: stop, target, or a close rule. Synced: edits here apply to both long and short."
          : "Price-level exits for this side. The trade ends on whichever triggers first: stop, target, or a close rule."}
        extra={sync && (
          <label className="bt-risk-sync">
            <input type="checkbox" checked={sync.on} onChange={sync.onToggle} />
            Same for long &amp; short
          </label>
        )}
      >
        Stop &amp; take profit
      </SectionTitle>
      <div className="bt-risk-row">
        <span className="bt-risk-label">Stop</span>
        <select value={risk.stop.kind} onChange={(e) => setStopKind(e.target.value as StopKind)}>
          {STOP_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
        {(risk.stop.kind === "pct" || risk.stop.kind === "trailPct") && (() => {
          const axis = sweep?.axes.find(
            (a): a is RangeAxis => a.kind === "range" && a.target === `risk:${sweepSide}.stop.value`);
          return axis && sweep ? (
            <>
              <SweepBaseValue>{risk.stop.value ?? 2}</SweepBaseValue>
              <RangeChip
                axis={axis}
                onPatch={(p) => sweep.onAxisChange(axis.target, p)}
                onRemove={() => sweep.onToggle(axis.target, risk.stop.value ?? 2)}
              />
              <span>%</span>
            </>
          ) : (
            <>
              {num(risk.stop.value, (n) => onChange({ ...risk, stop: { ...risk.stop, value: n } }), "any", 0.01)}
              <span>%</span>
              {sweepBtn("stop", "value", risk.stop.value ?? 2)}
            </>
          );
        })()}
        {(risk.stop.kind === "atr" || risk.stop.kind === "trailAtr") && (() => {
          const axis = sweep?.axes.find(
            (a): a is RangeAxis => a.kind === "range" && a.target === `risk:${sweepSide}.stop.mult`);
          return axis && sweep ? (
            <>
              <SweepBaseValue>{risk.stop.mult ?? 2}</SweepBaseValue>
              <RangeChip
                axis={axis}
                onPatch={(p) => sweep.onAxisChange(axis.target, p)}
                onRemove={() => sweep.onToggle(axis.target, risk.stop.mult ?? 2)}
              />
              <span>× ATR</span>
              {num(risk.stop.length, (n) => onChange({ ...risk, stop: { ...risk.stop, length: Math.max(1, Math.round(n)) } }), "1")}
            </>
          ) : (
            <>
              {num(risk.stop.mult, (n) => onChange({ ...risk, stop: { ...risk.stop, mult: n } }), "any")}
              <span>× ATR</span>
              {num(risk.stop.length, (n) => onChange({ ...risk, stop: { ...risk.stop, length: Math.max(1, Math.round(n)) } }), "1")}
              {sweepBtn("stop", "mult", risk.stop.mult ?? 2)}
            </>
          );
        })()}
        {risk.stop.kind === "price" &&
          num(risk.stop.value, (n) => onChange({ ...risk, stop: { ...risk.stop, value: n } }))}
      </div>
      <div className="bt-risk-row">
        <span className="bt-risk-label">Take profit</span>
        <select value={risk.target.kind} onChange={(e) => setTargetKind(e.target.value as TargetKind)}>
          {TARGET_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
        {risk.target.kind === "pct" && (() => {
          const axis = sweep?.axes.find(
            (a): a is RangeAxis => a.kind === "range" && a.target === `risk:${sweepSide}.target.value`);
          return axis && sweep ? (
            <>
              <SweepBaseValue>{risk.target.value ?? 4}</SweepBaseValue>
              <RangeChip
                axis={axis}
                onPatch={(p) => sweep.onAxisChange(axis.target, p)}
                onRemove={() => sweep.onToggle(axis.target, risk.target.value ?? 4)}
              />
              <span>%</span>
            </>
          ) : (
            <>
              {num(risk.target.value, (n) => onChange({ ...risk, target: { ...risk.target, value: n } }), "any", 0.01)}
              <span>%</span>
              {sweepBtn("target", "value", risk.target.value ?? 4)}
            </>
          );
        })()}
        {risk.target.kind === "atr" && (() => {
          const axis = sweep?.axes.find(
            (a): a is RangeAxis => a.kind === "range" && a.target === `risk:${sweepSide}.target.mult`);
          return axis && sweep ? (
            <>
              <SweepBaseValue>{risk.target.mult ?? 3}</SweepBaseValue>
              <RangeChip
                axis={axis}
                onPatch={(p) => sweep.onAxisChange(axis.target, p)}
                onRemove={() => sweep.onToggle(axis.target, risk.target.mult ?? 3)}
              />
              <span>× ATR</span>
              {num(risk.target.length, (n) => onChange({ ...risk, target: { ...risk.target, length: Math.max(1, Math.round(n)) } }), "1")}
            </>
          ) : (
            <>
              {num(risk.target.mult, (n) => onChange({ ...risk, target: { ...risk.target, mult: n } }), "any")}
              <span>× ATR</span>
              {num(risk.target.length, (n) => onChange({ ...risk, target: { ...risk.target, length: Math.max(1, Math.round(n)) } }), "1")}
              {sweepBtn("target", "mult", risk.target.mult ?? 3)}
            </>
          );
        })()}
        {risk.target.kind === "price" &&
          num(risk.target.value, (n) => onChange({ ...risk, target: { ...risk.target, value: n } }))}
      </div>
    </div>
  );
}

// Max-concurrent-positions + min-spacing controls for one side. Collapsed by
// default (a <details>) so the common single-position case stays out of the
// way; off by default via DEFAULT_SCALING (maxConcurrent: 1, no spacing) so
// existing presets behave exactly as before.
function ScalingSection({
  scaling,
  onChange,
}: {
  scaling: ScalingConfig;
  onChange: (s: ScalingConfig) => void;
}) {
  const spacingKind = scaling.spacing?.kind ?? "none";
  const setSpacingKind = (k: "none" | "pct" | "atr") => {
    if (k === "none") return onChange({ ...scaling, spacing: undefined });
    if (k === "pct") return onChange({ ...scaling, spacing: { kind: "pct", value: scaling.spacing?.value ?? 1 } });
    onChange({ ...scaling, spacing: { kind: "atr", mult: scaling.spacing?.mult ?? 1, length: scaling.spacing?.length ?? 14 } });
  };
  return (
    <div className="bt-scaling">
      <SectionTitle info="Allow more than one open position on this side, and set the minimum price spacing between successive entries.">
        Scaling &amp; management
      </SectionTitle>
      <div className="bt-risk-row">
        <span className="bt-risk-label">Max positions</span>
        <input type="number" min={1} step="1" className="bt-num" value={scaling.maxConcurrent}
          onKeyDown={blockNegKeys}
          onChange={(e) => onChange({ ...scaling, maxConcurrent: Math.round(Number(cleanNumInput(e.currentTarget))) })}
          onBlur={(e) => clampPosOnBlur(e.currentTarget, 1, (n) => onChange({ ...scaling, maxConcurrent: n }))} />
      </div>
      <div className="bt-risk-row">
        <span className="bt-risk-label">Min spacing</span>
        <select value={spacingKind} onChange={(e) => setSpacingKind(e.target.value as "none" | "pct" | "atr")}>
          <option value="none">None</option><option value="pct">%</option><option value="atr">ATR ×</option>
        </select>
        {scaling.spacing?.kind === "pct" &&
          <>{<input type="number" step="any" className="bt-num" value={scaling.spacing.value ?? 0}
            onChange={(e) => onChange({ ...scaling, spacing: { kind: "pct", value: Number(cleanNumInput(e.currentTarget)) } })} />}<span>%</span></>}
        {scaling.spacing?.kind === "atr" && <>
          <input type="number" step="any" className="bt-num" value={scaling.spacing.mult ?? 0}
            onChange={(e) => onChange({ ...scaling, spacing: { ...scaling.spacing!, kind: "atr", mult: Number(cleanNumInput(e.currentTarget)) } })} />
          <span>× ATR</span>
          <input type="number" step="1" className="bt-num" value={scaling.spacing.length ?? 14}
            onChange={(e) => onChange({ ...scaling, spacing: { ...scaling.spacing!, kind: "atr", length: Math.max(1, Math.round(Number(cleanNumInput(e.currentTarget)))) } })} />
        </>}
      </div>
    </div>
  );
}

// One side of the strategy (long or short): an arm switch that parks the whole
// side without losing its rules, above that side's entry/exit rule groups.
// Parking dims the rules but keeps them editable, so you can set a side up
// before you switch it on. Long and short are structurally identical, so both
// render through here rather than being copy-pasted.
function SidePanel({
  side,
  cfg,
  setCfg,
  setGroup,
  defaultAvwapAnchor,
  baseResolution,
  clipboard,
  onCopy,
  groupClipboard,
  onCopyAll,
  openChartPicker,
  sweep,
}: {
  side: "long" | "short";
  cfg: BacktestConfig;
  setCfg: (c: BacktestConfig) => void;
  setGroup: (which: "longEntry" | "longExit" | "shortEntry" | "shortExit", g: RuleGroup) => void;
  defaultAvwapAnchor: number;
  baseResolution: string;
  clipboard: Rule | null;
  onCopy: (rule: Rule) => void;
  groupClipboard: Rule[] | null;
  onCopyAll: (rules: Rule[]) => void;
  // Absent in surfaces with no chart to pick from (e.g. the Live panel) — the
  // affordances that need it simply don't render.
  openChartPicker?: (onPick: (op: Operand) => void) => void;
  // Task 9: optional per-operand-field sweep toggle for rule mode. Undefined
  // (coded mode's own RuleGroupSection use, the Live panel) renders as before.
  // `onToggleRisk` / `onKindChange` carry the SL/TP sweep toggle for the risk
  // block — separate from the rule-operand toggle (% step heuristic, drops
  // stale axes on a stop/target kind change).
  sweep?: {
    axes: SweepAxis[];
    side: "long" | "short";
    onToggle: (target: string, current: number) => void;
    onToggleRisk: (target: string, current: number) => void;
    onKindChange: (field: "stop" | "target") => void;
    onAxisChange: (target: string, patch: Partial<Pick<RangeAxis, "from" | "to" | "step">>) => void;
    onToggleOp: (target: string, current: Operator) => void;
    onTickOp: (target: string, op: Operator) => void;
  };
}) {
  const isLong = side === "long";
  const enabled = (isLong ? cfg.longEnabled : cfg.shortEnabled) !== false;
  const entry = isLong ? cfg.longEntry : cfg.shortEntry;
  const exit = isLong ? cfg.longExit : cfg.shortExit;

  return (
    <>
      {/* The arm switch now lives beside the Long/Short tabs in the parent; this
          panel keeps only the inert wrapper. */}
      {/* When the side is parked, `inert` makes every rule/field/button inside
          non-interactive (pointer AND keyboard) — the switch above stays live so
          it can be turned back on. `.bt-parked` supplies the dimmed visual cue. */}
      <div className={`bt-side-rules${enabled ? "" : " bt-parked"}`} inert={!enabled}>
        <RuleGroupSection
          title={isLong ? "Buy to open" : "Sell to open"}
          info={`Conditions that open a ${side} position. Multiple rules combine with the AND/OR switch.`}
          group={entry}
          onChange={(g) => setGroup(isLong ? "longEntry" : "shortEntry", g)}
          emptyHint={`No ${side}-entry rules, so this strategy won't open any ${side} positions.`}
          defaultAvwapAnchor={defaultAvwapAnchor}
          baseResolution={baseResolution}
          clipboard={clipboard}
          onCopy={onCopy}
          groupClipboard={groupClipboard}
          onCopyAll={onCopyAll}
          openChartPicker={openChartPicker}
          sweep={sweep && { ...sweep, group: "entry" }}
        />
        <RuleGroupSection
          title={isLong ? "Sell to close" : "Buy to close"}
          info={`Conditions that close an open ${side} position. A stop or target can close it first.`}
          group={exit}
          onChange={(g) => setGroup(isLong ? "longExit" : "shortExit", g)}
          emptyHint={`No ${side}-exit rules, so an open ${side} holds until the trading window ends.`}
          defaultAvwapAnchor={defaultAvwapAnchor}
          baseResolution={baseResolution}
          clipboard={clipboard}
          onCopy={onCopy}
          groupClipboard={groupClipboard}
          onCopyAll={onCopyAll}
          openChartPicker={openChartPicker}
          isExit
          sweep={sweep && { ...sweep, group: "exit" }}
        />
        <RiskSection
          risk={(isLong ? cfg.longRisk : cfg.shortRisk) ?? EMPTY_RISK}
          onChange={(r) => setCfg({ ...cfg, ...riskPatch(riskSyncOn(cfg), side, r) })}
          sweep={sweep && {
            axes: sweep.axes,
            side: sweep.side,
            onToggle: sweep.onToggleRisk,
            onKindChange: sweep.onKindChange,
            onAxisChange: sweep.onAxisChange,
          }}
          sync={{
            on: riskSyncOn(cfg),
            // Turning sync ON copies the side being viewed across; OFF just
            // stops mirroring, both sides keep their (identical) values.
            onToggle: () => setCfg(applyRiskSync({ ...cfg, riskSynced: !riskSyncOn(cfg) }, side)),
          }}
        />
        <ScalingSection
          scaling={(isLong ? cfg.longScaling : cfg.shortScaling) ?? DEFAULT_SCALING}
          onChange={(s) => setCfg({ ...cfg, [isLong ? "longScaling" : "shortScaling"]: s })}
        />
      </div>
    </>
  );
}

// A section heading with an optional ⓘ that explains what the section does.
// Shared by <Section> and the risk/scaling blocks so every heading tips the
// same way.
function SectionTitle({ info, extra, children }: { info?: string | Array<string | ReactNode>; extra?: ReactNode; children: ReactNode }) {
  return (
    <div className="instrument-section-title bt-section-title">
      <span>{children}</span>
      {info && <InfoTip text={info} />}
      {extra}
    </div>
  );
}

// Remember which sections the user collapsed, keyed by section title, across
// reloads. A shared blob so one key holds every section's state.
const SECTION_COLLAPSE_KEY = "bt-section-collapsed";
function loadCollapsedSections(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(SECTION_COLLAPSE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

// A collapsible settings section. The chevron + title is a toggle button; the ⓘ
// sits outside it (nesting InfoTip's own <button> inside would be invalid HTML)
// and swallows its own click, so tapping it never collapses the section.
function Section({ title, info, extra, children }: { title: string; info?: string | Array<string | ReactNode>; extra?: ReactNode; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState<boolean>(() => loadCollapsedSections()[title] ?? false);
  const toggle = () => {
    setCollapsed((c) => {
      const next = !c;
      try {
        const all = loadCollapsedSections();
        all[title] = next;
        localStorage.setItem(SECTION_COLLAPSE_KEY, JSON.stringify(all));
      } catch {}
      return next;
    });
  };
  return (
    <div className={`bt-section${collapsed ? " collapsed" : ""}`}>
      <div className="bt-section-head">
        <button type="button" className="bt-section-toggle" onClick={toggle} aria-expanded={!collapsed}>
          <span className={`bt-section-chevron${collapsed ? " collapsed" : ""}`} aria-hidden="true">
            ▾
          </span>
          <span className="instrument-section-title bt-section-title">
            <span>{title}</span>
          </span>
        </button>
        {info && <InfoTip text={info} />}
        {extra}
      </div>
      {!collapsed && children}
    </div>
  );
}

// Operator selector — a custom dropdown (native <select> can't put an icon in
// its option list). Each option in the open menu carries a ⓘ tooltip icon you
// hover for that operator's meaning. A "crosses" op (an event) reads in the
// accent colour; the comparisons (a state) read muted. The menu is portaled to
// <body> so it escapes the modal's scroll clip and a parked side's opacity.
function isCrossOp(op: Operator): boolean {
  return op === "crossesAbove" || op === "crossesBelow";
}

// Menu itself sizes to content (width: max-content in CSS) — this is only an
// upper-bound estimate for keeping it on-screen before it has rendered.
const OP_DROPDOWN_WIDTH = 150;

function OperatorPicker({ value, onChange, sweep }: {
  value: Operator;
  onChange: (op: Operator) => void;
  // Optional operator-sweep toggle (the equalizer glyph beside the button).
  sweep?: { swept: boolean; onToggle: () => void };
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const close = () => setOpen(false);
    // Capture phase: the modal stops mousedown from bubbling past itself (so
    // clicking inside it doesn't trigger the backdrop's close-on-click), which
    // would otherwise swallow this listener too if it only listened on bubble.
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  function toggle() {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.left, window.innerWidth - OP_DROPDOWN_WIDTH - 8));
      setPos({ top: r.bottom + 4, left });
    }
    setOpen((v) => !v);
  }

  const current = OPERATORS.find((o) => o.value === value);
  return (
    <div className="bt-op-menu">
      <Tooltip content={current?.label ?? ""}>
        <button
          ref={btnRef}
          type="button"
          className={`bt-op-btn ${isCrossOp(value) ? "bt-op-cross" : "bt-op-compare"}${open ? " open" : ""}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={`Operator: ${current?.label}`}
          onClick={toggle}
        >
          <OpGlyph op={value} />
        </button>
      </Tooltip>
      {sweep && (
        <Tooltip content="Sweep this operator">
          <button
            type="button"
            className={`sp-sweep bt-op-sweep-toggle${sweep.swept ? " on" : ""}`}
            onClick={sweep.onToggle}
          >
            <SweepGlyph />
          </button>
        </Tooltip>
      )}
      {open &&
        pos &&
        createPortal(
          <ul
            ref={popRef}
            className="dropdown bt-op-dropdown"
            role="listbox"
            style={{ position: "fixed", top: pos.top, left: pos.left }}
          >
            {OPERATORS.map((o) => (
              <li
                key={o.value}
                role="option"
                aria-selected={o.value === value}
                className={o.value === value ? "on" : ""}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                <span className={`bt-op-item-label${isCrossOp(o.value) ? " bt-op-cross" : ""}`}>
                  <span className="bt-op-item-glyph"><OpGlyph op={o.value} /></span>
                  {o.label}
                </span>
                <InfoTip title={o.label} text={o.tip} />
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </div>
  );
}

// "Fill from session" menu — a button, not a <select>. Picking a preset is a
// one-shot action (it fills From/To + tz + weekdays, then everything stays
// editable), so a stateful selector would lie about the current mask. A menu
// button reads as an action and never shows a stale "selected" value. Portaled
// to <body> like OperatorPicker so it escapes the modal's scroll clip.
const SESSION_MENU_WIDTH = 240;

function SessionFillMenu({ disabled, chartTz, onPick }: {
  disabled: boolean;
  chartTz: string;
  onPick: (key: SessionPreset) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  function toggle() {
    if (disabled) return;
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.left, window.innerWidth - SESSION_MENU_WIDTH - 8));
      setPos({ top: r.bottom + 4, left });
    }
    setOpen((v) => !v);
  }

  return (
    <div className="bt-session-menu">
      <button
        ref={btnRef}
        type="button"
        className={`bt-session-btn${open ? " open" : ""}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Fill from a market session"
        onClick={toggle}
      >
        <span>presets</span>
        <span className="bt-session-caret" aria-hidden="true">▾</span>
      </button>
      {open &&
        pos &&
        createPortal(
          <ul
            ref={popRef}
            className="dropdown bt-session-dropdown"
            role="listbox"
            style={{ position: "fixed", top: pos.top, left: pos.left }}
          >
            {Object.entries(SESSION_PRESETS).map(([k, v]) => {
              // Hours shown converted into the chart timezone — the exact
              // numbers a pick fills into From/To (the mask is read there).
              const hrs = formatDayWindow(sessionWindowInTz(v.window, v.tz, chartTz, Date.now()) ?? undefined);
              return (
                <li
                  key={k}
                  role="option"
                  aria-selected={false}
                  onClick={() => {
                    onPick(k as SessionPreset);
                    setOpen(false);
                  }}
                >
                  {hrs ? `${v.label} (${hrs})` : v.label}
                </li>
              );
            })}
          </ul>,
          document.body,
        )}
    </div>
  );
}

function KebabIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <circle cx="12" cy="5" r="1.7" fill="currentColor" />
      <circle cx="12" cy="12" r="1.7" fill="currentColor" />
      <circle cx="12" cy="19" r="1.7" fill="currentColor" />
    </svg>
  );
}

// Two overlapping sheets — the standard "copy" glyph, reused for both the
// copy-all and paste-all whole-group actions.
function CopyAllIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="9" y="9" width="11" height="11" rx="2" strokeLinejoin="round" />
      <path d="M5 15 H4.5 A1.5 1.5 0 0 1 3 13.5 V4.5 A1.5 1.5 0 0 1 4.5 3 h9 A1.5 1.5 0 0 1 15 4.5 V5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Flip-operators glyph: a ">" chevron above a "<" chevron (the ≷ motif) —
// distinct from the swap-sides straight double-arrow, since this inverts each
// operator to its opposite rather than swapping the two operands.
function ReverseOpsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 4l5 4-5 4" />
      <path d="M16 12l-5 4 5 4" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6h16" />
      <path d="M9 6V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V6" />
      <path d="M6 6l1 13.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 6" />
      <path d="M10 10.5v6M14 10.5v6" />
    </svg>
  );
}

// Compact past-sweeps reopen control for the sweep footer: a bare ⟳ icon button
// that opens a portaled menu of archived sweeps. Each row reopens on click and
// carries its own trash button, so the footer stays icon-width no matter which
// sweep (if any) is selected — a native <select> would truncate the long
// "date · name · best N" label into the narrow box. Opens UPWARD because it
// lives at the bottom of the panel.
const PAST_SWEEPS_MENU_WIDTH = 260;
function PastSweepsMenu({
  sweeps,
  disabled,
  onReopen,
  onDelete,
}: {
  sweeps: SweepArchiveSummary[];
  disabled?: boolean;
  onReopen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ bottom: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const close = () => setOpen(false);
    // Scrolling INSIDE the menu (its own overflow list) must not dismiss it —
    // only an outside scroll that would move the anchor out from under it.
    const onScroll = (e: Event) => {
      if (popRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  // When the last row is deleted the menu has nothing left to show.
  useEffect(() => {
    if (sweeps.length === 0) setOpen(false);
  }, [sweeps.length]);

  function toggle() {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.left, window.innerWidth - PAST_SWEEPS_MENU_WIDTH - 8));
      setPos({ bottom: window.innerHeight - r.top + 4, left });
    }
    setOpen((v) => !v);
  }

  return (
    <div className="bt-past-sweeps">
      <Tooltip content="Reopen a past sweep">
        <button
          ref={btnRef}
          type="button"
          className={`bt-past-sweeps-btn${open ? " open" : ""}`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Reopen a past sweep"
          disabled={disabled}
          onClick={toggle}
        >
          ⟳
        </button>
      </Tooltip>
      {open &&
        pos &&
        createPortal(
          <ul
            ref={popRef}
            className="dropdown bt-past-sweeps-list"
            role="menu"
            style={{ position: "fixed", top: "auto", bottom: pos.bottom, left: pos.left, width: PAST_SWEEPS_MENU_WIDTH }}
          >
            {sweeps.map((s) => (
              <li key={s.id} role="menuitem" className="bt-past-sweeps-item">
                <button
                  type="button"
                  className="bt-past-sweeps-reopen"
                  onClick={() => {
                    onReopen(s.id);
                    setOpen(false);
                  }}
                >
                  {new Date(s.created_at * 1000).toLocaleDateString()} · {s.name || `${s.n_rows} combos`} · best {s.best_net_pnl == null ? "n/a" : s.best_net_pnl.toFixed(0)}
                </button>
                <Tooltip content="Delete this sweep">
                  <button
                    type="button"
                    className="bt-past-sweeps-del"
                    aria-label="Delete this sweep"
                    onClick={() => onDelete(s.id)}
                  >
                    <TrashIcon />
                  </button>
                </Tooltip>
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </div>
  );
}

// Per-row actions collapsed into one ⋮ menu (the inline icons were too small to
// notice). Portaled like the operator dropdown so the panel's overflow can't
// clip it. Includes a Disable/Enable toggle — a disabled rule is kept but
// dropped from the run (activeGroup filters it).
const RULE_MENU_WIDTH = 168;
function RuleMenu({
  enabled,
  onDuplicate,
  onCopy,
  onToggleEnabled,
  onSwapSides,
  onRemove,
}: {
  enabled: boolean;
  onDuplicate: () => void;
  onCopy: () => void;
  onToggleEnabled: () => void;
  onSwapSides: () => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  function toggle() {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.right - RULE_MENU_WIDTH, window.innerWidth - RULE_MENU_WIDTH - 8));
      setPos({ top: r.bottom + 4, left });
    }
    setOpen((v) => !v);
  }

  function run(fn: () => void) {
    fn();
    setOpen(false);
  }

  return (
    <div className="bt-rule-menu">
      <Tooltip content="Rule actions">
        <button
          ref={btnRef}
          type="button"
          className={`bt-rule-menu-btn${open ? " open" : ""}`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Rule actions"
          onClick={toggle}
        >
          <KebabIcon />
        </button>
      </Tooltip>
      {open &&
        pos &&
        createPortal(
          <ul
            ref={popRef}
            className="dropdown bt-rule-menu-list"
            role="menu"
            style={{ position: "fixed", top: pos.top, left: pos.left }}
          >
            <li role="menuitem" onClick={() => run(onDuplicate)}>Duplicate</li>
            <li role="menuitem" onClick={() => run(onCopy)}>Copy</li>
            <li role="menuitem" onClick={() => run(onSwapSides)}>Swap sides</li>
            <li role="menuitem" onClick={() => run(onToggleEnabled)}>{enabled ? "Disable" : "Enable"}</li>
            <li role="menuitem" className="bt-rule-menu-danger" onClick={() => run(onRemove)}>Remove</li>
          </ul>,
          document.body,
        )}
    </div>
  );
}

export function RuleGroupSection({
  title,
  info,
  group,
  onChange,
  emptyHint,
  defaultAvwapAnchor,
  baseResolution,
  clipboard,
  onCopy,
  groupClipboard,
  onCopyAll,
  openChartPicker,
  isExit = false,
  sweep,
}: {
  title: string;
  info?: string;
  group: RuleGroup;
  onChange: (g: RuleGroup) => void;
  emptyHint: string;
  defaultAvwapAnchor: number;
  baseResolution: string;
  clipboard: Rule | null;
  onCopy: (rule: Rule) => void;
  groupClipboard: Rule[] | null;
  onCopyAll: (rules: Rule[]) => void;
  // Absent in surfaces with no chart to pick from (e.g. the Live panel) — the
  // affordances that need it simply don't render.
  openChartPicker?: (onPick: (op: Operand) => void) => void;
  // Exit groups can reference the entry price and carry an "Nth time" count;
  // entry groups can't (there's no position yet).
  isExit?: boolean;
  // Task 9: per-operand-field sweep toggle (rule mode only — SidePanel passes
  // it, coded mode's exit-rule use leaves it undefined). `group` here is this
  // section's entry/exit half of the `rule:` target path, distinct from the
  // `RuleGroup` prop above.
  sweep?: {
    axes: SweepAxis[];
    side: "long" | "short";
    group: "entry" | "exit";
    onToggle: (target: string, current: number) => void;
    onToggleOp: (target: string, current: Operator) => void;
    onTickOp: (target: string, op: Operator) => void;
    onAxisChange: (target: string, patch: Partial<Pick<RangeAxis, "from" | "to" | "step">>) => void;
  };
}) {
  function setCombine(combine: Combine) {
    onChange({ ...group, combine });
  }
  // Flip every rule's operator to its opposite in one go. Gated behind a confirm
  // since it rewrites the group's logic (> ↔ <, crosses above ↔ below).
  function reverseAll() {
    requestConfirm({
      title: "Reverse operators",
      message: `Flip every operator in ${title} to its opposite (> ↔ <, crosses above ↔ below)?`,
      confirmLabel: "Reverse",
      onConfirm: () => onChange({ ...group, rules: group.rules.map((r) => ({ ...r, op: OP_REVERSE[r.op] })) }),
    });
  }
  // Wipe every rule in this group, gated behind a confirm (unlike the per-row
  // delete, which is cheap to undo by re-adding one rule).
  function clearAll() {
    requestConfirm({
      title: "Delete all rules",
      message: `Remove all ${group.rules.length} rule${group.rules.length === 1 ? "" : "s"} from ${title}?`,
      confirmLabel: "Delete all",
      onConfirm: () => onChange({ ...group, rules: [] }),
    });
  }
  // Copy the whole group's rules, and paste a copied set (appending independent
  // clones so they can land in another side/leg without sharing references).
  function copyAll() {
    onCopyAll(group.rules);
  }
  function pasteAll() {
    if (groupClipboard?.length) {
      onChange({ ...group, rules: [...group.rules, ...groupClipboard.map(cloneRule)] });
    }
  }
  function setRule(i: number, rule: Rule) {
    const rules = group.rules.slice();
    rules[i] = rule;
    onChange({ ...group, rules });
  }
  function addRule() {
    onChange({ ...group, rules: [...group.rules, defaultRule()] });
  }
  function removeRule(i: number) {
    onChange({ ...group, rules: group.rules.filter((_, idx) => idx !== i) });
  }
  // Insert an independent copy right after the source row, so a duplicated rule
  // reads as a variation of the one above it rather than landing at the bottom.
  function duplicateRule(i: number) {
    const rules = group.rules.slice();
    rules.splice(i + 1, 0, cloneRule(group.rules[i]));
    onChange({ ...group, rules });
  }
  // Paste appends — the clipboard rule may come from another group entirely, so
  // there's no "source row" here to sit beneath.
  function pasteRule() {
    if (clipboard) onChange({ ...group, rules: [...group.rules, cloneRule(clipboard)] });
  }

  // The engine only receives enabled rules (activeGroup drops the rest before
  // POST), so a sweep axis must target a rule by its position in that
  // enabled-only list — not its raw UI index. Otherwise a disabled rule above
  // the swept one shifts the backend indices and the sweep 422s ("index out of
  // range"). Disabled rules can't be swept (their toggle is hidden below).
  const activeRuleIndex = (i: number) =>
    group.rules.slice(0, i).filter((r) => r.enabled !== false).length;

  return (
    <Section
      title={title}
      info={info}
      // Group-wide actions (reverse / copy-all / clear-all) sit beside the
      // section title. Keeping them off their own row means a single-rule group
      // doesn't leave an empty band between the heading and its one rule.
      extra={
        group.rules.length > 0 ? (
          <div className="bt-groophead-actions">
            {/* AND/OR only matters with 2+ rules; it stays fully visible (never
                hover-dimmed) while the icon actions to its right reveal on hover. */}
            {group.rules.length > 1 && (
              <div className="seg bt-combine-seg" role="group" aria-label="Combine rules with">
                <Tooltip content="Fire only when every rule in this group is true.">
                  <button className={group.combine === "AND" ? "seg-on" : ""} onClick={() => setCombine("AND")}>AND</button>
                </Tooltip>
                <Tooltip content="Fire when any rule in this group is true.">
                  <button className={group.combine === "OR" ? "seg-on" : ""} onClick={() => setCombine("OR")}>OR</button>
                </Tooltip>
              </div>
            )}
            <Tooltip content="Flip every operator to its opposite (> ↔ <, crosses above ↔ below)">
              <button
                className="bt-rule-toggle bt-reverse-ops"
                onClick={reverseAll}
                aria-label="Reverse operators"
              >
                <ReverseOpsIcon />
              </button>
            </Tooltip>
            <Tooltip content="Copy all rules in this group">
              <button
                className="bt-rule-toggle bt-copyall"
                onClick={copyAll}
                aria-label="Copy all rules"
              >
                <CopyAllIcon />
              </button>
            </Tooltip>
            <Tooltip content="Delete all rules in this group">
              <button
                className="bt-rule-toggle bt-clearall"
                onClick={clearAll}
                aria-label="Delete all rules"
              >
                <TrashIcon />
              </button>
            </Tooltip>
          </div>
        ) : undefined
      }
    >
      {group.rules.length === 0 && (
        <div className="al-note bt-empty-rules">{emptyHint}</div>
      )}
      {group.rules.map((rule, i) => (
        <Fragment key={i}>
        <div className={`bt-rule-row${rule.enabled === false ? " bt-rule-disabled" : ""}`}>
          <div className="bt-rule-main">
            <OperandPicker value={rule.left} onChange={(left) => setRule(i, { ...rule, left })} defaultAvwapAnchor={defaultAvwapAnchor} baseResolution={baseResolution} allowEntry={isExit} siblingSloped={slopeLen(rule.right) !== null} openChartPicker={openChartPicker} sweep={sweep && rule.enabled !== false ? { axes: sweep.axes, onToggle: sweep.onToggle, onAxisChange: sweep.onAxisChange, target: (leaf) => ruleAxisTarget(sweep.side, sweep.group, activeRuleIndex(i), `left.${leaf}`) } : undefined} />
            <OperatorPicker
              value={rule.op}
              onChange={(op) => setRule(i, { ...rule, op })}
              sweep={sweep && rule.enabled !== false ? {
                swept: sweep.axes.some((a) => a.target === opAxisTarget(sweep.side, sweep.group, activeRuleIndex(i))),
                onToggle: () => sweep.onToggleOp(opAxisTarget(sweep.side, sweep.group, activeRuleIndex(i)), rule.op),
              } : undefined}
            />
            <OperandPicker value={rule.right} onChange={(right) => setRule(i, { ...rule, right })} defaultAvwapAnchor={defaultAvwapAnchor} baseResolution={baseResolution} allowEntry={isExit} siblingSloped={slopeLen(rule.left) !== null} openChartPicker={openChartPicker} sweep={sweep && rule.enabled !== false ? { axes: sweep.axes, onToggle: sweep.onToggle, onAxisChange: sweep.onAxisChange, target: (leaf) => ruleAxisTarget(sweep.side, sweep.group, activeRuleIndex(i), `right.${leaf}`) } : undefined} />
            {isExit && (
              <CountField
                value={rule.count}
                onChange={(count) => setRule(i, { ...rule, count })}
                sweep={
                  sweep && rule.enabled !== false
                    ? {
                        axes: sweep.axes,
                        onToggle: sweep.onToggle,
                        onAxisChange: sweep.onAxisChange,
                        target: ruleAxisTarget(sweep.side, sweep.group, activeRuleIndex(i), "count"),
                      }
                    : undefined
                }
              />
            )}
            <div className="bt-rule-actions">
              <Tooltip content="Swap sides (same condition)">
                <button
                  type="button"
                  className="bt-rule-toggle bt-swap-sides"
                  onClick={() => setRule(i, swapSides(rule))}
                  aria-label="Swap sides"
                >
                  ⇄
                </button>
              </Tooltip>
              <RuleMenu
                enabled={rule.enabled !== false}
                onDuplicate={() => duplicateRule(i)}
                onCopy={() => onCopy(rule)}
                onToggleEnabled={() => setRule(i, { ...rule, enabled: rule.enabled === false })}
                onSwapSides={() => setRule(i, swapSides(rule))}
                onRemove={() => removeRule(i)}
              />
            </div>
          </div>
        </div>
        {sweep && rule.enabled !== false && (() => {
          const target = opAxisTarget(sweep.side, sweep.group, activeRuleIndex(i));
          const axis = sweep.axes.find((a) => a.target === target);
          if (axis?.kind !== "list") return null;
          return (
            <div className="sp-row sweep-axis-row bt-op-sweep-row">
              <span className="sp-label">operators</span>
              <span className="bt-chip-row">
                {OPERATORS.map((o) => {
                  const on = axis.options.some((opt) => opt.patch[target] === o.value);
                  return (
                    <button
                      key={o.value}
                      type="button"
                      className={on ? "seg-on bt-chip" : "bt-chip"}
                      onClick={() => sweep.onTickOp(target, o.value)}
                    >
                      {o.label}
                    </button>
                  );
                })}
              </span>
            </div>
          );
        })()}
        </Fragment>
      ))}
      <div className="bt-rule-foot">
        <button className="ghost" onClick={addRule}>
          + Add rule
        </button>
        {openChartPicker && (
          <Tooltip content="Add a rule seeded from a chart indicator or drawing">
            <button
              className="ghost"
              onClick={() => openChartPicker((op) => onChange({ ...group, rules: [...group.rules, ruleFromChartOperand(op)] }))}
            >
              + Rule from chart
            </button>
          </Tooltip>
        )}
        {clipboard && (
          <Tooltip content="Paste the copied rule here">
            <button className="ghost" onClick={pasteRule}>
              Paste rule
            </button>
          </Tooltip>
        )}
        {groupClipboard?.length ? (
          <Tooltip content={`Paste all ${groupClipboard.length} copied rule${groupClipboard.length > 1 ? "s" : ""} here`}>
            <button
              className="ghost bt-pasteall"
              onClick={pasteAll}
            >
              <CopyAllIcon /> Paste all
            </button>
          </Tooltip>
        ) : null}
      </div>
    </Section>
  );
}

// A sweep target's rule index counts ENABLED rules only (activeGroup drops
// disabled ones before POST); map it back to the raw UI index for apply.
function rawRuleIndex(rules: Rule[], activeIdx: number): number {
  let seen = -1;
  for (let i = 0; i < rules.length; i++) {
    if (rules[i].enabled !== false) seen++;
    if (seen === activeIdx) return i;
  }
  return -1;
}

// Compact ordinal suffix for the count chip: 1st, 2nd, 3rd, 4th…
function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// The optional "Nth time" modifier on an exit rule. Blank/1 ⇒ fire on the first
// occurrence (the default); N ≥ 2 ⇒ fire on the Nth bar since entry the
// condition is true (cumulative — non-consecutive bars count).
function CountField({
  value,
  onChange,
  sweep,
}: {
  value?: number;
  onChange: (n?: number) => void;
  // Task 9: optional sweep toggle on the count itself, keyed by the exact
  // `rule:...count` target the caller already built.
  sweep?: {
    axes: SweepAxis[];
    target: string;
    onToggle: (target: string, current: number) => void;
    onAxisChange: (target: string, patch: Partial<Pick<RangeAxis, "from" | "to" | "step">>) => void;
  };
}) {
  const n = value && value > 1 ? value : undefined;
  const swept = sweep?.axes.some((a) => a.target === sweep.target) ?? false;
  const sweptAxis = sweep?.axes.find(
    (a): a is RangeAxis => a.kind === "range" && a.target === sweep.target,
  );
  // Keep a local text buffer so the field shows exactly what the user typed
  // mid-edit. Deriving the input value straight from the model breaks typing:
  // a bare "1" (the default) maps to undefined, so a controlled value would
  // wipe the leading "1" of 10–19 the instant it's typed. We sync back from the
  // model only when it changes from the outside (e.g. a reset).
  const [text, setText] = useState<string>(n ? String(n) : "");
  useEffect(() => {
    setText(n ? String(n) : "");
  }, [n]);
  return (
    <>
      <Tooltip
        content={[
          "Fire on the Nth time since entry this condition is true.",
          "Counts every bar it's true, consecutive or not. Blank or 1 = the first time.",
        ]}
      >
        <label className={`bt-rule-count${n ? " on" : ""}`}>
          {/* While swept, a RangeChip edits the range in place; otherwise the
              plain count input with its ordinal suffix. */}
          {sweptAxis && sweep ? (
            <>
              <SweepBaseValue>{ordinal(n ?? 1)}</SweepBaseValue>
              <RangeChip
                axis={sweptAxis}
                onPatch={(p) => sweep.onAxisChange(sweptAxis.target, p)}
                onRemove={() => sweep.onToggle(sweep.target, n ?? 1)}
              />
            </>
          ) : (
            <>
              <input
                  type="number"
                  // Floor at 2: 1 is the default and reads as blank, so letting the
                  // native spinner step to 1 would make the up-arrow appear dead.
                  min={2}
                  step={1}
                  className="bt-rule-count-input"
                  placeholder="1st"
                  value={text}
                  onKeyDown={blockNegKeys}
                  onChange={(e) => {
                    const raw = cleanNumInput(e.currentTarget);
                    setText(raw);
                    const num = Math.round(Number(raw));
                    onChange(raw === "" || num <= 1 || !Number.isFinite(num) ? undefined : num);
                  }}
                  // A stray "1" (or anything that resolves to the default) snaps back to
                  // the blank "1st" placeholder on blur so the field never lingers on a
                  // value the model dropped.
                  onBlur={() => setText(n ? String(n) : "")}
                />
              <span className="bt-rule-count-suffix" aria-hidden="true">{n ? ordinal(n) : ""}</span>
            </>
          )}
        </label>
      </Tooltip>
      {sweep && (
        <Tooltip content="Sweep this field">
          <button
            type="button"
            className={`sp-sweep${swept ? " on" : ""}`}
            onClick={() => sweep.onToggle(sweep.target, n ?? 1)}
          >
            <SweepGlyph />
          </button>
        </Tooltip>
      )}
    </>
  );
}

function OperandPicker({
  value,
  onChange,
  defaultAvwapAnchor,
  baseResolution,
  allowEntry = false,
  siblingSloped = false,
  openChartPicker,
  sweep,
}: {
  value: Operand;
  onChange: (op: Operand) => void;
  defaultAvwapAnchor: number;
  baseResolution: string;
  // Offer "Entry price" — only in exit rules, where a position exists to read it.
  allowEntry?: boolean;
  // The rule's OTHER operand is a slope, so this operand — if it's a Number — is
  // being compared in %/hr; show a unit hint to make that legible.
  siblingSloped?: boolean;
  // Absent in surfaces with no chart to pick from (e.g. the Live panel) — the
  // affordances that need it simply don't render.
  openChartPicker?: (onPick: (op: Operand) => void) => void;
  // Task 9: optional sweep toggle for this operand's numeric field (indicator
  // `length` or const `value`). `target` builds the full `rule:` path from the
  // leaf field name — the caller (RuleGroupSection) already knows the side/
  // group/rule-index this operand sits at.
  sweep?: {
    axes: SweepAxis[];
    onToggle: (target: string, current: number) => void;
    onAxisChange: (target: string, patch: Partial<Pick<RangeAxis, "from" | "to" | "step">>) => void;
    target: (leaf: "length" | "value") => string;
  };
}) {
  // Slope can wrap an indicator, a price, or a pasted chart operand (not a constant
  // or the entry price).
  const canSlope = value.kind === "indicator" || value.kind === "price" || value.kind === "series";
  const sweptTarget = (leaf: "length" | "value") => sweep?.target(leaf);
  const isSwept = (leaf: "length" | "value") =>
    sweep ? sweep.axes.some((a) => a.target === sweptTarget(leaf)) : false;
  const sweptAxis = (leaf: "length" | "value") =>
    sweep?.axes.find((a): a is RangeAxis => a.kind === "range" && a.target === sweptTarget(leaf));
  const sweepToggle = (leaf: "length" | "value", current: number) =>
    sweep && (
      <Tooltip content="Sweep this field">
        <button
          type="button"
          className={`sp-sweep${isSwept(leaf) ? " on" : ""}`}
          onClick={() => sweep.onToggle(sweptTarget(leaf)!, current)}
        >
          <SweepGlyph />
        </button>
      </Tooltip>
    );
  // Changing the operand's type can strand a swept leaf (a const's value axis
  // under an indicator operand, a length axis under a const/series/AVWAP): the
  // chip is leaf-matched so the axis would become invisible and unremovable
  // while still multiplying the sweep. Drop stale leaves before committing the
  // type change (mirrors RiskSection's onKindChange).
  const dropOrphanAxes = (next: Operand) => {
    if (!sweep) return;
    const hasLength = next.kind === "indicator" && !NO_LENGTH.includes(next.indicator);
    const hasValue = next.kind === "const";
    if (!hasLength && isSwept("length")) sweep.onToggle(sweptTarget("length")!, 0);
    if (!hasValue && isSwept("value")) sweep.onToggle(sweptTarget("value")!, 0);
  };
  const sloped = slopeLen(value) !== null;
  function setSlope(spec: { len: number } | undefined) {
    if (value.kind !== "indicator" && value.kind !== "price" && value.kind !== "series") return;
    onChange({ ...value, slope: spec });
  }
  // Timeframes a rule operand can run on: the base (blank ⇒ follow the run's
  // base timeframe) plus every non-live timeframe strictly higher than base.
  // Lower-than-base is excluded — it can't align onto the coarser base bars
  // without either losing information or leaking future ticks.
  const baseSec = RESOLUTION_SECONDS[baseResolution] ?? 0;
  const higherTfs = PERIOD_GROUPS.flatMap((g) => g.periods).filter(
    (p) => !p.liveOnly && (RESOLUTION_SECONDS[p.resolution] ?? 0) > baseSec,
  );
  // If the operand already has a timeframe that's no longer "higher than base"
  // (e.g. the base dropdown was raised to meet it), keep it selectable so the
  // control doesn't render blank while silently holding a value.
  const currentTf = value.kind === "indicator" || value.kind === "series" ? value.timeframe : undefined;
  if (currentTf && !higherTfs.some((p) => p.resolution === currentTf)) {
    const cur = PERIOD_GROUPS.flatMap((g) => g.periods).find((p) => p.resolution === currentTf);
    if (cur) higherTfs.unshift(cur);
  }
  // One select drives the operand type: pick an indicator directly (EMA, SMA…),
  // or Price, or Number — no separate "kind then indicator" step. The token is
  // the indicator name for indicators, else the kind.
  const typeToken = value.kind === "indicator" ? value.indicator : value.kind;
  const prevLength = value.kind === "indicator" ? value.length : undefined;
  // Carry the slope transform across a type switch (like `length` above), so
  // swapping EMA↔SMA or indicator↔price doesn't silently drop an active slope and
  // turn the rule into a different condition. const/entry can't be sloped.
  const prevSlope =
    value.kind === "indicator" || value.kind === "price" || value.kind === "series" ? value.slope : undefined;
  function setType(token: string) {
    let next: Operand;
    if (token === "price") next = { kind: "price", field: "close", slope: prevSlope };
    else if (token === "const") next = { kind: "const", value: 0 };
    else if (token === "entry") next = { kind: "entry" };
    else {
      const indicator = token as IndicatorKind;
      if (indicator === "AVWAP") next = { kind: "indicator", indicator, anchor: defaultAvwapAnchor, slope: prevSlope };
      else if (NO_LENGTH.includes(indicator)) next = { kind: "indicator", indicator, slope: prevSlope };
      else next = { kind: "indicator", indicator, length: prevLength ?? 9, slope: prevSlope };
    }
    dropOrphanAxes(next);
    onChange(next);
  }

  return (
    <div className="bt-operand">
      {value.kind === "series" ? (
        <>
          <Tooltip content="A chart curve/drawing copied into this rule. Clear (✕) to edit as a normal operand.">
            <span className="bt-operand-chip">
              <span className="bt-operand-chip-label">{value.label}</span>
              <button
                type="button"
                className="bt-operand-chip-clear"
                onClick={() => {
                  const next: Operand = { kind: "const", value: 0 };
                  dropOrphanAxes(next);
                  onChange(next);
                }}
                aria-label="Clear pasted operand"
              >
                ✕
              </button>
            </span>
          </Tooltip>
          {/* A drawing has no meaningful timeframe (it's absolute-time anchored);
              offering one would forward-fill the line into a step function. Only an
              indicator recipe can run on a higher timeframe. */}
          {value.recipe.source === "indicator" && (
            <Tooltip content="Timeframe this operand is computed on">
              <select
                className="bt-operand-tf"
                value={value.timeframe ?? ""}
                onChange={(e) => onChange({ ...value, timeframe: e.target.value || undefined })}
              >
                <option value="">Base</option>
                {higherTfs.map((p) => (
                  <option key={p.resolution} value={p.resolution}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Tooltip>
          )}
        </>
      ) : (
      <>
      <select value={typeToken} onChange={(e) => setType(e.target.value)}>
        <optgroup label="Indicator">
          {INDICATORS.map((ind) => (
            <option key={ind} value={ind}>
              {ind}
            </option>
          ))}
        </optgroup>
        <option value="price">Price</option>
        <option value="const">Number</option>
        {(allowEntry || value.kind === "entry") && <option value="entry">Entry price</option>}
      </select>
      {value.kind === "indicator" && (
        <>
          {value.indicator === "AVWAP" && (
            <input
              type="datetime-local"
              className="bt-operand-anchor"
              value={value.anchor && value.anchor > 0 ? msToLocalInput(value.anchor) : ""}
              onChange={(e) => onChange({ ...value, anchor: localInputToMs(e.target.value) ?? 0 })}
            />
          )}
          {!NO_LENGTH.includes(value.indicator) && (
            <>
              {/* While swept, a RangeChip edits the range in place; otherwise the
                  plain length input with its sweep toggle. */}
              {(() => {
                const axis = sweptAxis("length");
                return axis && sweep ? (
                  <>
                    <SweepBaseValue>{value.length ?? 9}</SweepBaseValue>
                    <RangeChip
                      axis={axis}
                      onPatch={(p) => sweep.onAxisChange(axis.target, p)}
                      onRemove={() => sweep.onToggle(axis.target, value.length ?? 9)}
                    />
                  </>
                ) : (
                  <>
                    <input
                      type="number"
                      min={1}
                      className="bt-operand-length"
                      value={value.length ?? 9}
                      onKeyDown={blockNegKeys}
                      onChange={(e) => onChange({ ...value, length: Number(cleanNumInput(e.currentTarget)) })}
                      onBlur={(e) => clampPosOnBlur(e.currentTarget, 1, (n) => onChange({ ...value, length: n }))}
                    />
                    {sweepToggle("length", value.length ?? 9)}
                  </>
                );
              })()}
            </>
          )}
          <Tooltip content="Timeframe this indicator is computed on">
            <select
              className="bt-operand-tf"
              value={value.timeframe ?? ""}
              onChange={(e) => onChange({ ...value, timeframe: e.target.value || undefined })}
            >
              <option value="">Base</option>
              {higherTfs.map((p) => (
                <option key={p.resolution} value={p.resolution}>
                  {p.label}
                </option>
              ))}
            </select>
          </Tooltip>
        </>
      )}
      {value.kind === "price" && (
        <select value={value.field} onChange={(e) => onChange({ ...value, field: e.target.value as PriceField })}>
          {PRICE_FIELDS.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      )}
      {value.kind === "const" && (
        <>
          {(() => {
            const axis = sweptAxis("value");
            return axis && sweep ? (
              <>
                <SweepBaseValue>{value.value}</SweepBaseValue>
                <RangeChip
                  axis={axis}
                  onPatch={(p) => sweep.onAxisChange(axis.target, p)}
                  onRemove={() => sweep.onToggle(axis.target, value.value)}
                />
                {siblingSloped && <span className="bt-operand-unit">%/hr</span>}
              </>
            ) : (
              <>
                <NumberField
                  signed
                  value={value.value}
                  onChange={(n) => onChange({ kind: "const", value: n })}
                  className="bt-operand-length"
                />
                {siblingSloped && <span className="bt-operand-unit">%/hr</span>}
                {sweepToggle("value", value.value)}
              </>
            );
          })()}
        </>
      )}
      {openChartPicker && (
        <Tooltip content="Add a chart indicator or drawing as this operand">
          <button
            type="button"
            className="bt-operand-add"
            onClick={() => openChartPicker((op) => {
              const next: Operand =
                prevSlope && (op.kind === "indicator" || op.kind === "price" || op.kind === "series")
                  ? { ...op, slope: prevSlope }
                  : op;
              dropOrphanAxes(next);
              onChange(next);
            })}
            aria-label="Add from chart"
          >
            +
          </button>
        </Tooltip>
      )}
      </>
      )}
      {canSlope && (
        <>
          <Tooltip content="Compare the slope (rate of change, % per hour) of this curve instead of its value">
            <button
              type="button"
              className={`bt-operand-slope${sloped ? " on" : ""}`}
              onClick={() => setSlope(sloped ? undefined : { len: 1 })}
              aria-label="Use slope"
              aria-pressed={sloped}
            >
              Δ
            </button>
          </Tooltip>
          {sloped && (
            <Tooltip content="Slope lookback (bars)">
              <input
                type="number"
                min={1}
                className="bt-operand-length"
                value={slopeLen(value) ?? 1}
                onKeyDown={blockNegKeys}
                onChange={(e) => setSlope({ len: Number(cleanNumInput(e.currentTarget)) })}
                onBlur={(e) => clampPosOnBlur(e.currentTarget, 1, (n) => setSlope({ len: n }))}
              />
            </Tooltip>
          )}
        </>
      )}
    </div>
  );
}

