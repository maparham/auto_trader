// Backtest strategy builder: time range + history depth, entry/exit rule
// groups, costs, and named presets. Matches the app's other modals exactly
// (useDraggable/useCloseOnEscape/CloseButton, .modal-backdrop/.modal/.modal-head/
// .modal-foot) — no shared wrapper, no portal.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import CloseButton from "./CloseButton";
import InfoTip from "./components/InfoTip";
import { useDraggable } from "./lib/useDraggable";
import { useCloseOnEscape } from "./lib/useCloseOnEscape";
import { msToLocalInput, localInputToMs } from "./lib/alertUi";
import { RESOLUTION_SECONDS } from "./lib/feed";
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
  type RiskConfig,
  type StopKind,
  type TargetKind,
  type ScalingConfig,
} from "./lib/backtestConfig";
import {
  loadBacktestPresets,
  saveBacktestPreset,
  deleteBacktestPreset,
  loadBacktestSide,
  saveBacktestSide,
} from "./lib/persist";

interface Props {
  initial: BacktestConfig;
  epic: string;
  resolution: string;
  onRun: (cfg: BacktestConfig) => void;
  onClose: () => void;
}

const RANGE_MODES: { value: RangeMode; label: string }[] = [
  { value: "bars", label: "Bars" },
  { value: "lastDay", label: "Day" },
  { value: "lastWeek", label: "Week" },
  { value: "lastMonth", label: "Month" },
  { value: "custom", label: "Custom" },
];

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

const EMPTY_RISK: RiskConfig = { stop: { kind: "none" }, target: { kind: "none" } };
const DEFAULT_SCALING: ScalingConfig = { maxConcurrent: 1 };
// `tip` is a one-line tooltip. Crosses fire ONCE on the bar the lines meet (an
// event); the comparisons are true on EVERY bar the condition holds (a state).
const OPERATORS: { value: Operator; label: string; tip: string }[] = [
  { value: "crossesAbove", label: "crosses above", tip: "Fires once — the bar the left rises through the right." },
  { value: "crossesBelow", label: "crosses below", tip: "Fires once — the bar the left drops through the right." },
  { value: "gt", label: ">", tip: "True on every bar the left is above the right." },
  { value: "lt", label: "<", tip: "True on every bar the left is below the right." },
  { value: "gte", label: ">=", tip: "True on every bar the left is at or above the right." },
  { value: "lte", label: "<=", tip: "True on every bar the left is at or below the right." },
];

// A rough, illustrative bar count for the window timeline — not the exact fetch
// math BacktestButton uses (which also depends on "now" and the live broker's
// actual history limit), just enough to make the history-vs-window split
// tangible while the user is configuring it. Custom ranges without both dates
// set fall back to a nominal week.
const NOMINAL_WINDOW_BARS = 168;

const DATE_OPTS: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };

function formatDateRange(fromMs: number, toMs: number): string {
  const from = new Date(fromMs);
  const to = new Date(toMs);
  const sameYear = from.getFullYear() === to.getFullYear();
  const fromLabel = from.toLocaleDateString([], sameYear ? { day: "numeric", month: "short" } : DATE_OPTS);
  const toLabel = to.toLocaleDateString([], DATE_OPTS);
  return `${fromLabel} – ${toLabel}`;
}

// The actual calendar span implied by the current range choice, so "Month" etc.
// aren't left abstract — shown relative to now for the fixed presets ("Bars"
// depends on the resolution too, since a bar count only maps to a duration once
// you know the timeframe).
function rangeDateLabel(cfg: BacktestConfig, resSeconds: number): string {
  const r = cfg.range;
  const now = Date.now();
  if (r.mode === "custom") {
    if (r.fromMs && r.toMs && r.toMs > r.fromMs) return formatDateRange(r.fromMs, r.toMs);
    return "Pick a from and to date";
  }
  const fromMs = now - estimateWindowBars(cfg, resSeconds) * resSeconds * 1000;
  return formatDateRange(fromMs, now);
}

