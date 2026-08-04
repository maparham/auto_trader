// Backtest strategy builder: time range + history depth, entry/exit rule
// groups, costs, and named presets. Matches the app's other modals exactly
// (useDraggable/useCloseOnEscape/CloseButton, .modal-backdrop/.modal/.modal-head/
// .modal-foot) — no shared wrapper, no portal.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import CloseButton from "./CloseButton";
import InfoTip from "./components/InfoTip";
import NumberField from "./components/NumberField";
import RunBar, { ModeSeg } from "./components/RunBar";
import RuleExpressionInput from "./components/RuleExpressionInput";
import RulePalette from "./components/RulePalette";
import Tooltip from "./components/Tooltip";
import { msToLocalInput, localInputToMs } from "./lib/alertUi";
import {
  requestGoLive,
  requestConfirm,
  backtestClearRequest,
  backtestRunningSignal,
  backtestDurationSignal,
  sweepDurationSignal,
  wfoDurationSignal,
  backtestMessagesSignal,
  sweepAxesSignal,
  holdoutEvalSignal,
  sweepStateSignal,
  requestSweepCancel,
  sweepTargetSignal,
  saveSweepTarget,
  sweepCombosOverrideSignal,
  sweepArchivedSignal,
  wfoStateSignal,
  wfoRequestSignal,
  wfoRenderRequest,
  requestWfoCancel,
  progressStageSignal,
  backtestConfigLive,
} from "./lib/signals";
import { stageLabel } from "./lib/progressLabels";
import { resumeSweep } from "./lib/sweepResume";
import { WfoConfig } from "./WfoConfig";
import { buildWalkForwardPayload, resumeWfo, wfoAxesFromSweepAxes, DEFAULT_WFO_CONFIG, type WfoConfigState } from "./lib/wfo";
import { PHASE_LABEL, WfoResults } from "./WfoResults";
import { requiredWarmupBars, resolveWindow } from "./lib/backtestWindow";
import { TIMEZONES, offsetLabel } from "./lib/timezones";
import { RESOLUTION_SECONDS, PERIOD_GROUPS } from "./lib/feed";
import {
  type BacktestConfig,
  type RangeConfig,
  type RangeMode,
  type HistoryDepth,
  type RuleGroup,
  type Rule,
  type Combine,
  type Costs,
  type SlippageModel,
  cloneRule,
  type RiskConfig,
  type StopKind,
  type TargetKind,
  type ScalingConfig,
  type RecurrenceMask,
  type SessionPreset,
  type DayTimeWindow,
} from "./lib/backtestConfig";
import { SESSION_PRESETS, buildRangeChips, coverage, formatDayWindow, isActive, minToTime, resolveMask, sessionWindowInTz } from "./lib/backtestSchedule";
import type { ChartController } from "./lib/chartController";
import { getIndicator } from "./lib/indicators";
import { indTypeOf } from "./lib/indicators/shared";
import { chartIndicatorToExprToken } from "./lib/exprChartToken";
import { toast } from "./lib/notify";
import BacktestPanel from "./BacktestPanel";
import StrategyPicker from "./StrategyPicker";
import { RangeChip, SweepBaseValue } from "./components/RangeChip";
import { StrategyParams } from "./components/StrategyParams";
import { SweepResults } from "./SweepResults";
import { comboCount, materializePeriodAxes, mirrorRiskAxes, SWEEP_WARN_COMBOS, type RangeAxis, type SweepAxis, type SweepCombo, type SweepOption } from "./lib/sweep";
import { analyze } from "./lib/expr/parser";
import { pruneLitAxes, sweepLiteralTarget } from "./lib/expr/sweepLiterals";
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
import { fetchStrategies, computeStatus, listSweepArchives, getSweepArchive, deleteSweepArchive, getCostProfile, putCostProfile, refetchCostProfile, getWfoFoldTable, getWfoArchiveTables, type StrategyInfo, type ParamSpec, type SweepArchiveSummary, type CostProfile, type SweepRow, type WfoResult } from "./api";
import { WfoArchive } from "./WfoArchive";
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
  loadWfoSchedule,
  saveWfoSchedule,
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

