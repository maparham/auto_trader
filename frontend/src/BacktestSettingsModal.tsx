// Backtest strategy builder: time range + history depth, entry/exit rule
// groups, costs, and named presets. Matches the app's other modals exactly
// (useDraggable/useCloseOnEscape/CloseButton, .modal-backdrop/.modal/.modal-head/
// .modal-foot) — no shared wrapper, no portal.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import CloseButton from "./CloseButton";
import ChartOperandPicker from "./ChartOperandPicker";
import InfoTip from "./components/InfoTip";
import NumberField from "./components/NumberField";
import Tooltip from "./components/Tooltip";
import { msToLocalInput, localInputToMs } from "./lib/alertUi";
import { requestGoLive, requestConfirm, backtestClearRequest } from "./lib/signals";
import { enumerateChartOperands } from "./lib/chartOperandEnumerate";
import type { EmphasisTarget } from "./lib/chartOperand";
import { resolveWindow } from "./lib/backtestWindow";
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
import { SESSION_PRESETS, buildRangeChips, coverage, isActive, resolveMask } from "./lib/backtestSchedule";
import type { ChartController } from "./lib/chartController";
import BacktestPanel from "./BacktestPanel";
import {
  loadBacktestPresets,
  saveBacktestPreset,
  deleteBacktestPreset,
  saveBacktestLastUsed,
  loadBacktestSide,
  saveBacktestSide,
  loadBacktestSplit,
  saveBacktestSplit,
} from "./lib/persist";

interface Props {
  initial: BacktestConfig;
  epic: string;
  resolution: string;
  // The focused chart cell, so "Pick Range" can arm a drag-select on it. Null when
  // no cell is focused — the button is then disabled.
  controller: ChartController | null;
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

// The timezone the mask/chips are evaluated in. A chosen session carries its own
// tz (resolveMask inlines it), so honour that here too; else the explicit tz;
// else UTC (wiring the instrument's exchange tz is a deferred follow-up).
function maskTz(cfg: BacktestConfig): string {
  const m = cfg.range.mask;
  if (m?.session) return SESSION_PRESETS[m.session].tz;
  return m?.tz ?? "UTC";
}

function toggle(list: number[] | undefined, v: number): number[] {
  const s = new Set(list ?? []);
  if (s.has(v)) s.delete(v);
  else s.add(v);
  return [...s].sort((a, b) => a - b);
}
function minToTime(min: number | undefined): string {
  if (min == null) return "";
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
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
  { value: "crossesAbove", label: "crosses above", tip: "Fires once — the bar the left rises through the right." },
  { value: "crossesBelow", label: "crosses below", tip: "Fires once — the bar the left drops through the right." },
  { value: "crosses", label: "crosses", tip: "Fires once — the bar the left crosses the right in either direction." },
  { value: "gt", label: "greater than", tip: "True on every bar the left is above the right." },
  { value: "lt", label: "less than", tip: "True on every bar the left is below the right." },
  { value: "gte", label: "greater or equal", tip: "True on every bar the left is at or above the right." },
  { value: "lte", label: "less or equal", tip: "True on every bar the left is at or below the right." },
];

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

const DATE_OPTS: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };
const TIME_OPTS: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };

function formatDateRange(fromMs: number, toMs: number): string {
  const from = new Date(fromMs);
  const to = new Date(toMs);
  const sameYear = from.getFullYear() === to.getFullYear();
  const fromLabel = from.toLocaleString([], { ...(sameYear ? { day: "numeric", month: "short" } : DATE_OPTS), ...TIME_OPTS });
  const toLabel = to.toLocaleString([], { ...DATE_OPTS, ...TIME_OPTS });
  return `${fromLabel} – ${toLabel}`;
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
  return formatDateRange(fromMs, toMs);
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
  const depth = cfg.range.history ?? "full";
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

export default function BacktestSettingsModal({ initial, epic, resolution, controller, onRun, onClose }: Props) {
  const [cfg, setCfg] = useState<BacktestConfig>(initial);
  // True while "Pick Range" is armed on the chart (mirrors the controller signal),
  // so the button reflects the active state.
  const [pickingRange, setPickingRange] = useState(false);
  const [presets, setPresets] = useState(() => loadBacktestPresets());
  const [presetName, setPresetName] = useState("");
  const [loadName, setLoadName] = useState("");
  // Restore the last-viewed tab (device-local) and persist it on switch, so
  // re-opening the modal returns to the side you were working on.
  const [side, setSide] = useState<"long" | "short">(loadBacktestSide);
  const [tab, setTab] = useState<BacktestTab>("period");
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
    const resolved = resolveMask(m);
    return { grid, resolved, cov: coverage(grid, resolved) };
     
  }, [cfg, resSeconds]);
  function setCosts(patch: Partial<Costs>) {
    setCfg({ ...cfg, costs: { ...cfg.costs, ...patch } });
  }
  function setGroup(which: "longEntry" | "longExit" | "shortEntry" | "shortExit", group: RuleGroup) {
    setCfg({ ...cfg, [which]: group });
  }

  // Docked panel: running does NOT close it, so you can tweak and re-run
  // against the chart beside it. The header ✕ is the only close. Results live in
  // the always-visible bottom pane, so there's no tab to jump to — but a run
  // must expand the results pane if the user had collapsed it.
  function run() {
    onRun(cfg);
    setSplit((s) => (s.collapsed ? { ...s, collapsed: false } : s));
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
    if (p) setCfg(p);
  }
  function removePreset(name: string) {
    deleteBacktestPreset(name);
    setPresets(loadBacktestPresets());
    if (loadName === name) setLoadName("");
  }

  return (
    <>
    <aside className="bt-cfg-panel">
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
            </div>
            {CHIP_UNIT[cfg.range.mode] && (
              <div className="bt-chip-row">
                {buildRangeChips(CHIP_UNIT[cfg.range.mode]!, Date.now(), maskTz(cfg)).map((chip) => {
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
              </div>
            )}
            <div className="al-note bt-range-subtitle">{rangeDateLabel(cfg, resSeconds)}</div>
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
                        : "Pick the range on the chart — drag across the time axis, or click a start then an end"
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
          </Section>

          <Section
            title="Repeat / active windows"
            info="Restrict trading to recurring windows — weekdays, months, days of the month, or a market session. Outside them the strategy opens no new positions; an open position keeps running unless you enable closing at session close."
          >
            <label className="al-row bt-mask-toggle">
              <input
                type="checkbox"
                checked={cfg.range.mask?.enabled ?? false}
                onChange={(e) => setMask({ enabled: e.target.checked })}
              />
              <span>Only trade during selected windows</span>
              <InfoTip text="When on, the strategy only opens positions inside the windows you pick below. Positions already open keep running unless you also close them at session close." />
            </label>

            {cfg.range.mask?.enabled && (
              <>
                <label className="al-row bt-mask-toggle bt-mask-subtoggle">
                  <input
                    type="checkbox"
                    checked={cfg.range.mask?.flattenAtClose ?? false}
                    onChange={(e) => setMask({ flattenAtClose: e.target.checked })}
                  />
                  <span>Close open positions at session close</span>
                  <InfoTip
                    text={[
                      "Off (default): a position opened inside a window keeps running past the session boundary until its stop or target hits (or the backtest range ends).",
                      "On: any open position is force-flattened at each session close — the previous behavior.",
                    ]}
                  />
                </label>

                <div className="bt-chip-row">
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

                <div className="al-row bt-range-row">
                  <label className="bt-range-field">
                    <span className="bt-field-label">
                      Session
                      <InfoTip text="Preset market hours with the right timezone — e.g. NYSE 09:30–16:00 New York. Only meaningful on intraday timeframes." />
                    </span>
                    <select
                      disabled={resSeconds >= 86400}
                      value={cfg.range.mask?.session ?? ""}
                      onChange={(e) =>
                        setMask({ session: (e.target.value || undefined) as SessionPreset | undefined })
                      }
                    >
                      <option value="">Custom / none</option>
                      {Object.entries(SESSION_PRESETS).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="bt-range-field">
                    <span className="bt-field-label">
                      Timezone
                      <InfoTip text="Timezone used to evaluate the weekday, day-of-month and clock filters (and the calendar chips). A session sets this for you." />
                    </span>
                    <input
                      type="text"
                      disabled={!!cfg.range.mask?.session}
                      value={
                        cfg.range.mask?.session
                          ? SESSION_PRESETS[cfg.range.mask.session].tz
                          : cfg.range.mask?.tz ?? "UTC"
                      }
                      onChange={(e) => setMask({ tz: e.target.value })}
                    />
                  </label>
                </div>

                {cfg.range.mask?.session &&
                  !cfg.range.mask?.daysOfWeek?.length &&
                  SESSION_PRESETS[cfg.range.mask.session].days && (
                    <div className="al-note">
                      {SESSION_PRESETS[cfg.range.mask.session].label} trades Mon–Fri —
                      weekends are excluded automatically. Pick weekday chips above to override.
                    </div>
                  )}

                {!cfg.range.mask?.session && (
                  <div className="al-row bt-range-row">
                    <label className="bt-range-field">
                      <span>From</span>
                      <input
                        type="time"
                        disabled={resSeconds >= 86400}
                        value={minToTime(cfg.range.mask?.timeOfDay?.startMin)}
                        onChange={(e) => setMask({ timeOfDay: withStart(cfg.range.mask?.timeOfDay, timeToMin(e.target.value)) })}
                      />
                    </label>
                    <label className="bt-range-field">
                      <span>To</span>
                      <input
                        type="time"
                        disabled={resSeconds >= 86400}
                        value={minToTime(cfg.range.mask?.timeOfDay?.endMin)}
                        onChange={(e) => setMask({ timeOfDay: withEnd(cfg.range.mask?.timeOfDay, timeToMin(e.target.value)) })}
                      />
                    </label>
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
            info="How much history to load before the window so indicators are warmed up when trading starts. It never adds trades — only the range above does."
          >
            <div className="al-note">
              Indicators warm up on history loaded before the window — trades still only open once
              the window starts.
            </div>
            <div className="seg">
              {HISTORY_DEPTHS.map((h) => (
                <button
                  key={h.value}
                  className={(cfg.range.history ?? "full") === h.value ? "seg-on" : ""}
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
          />

          {usesVolume && (
            <div className="al-note">
              Volume-based operands (Volume, Volume-MA, AVWAP) read 0 on epics that don't report
              trade volume (e.g. many forex/CFD instruments) — they'll never fire there.
            </div>
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
                  <InfoTip text="Flat cost charged on each entry and each exit — a round trip pays it twice." />
                </span>
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={cfg.costs.commissionPerSide}
                  onChange={(e) => setCosts({ commissionPerSide: Number(cleanNumInput(e.currentTarget)) })}
                />
              </label>
              <label className="bt-field">
                <span className="bt-field-label">
                  Slippage
                  <InfoTip text="Price penalty applied to every fill, in the instrument's price units — you buy a bit higher and sell a bit lower." />
                </span>
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={cfg.costs.slippage}
                  onChange={(e) => setCosts({ slippage: Number(cleanNumInput(e.currentTarget)) })}
                />
              </label>
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
            </div>
            <label className="al-row bt-mask-toggle">
              <input
                type="checkbox"
                checked={cfg.showEquity ?? false}
                onChange={(e) => setCfg({ ...cfg, showEquity: e.target.checked })}
              />
              <span>Show equity curve</span>
              <InfoTip text="Draw the account balance over time in its own sub-pane after a run. Off by default; shown only on the backtest's own timeframe." />
            </label>
          </Section>
            </section>

            <section className="bt-scroll-section" ref={setRef("presets")}>
          <Section
            title="Presets"
            info="Save the whole configuration — range, mask, rules, risk, and costs — under a name, and reload it later."
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

        {!split.collapsed && (
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

        <div className={`bt-results-region${split.collapsed ? " collapsed" : ""}`} style={resultsStyle}>
          <button className="bt-results-toggle" onClick={toggleResults} aria-expanded={!split.collapsed}>
            <span className={`bt-results-chevron${split.collapsed ? " collapsed" : ""}`} aria-hidden="true">
              ▾
            </span>
            Results
          </button>
          {!split.collapsed && <BacktestPanel />}
        </div>
        </div>

        <div className="modal-foot bt-cfg-foot">
          <button className="ghost" onClick={onClose}>
            Close
          </button>
          <button
            className="ghost bt-golive"
            title="Copy this strategy into the Live panel to trade a demo/live account"
            onClick={() => requestGoLive(cfg)}
          >
            Go live →
          </button>
          <button onClick={run}>Run backtest</button>
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

// The stop/target block for one side. A stop is one dropdown (fixed %/price/ATR
// or trailing %/ATR); a target is the same minus the trailing kinds. Off by
// default (kind "none") so existing presets are untouched. ATR kinds expose a
// length (default 14); % / trailing % expose a percent; ATR kinds expose a
// multiple; fixed price exposes an absolute level.
export function RiskSection({
  risk,
  onChange,
}: {
  risk: RiskConfig;
  onChange: (r: RiskConfig) => void;
}) {
  const setStopKind = (kind: StopKind) => {
    const next: RiskConfig["stop"] = { kind };
    if (kind === "atr" || kind === "trailAtr") { next.mult = risk.stop.mult ?? 2; next.length = risk.stop.length ?? 14; }
    else if (kind === "pct" || kind === "trailPct") next.value = risk.stop.value ?? 2;
    else if (kind === "price") next.value = risk.stop.value ?? 0;
    onChange({ ...risk, stop: next });
  };
  const setTargetKind = (kind: TargetKind) => {
    const next: RiskConfig["target"] = { kind };
    if (kind === "atr") { next.mult = risk.target.mult ?? 3; next.length = risk.target.length ?? 14; }
    else if (kind === "pct") next.value = risk.target.value ?? 4;
    else if (kind === "price") next.value = risk.target.value ?? 0;
    onChange({ ...risk, target: next });
  };
  // `floor` opts a field into positive-only: block negatives and snap ≤0 up to
  // the floor on blur. Left off for price levels / ATR multiples, which are free.
  const num = (v: number | undefined, set: (n: number) => void, step = "any", floor?: number) =>
    // Decimal fields go through NumberField so the dot is always the decimal
    // separator regardless of locale (native number inputs follow the locale and
    // reject "." on comma-decimal machines). Integer fields ("1" step) have no
    // separator to worry about, so keep the native input and its spinner.
    step === "any" ? (
      <NumberField value={v} onChange={set} floor={floor} className="bt-num" />
    ) : (
      <input type="number" step={step} value={v ?? 0} className="bt-num" min={floor}
        onKeyDown={floor != null ? blockNegKeys : undefined}
        onChange={(e) => set(Number(cleanNumInput(e.currentTarget)))}
        onBlur={floor != null ? (e) => clampPosOnBlur(e.currentTarget, floor, set) : undefined} />
    );

  return (
    <div className="bt-risk">
      <SectionTitle info="Price-level exits for this side. Whichever triggers first — stop, target, or a close rule — ends the trade.">
        Stop &amp; take profit
      </SectionTitle>
      <div className="bt-risk-row">
        <span className="bt-risk-label">Stop</span>
        <select value={risk.stop.kind} onChange={(e) => setStopKind(e.target.value as StopKind)}>
          {STOP_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
        {(risk.stop.kind === "pct" || risk.stop.kind === "trailPct") &&
          <>{num(risk.stop.value, (n) => onChange({ ...risk, stop: { ...risk.stop, value: n } }), "any", 0.01)}<span>%</span></>}
        {(risk.stop.kind === "atr" || risk.stop.kind === "trailAtr") && <>
          {num(risk.stop.mult, (n) => onChange({ ...risk, stop: { ...risk.stop, mult: n } }))}
          <span>× ATR</span>
          {num(risk.stop.length, (n) => onChange({ ...risk, stop: { ...risk.stop, length: Math.max(1, Math.round(n)) } }), "1")}
        </>}
        {risk.stop.kind === "price" &&
          num(risk.stop.value, (n) => onChange({ ...risk, stop: { ...risk.stop, value: n } }))}
      </div>
      <div className="bt-risk-row">
        <span className="bt-risk-label">Take profit</span>
        <select value={risk.target.kind} onChange={(e) => setTargetKind(e.target.value as TargetKind)}>
          {TARGET_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
        {risk.target.kind === "pct" &&
          <>{num(risk.target.value, (n) => onChange({ ...risk, target: { ...risk.target, value: n } }), "any", 0.01)}<span>%</span></>}
        {risk.target.kind === "atr" && <>
          {num(risk.target.mult, (n) => onChange({ ...risk, target: { ...risk.target, mult: n } }))}
          <span>× ATR</span>
          {num(risk.target.length, (n) => onChange({ ...risk, target: { ...risk.target, length: Math.max(1, Math.round(n)) } }), "1")}
        </>}
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
}) {
  const isLong = side === "long";
  const enabled = (isLong ? cfg.longEnabled : cfg.shortEnabled) !== false;
  const entry = isLong ? cfg.longEntry : cfg.shortEntry;
  const exit = isLong ? cfg.longExit : cfg.shortExit;

  return (
    <>
      <div className="bt-arm">
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={`Trade the ${side} side`}
          className={`bt-switch${enabled ? " on" : ""}`}
          onClick={() => setCfg({ ...cfg, [isLong ? "longEnabled" : "shortEnabled"]: !enabled })}
        >
          <span className="bt-switch-knob" />
        </button>
        {/* Visible label/state are decorative — the switch's aria-label + aria-checked
            already carry the accessible name and on/off, so hide these to avoid a
            doubled screen-reader announcement. */}
        <span className="bt-arm-label" aria-hidden="true">Trade the {side} side</span>
        <span className={`bt-arm-state${enabled ? " on" : ""}`} aria-hidden="true">{enabled ? "Trading" : "Parked"}</span>
      </div>
      {!enabled && (
        <div className="al-note bt-parked-note">
          Rules are kept — the {side} side won't open or close positions until you switch it back on.
        </div>
      )}
      <div className={`bt-side-rules${enabled ? "" : " bt-parked"}`}>
        <RuleGroupSection
          title={isLong ? "Buy to open" : "Sell to open"}
          info={`Conditions that open a ${side} position. Multiple rules combine with the AND/OR switch.`}
          group={entry}
          onChange={(g) => setGroup(isLong ? "longEntry" : "shortEntry", g)}
          emptyHint={`No ${side}-entry rules — this strategy won't open any ${side} positions.`}
          defaultAvwapAnchor={defaultAvwapAnchor}
          baseResolution={baseResolution}
          clipboard={clipboard}
          onCopy={onCopy}
          groupClipboard={groupClipboard}
          onCopyAll={onCopyAll}
          openChartPicker={openChartPicker}
        />
        <RuleGroupSection
          title={isLong ? "Sell to close" : "Buy to close"}
          info={`Conditions that close an open ${side} position. A stop or target can close it first.`}
          group={exit}
          onChange={(g) => setGroup(isLong ? "longExit" : "shortExit", g)}
          emptyHint={`No ${side}-exit rules — an open ${side} holds until the trading window ends.`}
          defaultAvwapAnchor={defaultAvwapAnchor}
          baseResolution={baseResolution}
          clipboard={clipboard}
          onCopy={onCopy}
          groupClipboard={groupClipboard}
          onCopyAll={onCopyAll}
          openChartPicker={openChartPicker}
          isExit
        />
        <RiskSection
          risk={(isLong ? cfg.longRisk : cfg.shortRisk) ?? EMPTY_RISK}
          onChange={(r) => setCfg({ ...cfg, [isLong ? "longRisk" : "shortRisk"]: r })}
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
function SectionTitle({ info, children }: { info?: string | string[]; children: ReactNode }) {
  return (
    <div className="instrument-section-title bt-section-title">
      <span>{children}</span>
      {info && <InfoTip text={info} />}
    </div>
  );
}

function Section({ title, info, children }: { title: string; info?: string | string[]; children: ReactNode }) {
  return (
    <div className="bt-section">
      <SectionTitle info={info}>{title}</SectionTitle>
      {children}
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

function OperatorPicker({ value, onChange }: { value: Operator; onChange: (op: Operator) => void }) {
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
      <button
        ref={btnRef}
        type="button"
        className={`bt-op-btn ${isCrossOp(value) ? "bt-op-cross" : "bt-op-compare"}${open ? " open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Operator: ${current?.label}`}
        title={current?.label}
        onClick={toggle}
      >
        <OpGlyph op={value} />
      </button>
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

function KebabIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <circle cx="12" cy="5" r="1.7" fill="currentColor" />
      <circle cx="12" cy="12" r="1.7" fill="currentColor" />
      <circle cx="12" cy="19" r="1.7" fill="currentColor" />
    </svg>
  );
}

// Enable/disable shortcut: an open eye when the rule is active, a slashed eye
// when it's disabled (dropped from the run but kept).
function EyeIcon({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="2.6" />
      {!on && <path d="M4 20 L20 4" strokeLinecap="round" />}
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
      <button
        ref={btnRef}
        type="button"
        className={`bt-rule-menu-btn${open ? " open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Rule actions"
        title="Rule actions"
        onClick={toggle}
      >
        <KebabIcon />
      </button>
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

  return (
    <Section title={title} info={info}>
      {group.rules.length === 0 && (
        <div className="al-note bt-empty-rules">
          {emptyHint}
          {openChartPicker && (
            <div className="bt-empty-actions">
              <Tooltip content="Add a rule seeded from a chart indicator or drawing">
                <button
                  className="ghost"
                  onClick={() => openChartPicker((op) => onChange({ ...group, rules: [ruleFromChartOperand(op)] }))}
                >
                  + Rule from chart
                </button>
              </Tooltip>
            </div>
          )}
        </div>
      )}
      {group.rules.length > 0 && (
        <div className="bt-rule-groophead">
          {group.rules.length > 1 && (
            <div className="seg">
              <button className={group.combine === "AND" ? "seg-on" : ""} onClick={() => setCombine("AND")}>
                AND
              </button>
              <button className={group.combine === "OR" ? "seg-on" : ""} onClick={() => setCombine("OR")}>
                OR
              </button>
            </div>
          )}
          <div className="bt-groophead-actions">
            <button
              className="bt-rule-toggle bt-reverse-ops"
              onClick={reverseAll}
              title="Flip every operator to its opposite (> ↔ <, crosses above ↔ below)"
              aria-label="Reverse operators"
            >
              <ReverseOpsIcon />
            </button>
            <button
              className="bt-rule-toggle bt-copyall"
              onClick={copyAll}
              title="Copy all rules in this group"
              aria-label="Copy all rules"
            >
              <CopyAllIcon />
            </button>
            <button
              className="bt-rule-toggle bt-clearall"
              onClick={clearAll}
              title="Delete all rules in this group"
              aria-label="Delete all rules"
            >
              <TrashIcon />
            </button>
          </div>
        </div>
      )}
      {group.rules.map((rule, i) => (
        <div className={`bt-rule-row${rule.enabled === false ? " bt-rule-disabled" : ""}`} key={i}>
          <OperandPicker value={rule.left} onChange={(left) => setRule(i, { ...rule, left })} defaultAvwapAnchor={defaultAvwapAnchor} baseResolution={baseResolution} allowEntry={isExit} siblingSloped={slopeLen(rule.right) !== null} openChartPicker={openChartPicker} />
          <OperatorPicker value={rule.op} onChange={(op) => setRule(i, { ...rule, op })} />
          <OperandPicker value={rule.right} onChange={(right) => setRule(i, { ...rule, right })} defaultAvwapAnchor={defaultAvwapAnchor} baseResolution={baseResolution} allowEntry={isExit} siblingSloped={slopeLen(rule.left) !== null} openChartPicker={openChartPicker} />
          {isExit && <CountField value={rule.count} onChange={(count) => setRule(i, { ...rule, count })} />}
          <div className="bt-rule-actions">
            <button
              className="bt-rule-toggle"
              onClick={() => setRule(i, { ...rule, enabled: rule.enabled === false })}
              title={rule.enabled === false ? "Enable rule" : "Disable rule"}
              aria-label={rule.enabled === false ? "Enable rule" : "Disable rule"}
              aria-pressed={rule.enabled !== false}
            >
              <EyeIcon on={rule.enabled !== false} />
            </button>
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
            <button
              className="bt-rule-toggle bt-rule-delete"
              onClick={() => removeRule(i)}
              title="Delete rule"
              aria-label="Delete rule"
            >
              <TrashIcon />
            </button>
            <RuleMenu
              enabled={rule.enabled !== false}
              onDuplicate={() => duplicateRule(i)}
              onCopy={() => onCopy(rule)}
              onToggleEnabled={() => setRule(i, { ...rule, enabled: rule.enabled === false })}
              onRemove={() => removeRule(i)}
            />
          </div>
        </div>
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
          <button className="ghost" onClick={pasteRule} title="Paste the copied rule here">
            Paste rule
          </button>
        )}
        {groupClipboard?.length ? (
          <button
            className="ghost bt-pasteall"
            onClick={pasteAll}
            title={`Paste all ${groupClipboard.length} copied rule${groupClipboard.length > 1 ? "s" : ""} here`}
          >
            <CopyAllIcon /> Paste all
          </button>
        ) : null}
      </div>
    </Section>
  );
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
function CountField({ value, onChange }: { value?: number; onChange: (n?: number) => void }) {
  const n = value && value > 1 ? value : undefined;
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
    <Tooltip
      content={[
        "Fire on the Nth time since entry this condition is true.",
        "Counts every bar it's true, consecutive or not. Blank or 1 = the first time.",
      ]}
    >
      <label className={`bt-rule-count${n ? " on" : ""}`}>
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
      </label>
    </Tooltip>
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
}) {
  // Slope can wrap an indicator, a price, or a pasted chart operand (not a constant
  // or the entry price).
  const canSlope = value.kind === "indicator" || value.kind === "price" || value.kind === "series";
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
    if (token === "price") return onChange({ kind: "price", field: "close", slope: prevSlope });
    if (token === "const") return onChange({ kind: "const", value: 0 });
    if (token === "entry") return onChange({ kind: "entry" });
    const indicator = token as IndicatorKind;
    if (indicator === "AVWAP") onChange({ kind: "indicator", indicator, anchor: defaultAvwapAnchor, slope: prevSlope });
    else if (NO_LENGTH.includes(indicator)) onChange({ kind: "indicator", indicator, slope: prevSlope });
    else onChange({ kind: "indicator", indicator, length: prevLength ?? 9, slope: prevSlope });
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
                onClick={() => onChange({ kind: "const", value: 0 })}
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
            <select
              className="bt-operand-tf"
              title="Timeframe this operand is computed on"
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
            <input
              type="number"
              min={1}
              className="bt-operand-length"
              value={value.length ?? 9}
              onKeyDown={blockNegKeys}
              onChange={(e) => onChange({ ...value, length: Number(cleanNumInput(e.currentTarget)) })}
              onBlur={(e) => clampPosOnBlur(e.currentTarget, 1, (n) => onChange({ ...value, length: n }))}
            />
          )}
          <select
            className="bt-operand-tf"
            title="Timeframe this indicator is computed on"
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
          <input
            type="number"
            step="any"
            className="bt-operand-length"
            value={value.value}
            onChange={(e) => onChange({ kind: "const", value: Number(cleanNumInput(e.currentTarget)) })}
          />
          {siblingSloped && <span className="bt-operand-unit">%/hr</span>}
        </>
      )}
      {openChartPicker && (
        <Tooltip content="Add a chart indicator or drawing as this operand">
          <button
            type="button"
            className="bt-operand-add"
            onClick={() => openChartPicker((op) => {
              if (prevSlope && (op.kind === "indicator" || op.kind === "price" || op.kind === "series")) {
                onChange({ ...op, slope: prevSlope });
              } else {
                onChange(op);
              }
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