function estimateWindowBars(cfg: BacktestConfig, resSeconds: number): number {
  const r = cfg.range;
  if (r.mode === "bars") return r.bars ?? 500;
  if (r.mode === "custom") {
    if (r.fromMs && r.toMs && r.toMs > r.fromMs) {
      return Math.max(1, Math.round((r.toMs - r.fromMs) / 1000 / resSeconds));
    }
    return NOMINAL_WINDOW_BARS;
  }
  const days = r.mode === "lastDay" ? 1 : r.mode === "lastMonth" ? 30 : 7;
  return Math.max(1, Math.round((days * 86_400) / resSeconds));
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

export default function BacktestSettingsModal({ initial, epic, resolution, onRun, onClose }: Props) {
  const drag = useDraggable();
  const [cfg, setCfg] = useState<BacktestConfig>(initial);
  const [presets, setPresets] = useState(() => loadBacktestPresets());
  const [presetName, setPresetName] = useState("");
  const [loadName, setLoadName] = useState("");
  // Restore the last-viewed tab (device-local) and persist it on switch, so
  // re-opening the modal returns to the side you were working on.
  const [side, setSide] = useState<"long" | "short">(loadBacktestSide);
  const selectSide = (s: "long" | "short") => {
    setSide(s);
    saveBacktestSide(s);
  };
  useCloseOnEscape(onClose);

  const resSeconds = RESOLUTION_SECONDS[resolution] ?? 60;

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
  function setCosts(patch: Partial<Costs>) {
    setCfg({ ...cfg, costs: { ...cfg.costs, ...patch } });
  }
  function setGroup(which: "longEntry" | "longExit" | "shortEntry" | "shortExit", group: RuleGroup) {
    setCfg({ ...cfg, [which]: group });
  }

  function run() {
    onRun(cfg);
    onClose();
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
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal bt-modal" style={drag.style} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head" {...drag.handleProps}>
          <span>
            Backtest settings — <strong>{epic}</strong> ({resolution})
          </span>
          <CloseButton onClick={onClose} />
        </div>

        <div className="bt-body">
          <Section title="Time range">
            <div className="seg">
              {RANGE_MODES.map((m) => (
                <button
                  key={m.value}
                  className={cfg.range.mode === m.value ? "seg-on" : ""}
                  onClick={() => setRange({ mode: m.value })}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <div className="al-note bt-range-subtitle">{rangeDateLabel(cfg, resSeconds)}</div>
            {cfg.range.mode === "bars" && (
              <label className="al-row">
                <span>Bars</span>
                <input
                  type="number"
                  min={1}
                  value={cfg.range.bars ?? 500}
                  onChange={(e) => setRange({ bars: Number(e.target.value) })}
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
              </div>
            )}
          </Section>

          <Section title="History depth">
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
                  onChange={(e) => setRange({ historyBars: Number(e.target.value) })}
                />
              </label>
            )}
            <WindowTimeline cfg={cfg} resolution={resolution} />
          </Section>

          <div className="bt-side-tabs seg">
            <button className={side === "long" ? "seg-on" : ""} onClick={() => selectSide("long")}>
              <span className={`bt-side-dot${cfg.longEnabled === false ? " off" : ""}`} aria-hidden="true" />
              Long
            </button>
            <button className={side === "short" ? "seg-on" : ""} onClick={() => selectSide("short")}>
              <span className={`bt-side-dot${cfg.shortEnabled === false ? " off" : ""}`} aria-hidden="true" />
              Short
            </button>
          </div>
          <SidePanel side={side} cfg={cfg} setCfg={setCfg} setGroup={setGroup} />

          {usesVolume && (
            <div className="al-note">
              Volume-based operands (Volume, Volume-MA, AVWAP) read 0 on epics that don't report
              trade volume (e.g. many forex/CFD instruments) — they'll never fire there.
            </div>
          )}

          <Section title="Costs">
            <div className="bt-costs-grid">
              <label className="bt-field">
                <span>Quantity</span>
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={cfg.costs.quantity}
                  onChange={(e) => setCosts({ quantity: Number(e.target.value) })}
                />
              </label>
              <label className="bt-field">
                <span>Commission/side</span>
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={cfg.costs.commissionPerSide}
                  onChange={(e) => setCosts({ commissionPerSide: Number(e.target.value) })}
                />
              </label>
              <label className="bt-field">
                <span>Slippage</span>
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={cfg.costs.slippage}
                  onChange={(e) => setCosts({ slippage: Number(e.target.value) })}
                />
              </label>
              <label className="bt-field">
                <span>Starting cash</span>
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={cfg.costs.startingCash}
                  onChange={(e) => setCosts({ startingCash: Number(e.target.value) })}
                />
              </label>
            </div>
          </Section>

          <Section title="Presets">
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
        </div>

        <div className="modal-foot">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button onClick={run}>Run backtest</button>
        </div>
      </div>
    </div>
  );
}

// The stop/target block for one side. A stop is one dropdown (fixed %/price/ATR
// or trailing %/ATR); a target is the same minus the trailing kinds. Off by
// default (kind "none") so existing presets are untouched. ATR kinds expose a
// length (default 14); % / trailing % expose a percent; ATR kinds expose a
// multiple; fixed price exposes an absolute level.
function RiskSection({
  side,
  risk,
  onChange,
}: {
  side: "long" | "short";
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
  const num = (v: number | undefined, set: (n: number) => void, step = "any") => (
    <input type="number" step={step} value={v ?? 0}
      onChange={(e) => set(Number(e.target.value))} className="bt-num" />
  );

  return (
    <div className="bt-risk">
      <div className="instrument-section-title">Stop &amp; take profit ({side})</div>
      <div className="bt-risk-row">
        <span className="bt-risk-label">Stop</span>
        <select value={risk.stop.kind} onChange={(e) => setStopKind(e.target.value as StopKind)}>
          {STOP_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
        {(risk.stop.kind === "pct" || risk.stop.kind === "trailPct") &&
          <>{num(risk.stop.value, (n) => onChange({ ...risk, stop: { ...risk.stop, value: n } }))}<span>%</span></>}
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
          <>{num(risk.target.value, (n) => onChange({ ...risk, target: { ...risk.target, value: n } }))}<span>%</span></>}
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
  side,
  scaling,
  onChange,
}: {
  side: "long" | "short";
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
      <div className="instrument-section-title">Scaling &amp; management ({side})</div>
      <div className="bt-risk-row">
        <span className="bt-risk-label">Max positions</span>
        <input type="number" min={1} step="1" className="bt-num" value={scaling.maxConcurrent}
          onChange={(e) => onChange({ ...scaling, maxConcurrent: Math.max(1, Math.round(Number(e.target.value))) })} />
      </div>
      <div className="bt-risk-row">
        <span className="bt-risk-label">Min spacing</span>
        <select value={spacingKind} onChange={(e) => setSpacingKind(e.target.value as "none" | "pct" | "atr")}>
          <option value="none">None</option><option value="pct">%</option><option value="atr">ATR ×</option>
        </select>
        {scaling.spacing?.kind === "pct" &&
          <>{<input type="number" step="any" className="bt-num" value={scaling.spacing.value ?? 0}
            onChange={(e) => onChange({ ...scaling, spacing: { kind: "pct", value: Number(e.target.value) } })} />}<span>%</span></>}
        {scaling.spacing?.kind === "atr" && <>
          <input type="number" step="any" className="bt-num" value={scaling.spacing.mult ?? 0}
            onChange={(e) => onChange({ ...scaling, spacing: { ...scaling.spacing!, kind: "atr", mult: Number(e.target.value) } })} />
          <span>× ATR</span>
          <input type="number" step="1" className="bt-num" value={scaling.spacing.length ?? 14}
            onChange={(e) => onChange({ ...scaling, spacing: { ...scaling.spacing!, kind: "atr", length: Math.max(1, Math.round(Number(e.target.value))) } })} />
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
}: {
  side: "long" | "short";
  cfg: BacktestConfig;
  setCfg: (c: BacktestConfig) => void;
  setGroup: (which: "longEntry" | "longExit" | "shortEntry" | "shortExit", g: RuleGroup) => void;
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
          title={isLong ? "Buy to open (long)" : "Sell to open (short)"}
          group={entry}
          onChange={(g) => setGroup(isLong ? "longEntry" : "shortEntry", g)}
          emptyHint={`No ${side}-entry rules — this strategy won't open any ${side} positions.`}
        />
        <RuleGroupSection
          title={isLong ? "Sell to close (long)" : "Buy to close (short)"}
          group={exit}
          onChange={(g) => setGroup(isLong ? "longExit" : "shortExit", g)}
          emptyHint={`No ${side}-exit rules — an open ${side} holds until the trading window ends.`}
        />
        <RiskSection
          side={side}
          risk={(isLong ? cfg.longRisk : cfg.shortRisk) ?? EMPTY_RISK}
          onChange={(r) => setCfg({ ...cfg, [isLong ? "longRisk" : "shortRisk"]: r })}
        />
        <ScalingSection
          side={side}
          scaling={(isLong ? cfg.longScaling : cfg.shortScaling) ?? DEFAULT_SCALING}
          onChange={(s) => setCfg({ ...cfg, [isLong ? "longScaling" : "shortScaling"]: s })}
        />
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="bt-section">
      <div className="instrument-section-title">{title}</div>
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
        onClick={toggle}
      >
        {current?.label}
        <span className="bt-op-caret" aria-hidden="true">▾</span>
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
                <span className={`bt-op-item-label${isCrossOp(o.value) ? " bt-op-cross" : ""}`}>{o.label}</span>
                <InfoTip title={o.label} text={o.tip} />
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </div>
  );
}

function RuleGroupSection({
  title,
  group,
  onChange,
  emptyHint,
}: {
  title: string;
  group: RuleGroup;
  onChange: (g: RuleGroup) => void;
  emptyHint: string;
}) {
  function setCombine(combine: Combine) {
    onChange({ ...group, combine });
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

  return (
    <Section title={title}>
      {group.rules.length === 0 && <div className="al-note bt-empty-rules">{emptyHint}</div>}
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
      {group.rules.map((rule, i) => (
        <div className="bt-rule-row" key={i}>
          <OperandPicker value={rule.left} onChange={(left) => setRule(i, { ...rule, left })} />
          <OperatorPicker value={rule.op} onChange={(op) => setRule(i, { ...rule, op })} />
          <OperandPicker value={rule.right} onChange={(right) => setRule(i, { ...rule, right })} />
          <button className="bt-rule-remove" onClick={() => removeRule(i)} title="Remove rule" aria-label="Remove rule">
            ✕
          </button>
        </div>
      ))}
      <button className="ghost" onClick={addRule}>
        + Add rule
      </button>
    </Section>
  );
}

function OperandPicker({ value, onChange }: { value: Operand; onChange: (op: Operand) => void }) {
  function setKind(kind: Operand["kind"]) {
    if (kind === "indicator") onChange(defaultOperand());
    else if (kind === "price") onChange({ kind: "price", field: "close" });
    else onChange({ kind: "const", value: 0 });
  }

  return (
    <div className="bt-operand">
      <select value={value.kind} onChange={(e) => setKind(e.target.value as Operand["kind"])}>
        <option value="indicator">Indicator</option>
        <option value="price">Price</option>
        <option value="const">Number</option>
      </select>
      {value.kind === "indicator" && (
        <>
          <select
            value={value.indicator}
            onChange={(e) => {
              const indicator = e.target.value as IndicatorKind;
              onChange(
                NO_LENGTH.includes(indicator)
                  ? { kind: "indicator", indicator }
                  : { kind: "indicator", indicator, length: value.length ?? 9 },
              );
            }}
          >
            {INDICATORS.map((ind) => (
              <option key={ind} value={ind}>
                {ind}
              </option>
            ))}
          </select>
          {!NO_LENGTH.includes(value.indicator) && (
            <input
              type="number"
              min={1}
              className="bt-operand-length"
              value={value.length ?? 9}
              onChange={(e) => onChange({ ...value, length: Number(e.target.value) })}
            />
          )}
        </>
      )}
      {value.kind === "price" && (
        <select value={value.field} onChange={(e) => onChange({ kind: "price", field: e.target.value as PriceField })}>
          {PRICE_FIELDS.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      )}
      {value.kind === "const" && (
        <input
          type="number"
          step="any"
          className="bt-operand-length"
          value={value.value}
          onChange={(e) => onChange({ kind: "const", value: Number(e.target.value) })}
        />
      )}
    </div>
  );
}