// WFO quick-fill: relative presets stay rolling (mode set, fromMs/toMs cleared),
// mirroring the non-WFO relative modes.
const WFO_RELATIVE_CHIPS: { mode: RangeMode; label: string }[] = [
  { mode: "lastDay", label: "1D" },
  { mode: "lastWeek", label: "1W" },
  { mode: "lastMonth", label: "1M" },
  { mode: "lastYear", label: "1Y" },
];

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
  // Size from what the run itself demands (BacktestButton passes the same
  // resolution into requiredWarmupBars) — expression rows carry almost all of a
  // config's warm-up, and the ATR-only longestIndicatorLength never saw them.
  // "Full" stays open-ended: it has no known size to draw.
  const historyBars = depth === "full" ? null : requiredWarmupBars(cfg, resSeconds);

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
  // Single source of truth for the stall-window progress label (downloading
  // candles / submitting / uploading to compute host / running backtest),
  // shown above all three result panels regardless of mode so it's visible
  // even before a sweep/WFO panel has mounted.
  const stage = useSyncExternalStore(
    (cb) => progressStageSignal.subscribe(cb),
    () => progressStageSignal.value,
  );
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
  // Publish the live config so the chart's rule-proximity heatmap tracks edits as
  // they happen (undebounced: the heatmap fetch is debounced on its own side).
  // Clear to null on unmount so the chart falls back to the persisted config.
  useEffect(() => {
    backtestConfigLive.set(cfg);
  }, [cfg]);
  useEffect(() => () => backtestConfigLive.set(null), []);
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
  const [, setPickedSweep] = useState("");
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
  // Sweep controls stay editable in walk-forward too: WFO reuses the same
  // parameter-axis toggles to define its optimization grid. Only pure Backtest
  // mode makes them inert.
  const sweepEditable = btMode !== "backtest";
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
  // Drop lit: axes whose literal vanished after an expression edit / row delete.
  useEffect(() => {
    const src = cfg.mode === "coded" ? codedCfg : cfg; // coded exits are structured; still safe to scan
    const groups = (
      [
        ["long", "entry", "longEntry"],
        ["long", "exit", "longExit"],
        ["short", "entry", "shortEntry"],
        ["short", "exit", "shortExit"],
      ] as const
    ).map(([side, group, key]) => ({
      side,
      group,
      exprs: (((src as any)?.[key]?.rules ?? []) as any[]).map((r: any) => r.expr ?? ""),
    }));
    setSweepAxes((axes) => {
      const next = pruneLitAxes(axes, groups);
      return next.length === axes.length ? axes : next; // identity-stable no-op
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.longEntry, cfg.longExit, cfg.shortEntry, cfg.shortExit]);
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
  // Numeric range axis for an expression literal (lit: target) — same heuristic
  // as toggleRiskSweepAxis (no declared min/max/step to draw from). The literal
  // sweep chips in RuleGroupSection wire their toggle through here.
  const toggleRangeSweepAxis = (target: string, current: number) => {
    if (!sweepEditable) return;
    setSweepAxes((axes) => {
      if (axes.some((a) => a.target === target)) return axes.filter((a) => a.target !== target);
      const base = current || 1;
      const mem = recallSweepRange(sweepCtx(), target);
      const next: SweepAxis = {
        kind: "range",
        target,
        label: sweepAxisLabel(target, labelCfg()) ?? target,
        from: mem?.from ?? base,
        to: mem?.to ?? base * 2,
        step: mem?.step ?? Math.max(base / 10, 1),
      };
      return addAxis(axes, next);
    });
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
    if (btMode === "walkforward") return; // session (timeWindow) axes are dropped in WFO
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
  // Removing the last option empties the axis; drop it entirely so an empty
  // kind:"list" axis can't strand a slot or make comboCount return Infinity.
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
    if (btMode === "walkforward") return; // period axes are dropped in WFO
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
  // Walk-forward schedule config (device-local, re-hydrated on open) + its live
  // run state, subscribed here so the mode badge and Run button re-render as a
  // WFO job advances (mirrors the sweepState subscription above).
  // Spread over the defaults so a config persisted before a field existed
  // (e.g. evalMode) still resolves to its default rather than undefined.
  const [wfoCfg, setWfoCfg] = useState<WfoConfigState>(
    () => ({ ...DEFAULT_WFO_CONFIG, ...loadWfoSchedule(DEFAULT_WFO_CONFIG) }));
  const changeWfoCfg = (n: WfoConfigState) => { setWfoCfg(n); saveWfoSchedule(n); };
  const [wfoState, setWfoState] = useState(wfoStateSignal.value);
  useEffect(() => wfoStateSignal.subscribe(setWfoState), []);
  // Combo count + dropped-axis labels for the WFO config footer/badge. Building
  // the payload throws on an invalid config (no axes / no train span); the panel
  // treats that as 0 combos / no dropped axes rather than surfacing the error here.
  // `wfoUsableAxes` are the surviving (non-period, non-timeWindow) sweep axes
  // the WFO grid actually varies — WfoResults labels params and drift by them.
  const { wfoComboTotal, wfoDroppedAxes, wfoUsableAxes } = useMemo(() => {
    // wfoAxesFromSweepAxes lives INSIDE the try: a malformed persisted axis (e.g.
    // an options-[] list axis) must degrade to 0 combos, never throw and crash
    // the whole modal render. Keep the dropped/usable it produced so the "dropped
    // from WFO" hint still shows when buildWalkForwardPayload throws on a config
    // that has only period/timeWindow axes (0 combos, but dropped is meaningful).
    let usable: SweepAxis[] = [];
    let dropped: string[] = [];
    try {
      ({ usable, dropped } = wfoAxesFromSweepAxes(sweepAxes));
      const { comboTotal } = buildWalkForwardPayload(sweepAxes, wfoCfg);
      return { wfoComboTotal: comboTotal, wfoDroppedAxes: dropped, wfoUsableAxes: usable };
    } catch {
      return { wfoComboTotal: 0, wfoDroppedAxes: dropped, wfoUsableAxes: usable };
    }
  }, [sweepAxes, wfoCfg]);
  const [wfoError, setWfoError] = useState<string | null>(null);
  const [wfoSchemeIndex, setWfoSchemeIndex] = useState(0);
  // Live-job fold-table fetch for the folds drill-in; archive-backed loading
  // arrives with the archive browser task.
  const loadWfoFoldTable = useStableCallback(async (key: string): Promise<SweepRow[]> => {
    const jobId = wfoStateSignal.value?.jobId;
    if (!jobId) return [];
    const { rows } = await getWfoFoldTable(jobId, key, sweepTargetSignal.value);
    return rows;
  });
  // A reopened archive shown in the WFO results area (null = show the ranking
  // list, when there is no live/last run). Carries the run id + its result so
  // WfoResults renders off a reconstructed done-state.
  const [wfoArchiveOpen, setWfoArchiveOpen] = useState<{ id: string; result: WfoResult } | null>(null);
  const openWfoArchive = (a: { id: string; result: WfoResult }) => {
    setWfoSchemeIndex(0);
    setWfoArchiveOpen(a);
  };
  // Archive fold tables come as one dict keyed "s{i}/f{k}" — fetch once and cache
  // it, so the folds drill-in resolves each key from memory (mirrors the live
  // job's per-key fetch but off the stored dict).
  const wfoArchiveTables = useRef<{ id: string; dict: Record<string, SweepRow[]> } | null>(null);
  const loadWfoArchiveFoldTable = useStableCallback(async (key: string): Promise<SweepRow[]> => {
    const id = wfoArchiveOpen?.id;
    if (!id) return [];
    if (wfoArchiveTables.current?.id !== id) {
      wfoArchiveTables.current = { id, dict: await getWfoArchiveTables(id) };
    }
    return wfoArchiveTables.current.dict[key] ?? [];
  });
  // Reconstructed done-state for the reopened archive (WfoRunState shape).
  const wfoArchiveState = wfoArchiveOpen
    ? { phase: "done" as const, done: 0, total: 0, running: false, foldRows: [], result: wfoArchiveOpen.result }
    : null;
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
  // Same re-attach for a walk-forward job that outlived a reload: only when no
  // run already owns the WFO state, and flip the view to walk-forward so its
  // streaming folds are immediately visible (setBtMode, not selectMode).
  useEffect(() => {
    if (wfoStateSignal.value === null)
      void resumeWfo().then((attached) => {
        if (attached) setBtMode("walkforward");
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
    // Detach any live WFO poll too (server=false: leave the job running so a
    // reload can re-attach). A COMPLETED result is left intact so it survives
    // reopen for the results view — but a still-RUNNING job's state must be
    // cleared so the mount-resume gate (`if (wfoStateSignal.value === null)
    // resumeWfo()`) fires on reopen and re-attaches to the live job. Without
    // this the detached job would be orphaned (its poll aborted, its state
    // frozen), never re-attached.
    requestWfoCancel(false);
    if (wfoStateSignal.value?.running) wfoStateSignal.set(null);
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
      // lit: expression-literal axes are not patched onto a structured operand
      // here (there is no structured operand to patch).
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
  const [wfoDurationMs, setWfoDurationMs] = useState(wfoDurationSignal.value);
  useEffect(() => wfoDurationSignal.subscribe(setWfoDurationMs), []);
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

  // "Pick from chart" (expression editor): a rule row arms the chart, the user
  // clicks an on-chart indicator, and its expression token (e.g. "EMA(9)") is
  // appended to that row. Single source of truth for WHICH row is armed lives
  // here (not per-section), so arming a second row replaces the first and the
  // one chart click can only ever insert once. Mirrors the rangePick wiring.
  const [exprPickArmed, setExprPickArmed] = useState<
    { group: "longEntry" | "longExit" | "shortEntry" | "shortExit"; row: number } | null
  >(null);
  const exprPickArmedRef = useRef(exprPickArmed);
  exprPickArmedRef.current = exprPickArmed;
  useEffect(() => {
    if (!controller) return;
    const unsub = controller.indicatorPickResult.subscribe((sel) => {
      const target = exprPickArmedRef.current;
      if (!sel || !target) return;
      controller.indicatorPickResult.set(null); // consume one-shot
      setExprPickArmed(null);
      controller.indicatorPickArmed.set(false);
      const ind = controller.chart ? getIndicator(controller.chart, sel.paneId, sel.name) : null;
      const token = ind
        ? chartIndicatorToExprToken(indTypeOf(ind), (ind.calcParams ?? []).map(Number), ind.extendData)
        : null;
      if (!token) {
        toast("That indicator has no expression equivalent.");
        return;
      }
      setCfg((c) => {
        const g = c[target.group] as { rules: Array<{ expr?: string }> };
        const rules = g.rules.map((r, i) => (i === target.row ? { ...r, expr: (r.expr ?? "") + token } : r));
        return { ...c, [target.group]: { ...g, rules } };
      });
    });
    return () => {
      unsub();
      controller.indicatorPickArmed.set(false); // never leave the chart armed if the panel closes
    };
  }, [controller]);
  const exprPick = controller
    ? {
        armed: exprPickArmed,
        arm: (group: "longEntry" | "longExit" | "shortEntry" | "shortExit", row: number) => {
          setExprPickArmed({ group, row });
          controller.indicatorPickArmed.set(true);
        },
        disarm: () => {
          setExprPickArmed(null);
          controller.indicatorPickArmed.set(false);
        },
      }
    : undefined;

  // The timeframe the run will actually use: the config override when set, else
  // the active chart timeframe (the `resolution` prop). Window math + the header
  // badge follow this so they reflect the run, not necessarily the chart.
  const effectiveRes = cfg.range.resolution ?? resolution;
  const resSeconds = RESOLUTION_SECONDS[effectiveRes] ?? 60;

  const defaultAvwapAnchor = resolveWindow(cfg, resSeconds, Date.now()).fromMs;

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
    if (btMode === "walkforward") {
      // Build the whole grid + schedule payload and hand it to BacktestButton
      // via wfoRequestSignal (its walk-forward branch consumes it). The request
      // range is holdout-clamped by BacktestButton itself, exactly as for a
      // sweep, so no extra clamp is needed here. Risk axes mirror the same way
      // the sweep branch mirrors them.
      try {
        const { payload } = buildWalkForwardPayload(mirrorRiskAxes(sweepAxes), wfoCfg);
        setWfoError(null);
        setWfoArchiveOpen(null);
        setWfoSchemeIndex(0); // a fresh run starts on the primary scheme, not a stale pick
        wfoRequestSignal.set(payload);
        sweepCombosOverrideSignal.set(null);
        run();
      } catch (e) {
        setWfoError(e instanceof Error ? e.message : String(e));
      }
      return;
    }
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
      {stageLabel(stage) && (
        <div className="sweep-progress"><span>{stageLabel(stage)}</span></div>
      )}
      {btMode === "backtest" && <BacktestPanel />}
      {/* Kept mounted whenever results exist, hidden with CSS when the mode
          isn't sweep: flipping Backtest↔Sweep would otherwise unmount and
          remount this whole tree, re-running the full derived cascade (plateau,
          sort, best-per-column, heatmap index) over every row and re-mounting
          the Tooltip-heavy DOM in one blocking commit — the large-sweep freeze.
          A display toggle keeps the memoized state and DOM alive, so the switch
          is instant. */}
      {sweepState ? (
        <div className="sweep-panel" style={btMode === "sweep" ? undefined : { display: "none" }}>
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
        btMode === "sweep" && (
          <div className="bt-results-empty">
            No sweep results yet. Turn on the sweep toggle next to the fields you want to
            vary, then press Run sweep.
          </div>
        )
      )}
      {/* Walk-forward results. A reopened archive takes priority; otherwise the
          live/last run's keep-mounted panel (same display toggle as the sweep
          panel above, so flipping modes never re-runs the results tree); with no
          run at all, the archive ranking list fills the area. */}
      {wfoArchiveState ? (
        <div className="wfo-panel" style={btMode === "walkforward" ? undefined : { display: "none" }}>
          <WfoResults
            state={wfoArchiveState}
            archiveId={wfoArchiveOpen!.id}
            onBackToArchive={() => setWfoArchiveOpen(null)}
            onApplyCombo={applySweepComboStable}
            onLoadFoldTable={loadWfoArchiveFoldTable}
            axes={[]}
            schemeIndex={wfoSchemeIndex}
            onSchemeIndex={setWfoSchemeIndex}
          />
        </div>
      ) : wfoState ? (
        <div className="wfo-panel" style={btMode === "walkforward" ? undefined : { display: "none" }}>
          {wfoState.cancelled ? (
            <div className="al-note">Cancelled after {wfoState.done} of {wfoState.total}</div>
          ) : wfoState.error ? (
            <div className="al-note bt-param-error">{wfoState.error}</div>
          ) : null}
          <WfoResults
            state={wfoState}
            onApplyCombo={applySweepComboStable}
            onLoadFoldTable={loadWfoFoldTable}
            axes={wfoUsableAxes}
            schemeIndex={wfoSchemeIndex}
            onSchemeIndex={(i) => {
              setWfoSchemeIndex(i);
              // Re-render this scheme's stitched OOS equity + fold bands on the
              // chart (BacktestButton owns the chart handle + last WFO result).
              wfoRenderRequest.set({ schemeIndex: i });
            }}
          />
        </div>
      ) : (
        btMode === "walkforward" && (
          <div className="wfo-panel">
            <WfoArchive epic={epic} onOpen={openWfoArchive} />
          </div>
        )
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
      wfoBadge={wfoState?.running ? (
        <span className="bt-mode-badge">{PHASE_LABEL[wfoState.phase] ?? wfoState.phase} {wfoState.done}/{wfoState.total}</span>
      ) : wfoComboTotal > 0 ? (
        <span className="bt-mode-badge">{wfoComboTotal}x{wfoCfg.trainSpans.length}</span>
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
    ) : btMode === "walkforward" && wfoState ? (
      wfoState.running ? (
        <button className="ghost" onClick={() => requestWfoCancel(true)}>
          Cancel walk-forward
        </button>
      ) : (
        <button className="ghost" onClick={() => wfoStateSignal.set(null)}>
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
    : btMode === "walkforward"
    ? [wfoDurationMs, !!wfoState?.running]
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
  const runLabel = runInFlight
    ? "Running…"
    : btMode === "walkforward"
      ? "Run walk-forward"
      : btMode === "sweep"
        ? "Run sweep"
        : "Run backtest";
  const runDisabled =
    runInFlight ||
    (btMode === "sweep" && sweepAxes.length === 0) ||
    (btMode === "walkforward" &&
      (wfoComboTotal === 0 || wfoCfg.trainSpans.length === 0 || !!wfoState?.running));

  // Resolved window drives the always-on From/To display in WFO mode, where the
  // range can be a rolling relative mode (fromMs/toMs unset). In non-WFO custom
  // mode we keep the raw value so an unpicked range shows blank inputs.
  const resolvedWindow = resolveWindow(cfg, resSeconds, Date.now());
  const pickerFromMs = btMode === "walkforward" ? resolvedWindow.fromMs : cfg.range.fromMs;
  const pickerToMs = btMode === "walkforward" ? resolvedWindow.toMs : cfg.range.toMs;

  const timeframeSelect = (
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
  );

  const holdoutSelect = (
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
  );

  const rangePicker = (
    <div className="al-row bt-range-row">
      <label className="bt-range-field">
        <span>From</span>
        <input
          type="datetime-local"
          value={pickerFromMs ? msToLocalInput(pickerFromMs) : ""}
          onChange={(e) => setRange({ mode: "custom", fromMs: localInputToMs(e.target.value) ?? undefined })}
        />
      </label>
      <label className="bt-range-field">
        <span>To</span>
        <input
          type="datetime-local"
          value={pickerToMs ? msToLocalInput(pickerToMs) : ""}
          onChange={(e) => setRange({ mode: "custom", toMs: localInputToMs(e.target.value) ?? undefined })}
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
              controller.focusChart?.();
            }
          }}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3 4v8M13 4v8M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </Tooltip>
    </div>
  );

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
                {btMode === "walkforward" ? (
                  <>
                    <Section
                      title="Data window"
                      info="The span of history walk-forward runs over. Set From/To directly, or use a quick-fill chip: relative chips roll with today, calendar chips pin a fixed year."
                    >
                      <div className="bt-wfo-range-col">
                        {/* Two quick-fill families: relative chips roll with today,
                            calendar chips pin a fixed year. The caption + divider encode
                            that difference so the two behaviors read at a glance. */}
                        <div className="bt-wfo-chips">
                          <div className="bt-wfo-chip-group">
                            <span className="bt-wfo-chip-cap">Roll</span>
                            <div className="bt-chip-row bt-range-chip-row bt-wfo-chip-row">
                              {WFO_RELATIVE_CHIPS.map((c) => (
                                <button
                                  key={c.mode}
                                  className={cfg.range.mode === c.mode ? "seg-on bt-chip" : "bt-chip"}
                                  onClick={() => setRange({ mode: c.mode, fromMs: undefined, toMs: undefined })}
                                >
                                  {c.label}
                                </button>
                              ))}
                            </div>
                          </div>
                          <span className="bt-wfo-chip-div" aria-hidden="true" />
                          <div className="bt-wfo-chip-group">
                            <span className="bt-wfo-chip-cap">Fixed</span>
                            <div className="bt-chip-row bt-range-chip-row bt-wfo-chip-row">
                              {buildRangeChips("year", Date.now(), chartTimezone).map((chip) => {
                                const on = cfg.range.fromMs === chip.fromMs && cfg.range.toMs === chip.toMs;
                                return (
                                  <button
                                    key={chip.label}
                                    className={on ? "seg-on bt-chip" : "bt-chip"}
                                    onClick={() => setRange({ mode: "custom", fromMs: chip.fromMs, toMs: chip.toMs })}
                                  >
                                    {chip.label}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                        {/* Labels on the first row, inputs aligned beneath them; TF/Holdout
                            columns hug their selects so From/To take the remaining width. */}
                        <div className="bt-wfo-window-grid">
                          <span className="bt-wfo-gl">From</span>
                          <span className="bt-wfo-gl">To</span>
                          <span />
                          <span />
                          <span className="bt-wfo-gl">
                            Timeframe
                            <InfoTip text="Timeframe the backtest runs on. 'Chart' follows the active chart timeframe." />
                          </span>
                          <span className="bt-wfo-gl">
                            Holdout
                            <InfoTip text="Reserve the last part of the range as an out-of-sample lockbox. Normal runs and sweeps stop at the training cutoff; use Evaluate on holdout to test the reserved tail. Every look is counted, because a holdout you check often stops being out-of-sample." />
                          </span>
                          <input
                            type="datetime-local"
                            className="bt-wfo-gi"
                            value={pickerFromMs ? msToLocalInput(pickerFromMs) : ""}
                            onChange={(e) => setRange({ mode: "custom", fromMs: localInputToMs(e.target.value) ?? undefined })}
                          />
                          <input
                            type="datetime-local"
                            className="bt-wfo-gi"
                            value={pickerToMs ? msToLocalInput(pickerToMs) : ""}
                            onChange={(e) => setRange({ mode: "custom", toMs: localInputToMs(e.target.value) ?? undefined })}
                          />
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
                                  controller.focusChart?.();
                                }
                              }}
                            >
                              <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
                                <path d="M3 4v8M13 4v8M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                              </svg>
                            </button>
                          </Tooltip>
                          <span />
                          <select
                            className="bt-wfo-gs"
                            aria-label="Timeframe"
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
                          <select
                            className="bt-wfo-gs"
                            aria-label="Holdout"
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
                        </div>
                      </div>
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
                      title="Schedule"
                      info="The train/test cadence walk-forward optimizes on: how much history each fold trains over, how far it tests forward, and which metric picks the winning cell."
                    >
                      <WfoConfig
                        cfg={wfoCfg}
                        onChange={changeWfoCfg}
                        comboTotal={wfoComboTotal}
                        droppedAxes={wfoDroppedAxes}
                      />
                    </Section>
                  </>
                ) : (
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
              {timeframeSelect}
              {/* This branch is non-WFO; the period sweep toggle never shows in WFO. */}
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
              {holdoutSelect}
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
            {cfg.range.mode === "custom" && rangePicker}
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
                )}

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
                    {btMode !== "walkforward" && (
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
                    )}
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
            exprPick={exprPick}
            sweep={{
              axes: displayAxes,
              side,
              editable: sweepEditable,
              onToggle: toggleRangeSweepAxis,
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
              {btMode === "walkforward" && sweepAxes.length === 0 && (
                <span className="sweep-counter">Turn on a field's sweep toggle to define the grid</span>
              )}
              {btMode === "walkforward" && wfoError && (
                <span className="sweep-counter bt-param-error">{wfoError}</span>
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
              {(btMode === "sweep" || btMode === "walkforward") && sweepAxes.length > 0 && remoteCompute && (
                <span className="bt-compute-toggle">
                  <Tooltip content={[
                    "Local: run the job on this machine.",
                    "Remote: run the job on the remote compute host.",
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
  exprPick,
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
  // "Pick from chart" arming, coordinated by the parent so only one row is armed
  // at a time. Absent with no chart (Live panel) — the button doesn't render.
  exprPick?: {
    armed: { group: "longEntry" | "longExit" | "shortEntry" | "shortExit"; row: number } | null;
    arm: (group: "longEntry" | "longExit" | "shortEntry" | "shortExit", row: number) => void;
    disarm: () => void;
  };
  // Task 9: optional per-operand-field sweep toggle for rule mode. Undefined
  // (coded mode's own RuleGroupSection use, the Live panel) renders as before.
  // `onToggleRisk` / `onKindChange` carry the SL/TP sweep toggle for the risk
  // block — separate from the rule-operand toggle (% step heuristic, drops
  // stale axes on a stop/target kind change).
  sweep?: {
    axes: SweepAxis[];
    side: "long" | "short";
    editable: boolean;
    onToggle: (target: string, current: number) => void;
    onToggleRisk: (target: string, current: number) => void;
    onKindChange: (field: "stop" | "target") => void;
    onAxisChange: (target: string, patch: Partial<Pick<RangeAxis, "from" | "to" | "step">>) => void;
  };
}) {
  const isLong = side === "long";
  const enabled = (isLong ? cfg.longEnabled : cfg.shortEnabled) !== false;
  const entry = isLong ? cfg.longEntry : cfg.shortEntry;
  const exit = isLong ? cfg.longExit : cfg.shortExit;
  // Bind the parent's arming API to one group key, so each rule section gets a
  // simple { armedRow, arm(row), disarm } view of the single shared armed state.
  const sidePick = (group: "longEntry" | "longExit" | "shortEntry" | "shortExit") =>
    exprPick
      ? {
          armedRow: exprPick.armed?.group === group ? exprPick.armed.row : null,
          arm: (row: number) => exprPick.arm(group, row),
          disarm: exprPick.disarm,
        }
      : undefined;

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
          pickIndicator={sidePick(isLong ? "longEntry" : "shortEntry")}
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
          pickIndicator={sidePick(isLong ? "longExit" : "shortExit")}
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
// "Fill from session" menu — a button, not a <select>. Picking a preset is a
// one-shot action (it fills From/To + tz + weekdays, then everything stays
// editable), so a stateful selector would lie about the current mask. A menu
// button reads as an action and never shows a stale "selected" value. Portaled
// to <body> so it escapes the modal's scroll clip.
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
  onRemove,
}: {
  enabled: boolean;
  onDuplicate: () => void;
  onCopy: () => void;
  onToggleEnabled: () => void;
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
            <li role="menuitem" onClick={() => run(onToggleEnabled)}>{enabled ? "Disable" : "Enable"}</li>
            <li role="menuitem" className="bt-rule-menu-danger" onClick={() => run(onRemove)}>Remove</li>
          </ul>,
          document.body,
        )}
    </div>
  );
}

// Task 13 Stage A: one rule row is now just an expression string (+ enabled).
// The loose shape lets this section accept both the new minimal `{ expr }` rows
// and the coexisting structured `Rule` rows the modal still stores in its config
// (a `Rule` is assignable to `ExprRow` because `expr`/`enabled` are optional).
type ExprRow = { expr?: string; enabled?: boolean };
type ExprGroupLike = { combine?: Combine; rules: ExprRow[] };

export function RuleGroupSection({
  title,
  info,
  group,
  onChange,
  emptyHint,
  clipboard,
  onCopy,
  groupClipboard,
  onCopyAll,
  pickIndicator,
  isExit = false,
  sweep,
}: {
  title: string;
  info?: string;
  group: ExprGroupLike;
  onChange: (g: RuleGroup) => void;
  emptyHint: string;
  // Retained for call-site compatibility with the coded/live rule surfaces; the
  // expression editor does not read them.
  defaultAvwapAnchor?: number;
  baseResolution?: string;
  clipboard?: Rule | null;
  onCopy?: (rule: Rule) => void;
  groupClipboard?: Rule[] | null;
  onCopyAll?: (rules: Rule[]) => void;
  // "Pick from chart" for THIS group: armedRow is the row armed
  // in this group (or null), arm/disarm toggle it. Absent with no chart.
  pickIndicator?: {
    armedRow: number | null;
    arm: (row: number) => void;
    disarm: () => void;
  };
  // Exit groups gate whether `entry` is a valid reference in the expression.
  isExit?: boolean;
  sweep?: {
    axes: SweepAxis[];
    side: "long" | "short";
    group: "entry" | "exit";
    editable: boolean;
    onToggle: (target: string, current: number) => void;
    onAxisChange: (target: string, patch: Partial<Pick<RangeAxis, "from" | "to" | "step">>) => void;
  };
}) {
  // Which row's insert palette is open (one at a time), or null when none.
  const [paletteRow, setPaletteRow] = useState<number | null>(null);
  // The open row's wrapper — covers the toggle, the expression input, and the
  // palette itself, so typing/inserting doesn't count as clicking outside.
  const paletteHostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (paletteRow === null) return;
    const onDown = (e: MouseEvent) => {
      if (paletteHostRef.current?.contains(e.target as Node)) return;
      setPaletteRow(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // The editor's own completion popup owns Escape while it's up; only take
      // the key once it's gone, and keep it from reaching the modal's closer.
      if (document.querySelector(".cm-tooltip-autocomplete")) return;
      e.stopPropagation();
      setPaletteRow(null);
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [paletteRow]);

  // Emit the group back to the parent. The stored config still types groups as
  // `RuleGroup`; the cast bridges the coexistence window (Stage C rewrites the
  // config's rule model to the expression shape, dropping the cast).
  const emit = (rules: ExprRow[]) => onChange({ ...group, rules } as RuleGroup);

  // Wipe every rule in this group, gated behind a confirm (unlike the per-row
  // delete, which is cheap to undo by re-adding one rule).
  function clearAll() {
    requestConfirm({
      title: "Delete all rules",
      message: `Remove all ${group.rules.length} rule${group.rules.length === 1 ? "" : "s"} from ${title}?`,
      confirmLabel: "Delete all",
      onConfirm: () => emit([]),
    });
  }
  // Copy the whole group's rules, and paste a copied set (appending independent
  // clones so they can land in another side/leg without sharing references).
  function copyAll() {
    onCopyAll?.(group.rules as Rule[]);
  }
  function pasteAll() {
    if (groupClipboard?.length) {
      emit([...group.rules, ...groupClipboard.map(cloneRule)]);
    }
  }
  // Write one field of a single row back, cloning the row so unrelated rows keep
  // their identity. Expr rows are flat, so a spread is a full copy.
  function patchRule(i: number, patch: Partial<ExprRow>) {
    const rules = group.rules.slice();
    rules[i] = { ...rules[i], ...patch };
    emit(rules);
  }
  function addRule() {
    emit([...group.rules, { expr: "", enabled: true }]);
  }
  function removeRule(i: number) {
    emit(group.rules.filter((_, idx) => idx !== i));
  }
  // Insert an independent copy right after the source row, so a duplicated rule
  // reads as a variation of the one above it rather than landing at the bottom.
  function duplicateRule(i: number) {
    const rules = group.rules.slice();
    rules.splice(i + 1, 0, { ...rules[i] });
    emit(rules);
  }
  // Paste appends — the clipboard rule may come from another group entirely, so
  // there's no "source row" here to sit beneath.
  function pasteRule() {
    if (clipboard) emit([...group.rules, cloneRule(clipboard)]);
  }
  // Palette insert (Stage A): append the picked token to the row's expression.
  // A cursor-aware insert is a later refinement; append keeps the wiring simple.
  function insertInto(i: number, text: string) {
    patchRule(i, { expr: (group.rules[i].expr ?? "") + text });
  }

  return (
    <Section
      title={title}
      info={info}
      // Group-wide actions (copy-all / clear-all) sit beside the section title.
      // Keeping them off their own row means a single-rule group doesn't leave an
      // empty band between the heading and its one rule.
      extra={
        group.rules.length > 0 ? (
          <div className="bt-groophead-actions">
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
      {group.rules.map((rule, i) => {
        // Expr rows only touch `expr`/`enabled`; the alias keeps the copy handler
        // typed against the stored `Rule` shape.
        const r = rule as Rule;
        // A disabled row is frozen: the editor goes read-only, and the two
        // controls that write into it (palette insert, pick-from-chart) go with
        // it — otherwise they'd keep editing an expression you can't type in.
        const off = rule.enabled === false;
        return (
        <Fragment key={i}>
        <div
          className={`bt-rule-row${off ? " bt-rule-disabled" : ""}`}
          ref={paletteRow === i ? paletteHostRef : undefined}
        >
          <div className="bt-rule-main">
            <RuleExpressionInput
              value={rule.expr ?? ""}
              onChange={(expr) => patchRule(i, { expr })}
              isExit={isExit}
              readOnly={off}
              placeholder="e.g. EMA(9) > EMA(21)"
            />
            <div className="bt-rule-actions">
              <Tooltip
                content={
                  off
                    ? "Enable this rule to edit it"
                    : paletteRow === i
                      ? "Hide the insert palette"
                      : "Insert an indicator, candle field, or timeframe"
                }
              >
                <button
                  type="button"
                  className={`bt-rule-toggle bt-palette-toggle${paletteRow === i ? " on" : ""}`}
                  onClick={() => setPaletteRow(paletteRow === i ? null : i)}
                  disabled={off}
                  aria-label={paletteRow === i ? "Hide the insert palette" : "Insert from palette"}
                  aria-expanded={paletteRow === i}
                >
                  {paletteRow === i ? "−" : "+"}
                </button>
              </Tooltip>
              {pickIndicator && (
                <Tooltip
                  content={
                    off
                      ? "Enable this rule to edit it"
                      : pickIndicator.armedRow === i
                        ? "Click an indicator on the chart, or click here to cancel"
                        : "Pick an indicator from the chart"
                  }
                >
                  <button
                    type="button"
                    className={`bt-rule-toggle bt-pick-toggle${pickIndicator.armedRow === i ? " on" : ""}`}
                    onClick={() =>
                      pickIndicator.armedRow === i ? pickIndicator.disarm() : pickIndicator.arm(i)
                    }
                    disabled={off}
                    aria-label="Pick an indicator from the chart"
                    aria-pressed={pickIndicator.armedRow === i}
                  >
                    ◎
                  </button>
                </Tooltip>
              )}
              <RuleMenu
                enabled={!off}
                onDuplicate={() => duplicateRule(i)}
                onCopy={() => onCopy?.(r)}
                onToggleEnabled={() => {
                  // Turning a row off closes anything it had open, so the frozen
                  // row can't be left with a live palette or an armed picker.
                  if (!off) {
                    if (paletteRow === i) setPaletteRow(null);
                    if (pickIndicator?.armedRow === i) pickIndicator.disarm();
                  }
                  patchRule(i, { enabled: off });
                }}
                onRemove={() => removeRule(i)}
              />
            </div>
          </div>
          {paletteRow === i && (
            <RulePalette onInsert={(text) => insertInto(i, text)} />
          )}
        </div>
        {sweep?.editable && rule.enabled !== false && (() => {
          // lit: targets address rows by RAW full-list index i (the expr request
          // ships every row, disabled included), NOT activeRuleIndex(i).
          const { literals } = analyze(rule.expr ?? "", { isExit });
          if (!literals.length) return null;
          return (
            <div className="sp-row sweep-axis-row bt-lit-sweep-row">
              <span className="sp-label">sweep</span>
              <span className="bt-chip-row">
                {literals.map((lit) => {
                  const target = sweepLiteralTarget(sweep.side, sweep.group, i, lit.ordinal);
                  const axis = sweep.axes.find(
                    (a) => a.target === target && a.kind === "range",
                  ) as RangeAxis | undefined;
                  return axis ? (
                    <span key={lit.ordinal} className="bt-lit-axis">
                      <span className="sp-label">{lit.label}</span>
                      <RangeChip
                        axis={axis}
                        onPatch={(p) => sweep.onAxisChange(target, p)}
                        onRemove={() => sweep.onToggle(target, lit.value)}
                      />
                    </span>
                  ) : (
                    <button
                      key={lit.ordinal}
                      type="button"
                      className="bt-chip"
                      onClick={() => sweep.onToggle(target, lit.value)}
                      title={`Sweep ${lit.label}`}
                    >
                      {lit.label} {lit.value}
                    </button>
                  );
                })}
              </span>
            </div>
          );
        })()}
        </Fragment>
        );
      })}
      <div className="bt-rule-foot">
        <button className="ghost" onClick={addRule}>
          + Add rule
        </button>
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
