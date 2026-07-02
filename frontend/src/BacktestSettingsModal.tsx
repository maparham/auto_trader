// Backtest strategy builder: time range + history depth, entry/exit rule
// groups, costs, and named presets. Matches the app's other modals exactly
// (useDraggable/useCloseOnEscape/CloseButton, .modal-backdrop/.modal/.modal-head/
// .modal-foot) — no shared wrapper, no portal.

import { useState, type ReactNode } from "react";
import CloseButton from "./CloseButton";
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
} from "./lib/backtestConfig";
import {
  loadBacktestPresets,
  saveBacktestPreset,
  deleteBacktestPreset,
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
  const [side, setSide] = useState<"long" | "short">("long");
  useCloseOnEscape(onClose);

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
              <>
                <label className="al-row">
                  <span>From</span>
                  <input
                    type="datetime-local"
                    value={cfg.range.fromMs ? msToLocalInput(cfg.range.fromMs) : ""}
                    onChange={(e) => setRange({ fromMs: localInputToMs(e.target.value) ?? undefined })}
                  />
                </label>
                <label className="al-row">
                  <span>To</span>
                  <input
                    type="datetime-local"
                    value={cfg.range.toMs ? msToLocalInput(cfg.range.toMs) : ""}
                    onChange={(e) => setRange({ toMs: localInputToMs(e.target.value) ?? undefined })}
                  />
                </label>
              </>
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
            <button className={side === "long" ? "seg-on" : ""} onClick={() => setSide("long")}>
              <span className={`bt-side-dot${cfg.longEnabled === false ? " off" : ""}`} aria-hidden="true" />
              Long
            </button>
            <button className={side === "short" ? "seg-on" : ""} onClick={() => setSide("short")}>
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

// Operator selector — a plain native <select> (a "crosses" op, an event, reads
// in the accent colour; the comparisons, a state, read muted) plus an ⓘ info
// icon whose tooltip explains the currently-chosen operator, matching the info
// icons on the layout picker's sync toggles.
function isCrossOp(op: Operator): boolean {
  return op === "crossesAbove" || op === "crossesBelow";
}

function OperatorPicker({ value, onChange }: { value: Operator; onChange: (op: Operator) => void }) {
  const tip = OPERATORS.find((o) => o.value === value)?.tip;
  return (
    <div className="bt-op-cell">
      <select
        className={isCrossOp(value) ? "bt-op-cross" : "bt-op-compare"}
        value={value}
        onChange={(e) => onChange(e.target.value as Operator)}
      >
        {OPERATORS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="bt-op-info" title={tip} aria-label={tip} role="img">
        ⓘ
      </span>
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

