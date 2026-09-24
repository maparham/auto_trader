import NumberField from "../components/NumberField";
import { RangeChip, SweepBaseValue } from "../components/RangeChip";
import Tooltip from "../components/Tooltip";
import type { RiskConfig, ScalingConfig, StopKind, TargetKind } from "../lib/backtestConfig";
import type { RangeAxis, SweepAxis } from "../lib/sweep";
import { SweepGlyph } from "./icons";
import { SectionCollapseHead } from "./Section";
import { useSectionCollapse } from "./sectionCollapse";
import { STOP_KINDS, TARGET_KINDS, blockNegKeys, clampPosOnBlur, cleanNumInput } from "./shared";

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
  const [riskCollapsed, toggleRisk] = useSectionCollapse("Stop & take profit");
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
    <div className={`bt-risk${riskCollapsed ? " collapsed" : ""}`}>
      <SectionCollapseHead
        title="Stop & take profit"
        collapsed={riskCollapsed}
        onToggle={toggleRisk}
        info={sync?.on
          ? "Price-level exits. The trade ends on whichever triggers first: stop, target, or a close rule. Synced: edits here apply to both long and short."
          : "Price-level exits for this side. The trade ends on whichever triggers first: stop, target, or a close rule."}
        extra={sync && (
          <label className="bt-risk-sync">
            <input type="checkbox" checked={sync.on} onChange={sync.onToggle} />
            Same for long &amp; short
          </label>
        )}
      />
      {!riskCollapsed && <>
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
      </>}
    </div>
  );
}

// Max-concurrent-positions + min-spacing controls for one side. Collapsible
// (persisted like every other section) so it can stay out of the way in the
// common single-position case; off by default via DEFAULT_SCALING
// (maxConcurrent: 1, no spacing) so existing presets behave exactly as before.
export function ScalingSection({
  scaling,
  onChange,
}: {
  scaling: ScalingConfig;
  onChange: (s: ScalingConfig) => void;
}) {
  const spacingKind = scaling.spacing?.kind ?? "none";
  const [collapsed, toggle] = useSectionCollapse("Scaling & management");
  const setSpacingKind = (k: "none" | "pct" | "atr") => {
    if (k === "none") return onChange({ ...scaling, spacing: undefined });
    if (k === "pct") return onChange({ ...scaling, spacing: { kind: "pct", value: scaling.spacing?.value ?? 1 } });
    onChange({ ...scaling, spacing: { kind: "atr", mult: scaling.spacing?.mult ?? 1, length: scaling.spacing?.length ?? 14 } });
  };
  return (
    <div className={`bt-scaling${collapsed ? " collapsed" : ""}`}>
      <SectionCollapseHead
        title="Scaling & management"
        collapsed={collapsed}
        onToggle={toggle}
        info="Allow more than one open position on this side, and set the minimum price spacing between successive entries."
      />
      {!collapsed && <>
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
      </>}
    </div>
  );
}
