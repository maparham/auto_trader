// PREV_HL's Inputs-tab boundary rows + Calculation rows, Style-tab pairs +
// legend toggle, and the currentConfig() delegate. State
// (prevHlTz/prevHlLengths/prevHlAggs/prevHlRollingUnit/prevHlGapMode/
// prevHlAnchorTs) stays in the shell (read directly by the persistence
// mega-effect and currentConfig()); this module owns the family-private
// writers (setPrevHlTimezone/setPrevHlLength/setPrevHlAgg/setPrevHlRolling/
// setPrevHlAnchorInput/setBoundaryVisible/boundaryActive) plus the JSX.
import type { Chart, Indicator } from "klinecharts";
import InfoTip from "../components/InfoTip";
import ColorLineStylePicker from "../ColorLineStylePicker";
import { TIMEZONES, offsetLabel } from "../lib/timezones";
import { prevHlAnchorToInput, prevHlInputToAnchor, type PrevHlAgg } from "../lib/customIndicators";
import {
  PREV_HL_LENGTH_FIELDS,
  PREV_HL_AGG_OPTIONS,
  PREV_HL_ROLLING_UNITS,
  PREV_HL_GAP_OPTIONS,
  PREV_HL_STYLE_PAIRS,
  type PrevHlKind,
  type LineDraft,
} from "./shared";

// --- Writers (moved from the shell; only need chart/paneId/name + state) ---

// PREV_HL timezone override: write extendData.tz and let calc re-bucket. "chart"
// stores no tz (omit the key) so the instance follows the global chart zone.
// Merges live extendData to preserve lineHidden / indType. Persistence is handled
// by the shell's snapshot effect (keyed on prevHlTz).
export function makeSetPrevHlTimezone(
  chart: Chart,
  paneId: string,
  name: string,
  setPrevHlTz: (tz: string) => void,
) {
  return function setPrevHlTimezone(tz: string) {
    setPrevHlTz(tz);
    const live = chart.getIndicatorByPaneId(paneId, name) as Indicator | null;
    const ext = { ...((live?.extendData as object) ?? {}) } as { tz?: string };
    if (tz === "chart") delete ext.tz;
    else ext.tz = tz;
    chart.overrideIndicator({ name, extendData: ext }, paneId);
  };
}

// PREV_HL lookback length for one boundary: write extendData.lengths and let calc
// re-aggregate. A length of 1 (the default) is omitted from the stored map so a
// default-everywhere instance carries no `lengths` key. Merges live extendData.
export function makeSetPrevHlLength(
  chart: Chart,
  paneId: string,
  name: string,
  prevHlLengths: Record<PrevHlKind, number>,
  setPrevHlLengths: (next: Record<PrevHlKind, number>) => void,
) {
  return function setPrevHlLength(kind: PrevHlKind, value: number) {
    const v = Math.max(1, Math.floor(value || 1));
    const nextLengths = { ...prevHlLengths, [kind]: v };
    setPrevHlLengths(nextLengths);
    const live = chart.getIndicatorByPaneId(paneId, name) as Indicator | null;
    const ext = { ...((live?.extendData as object) ?? {}) } as {
      lengths?: Partial<Record<PrevHlKind, number>>;
    };
    const lengths: Partial<Record<PrevHlKind, number>> = {};
    for (const f of PREV_HL_LENGTH_FIELDS) {
      if (nextLengths[f.kind] > 1) lengths[f.kind] = nextLengths[f.kind];
    }
    if (Object.keys(lengths).length) ext.lengths = lengths;
    else delete ext.lengths;
    chart.overrideIndicator({ name, extendData: ext }, paneId);
  };
}

// PREV_HL aggregation function for one boundary: write extendData.aggs and let
// calc re-aggregate. "extreme" (the default) is omitted so a default instance
// carries no `aggs` key. Merges live extendData to preserve lengths/tz/lineHidden.
export function makeSetPrevHlAgg(
  chart: Chart,
  paneId: string,
  name: string,
  prevHlAggs: Record<PrevHlKind, PrevHlAgg>,
  setPrevHlAggs: (next: Record<PrevHlKind, PrevHlAgg>) => void,
) {
  return function setPrevHlAgg(kind: PrevHlKind, fn: PrevHlAgg) {
    const nextAggs = { ...prevHlAggs, [kind]: fn };
    setPrevHlAggs(nextAggs);
    const live = chart.getIndicatorByPaneId(paneId, name) as Indicator | null;
    const ext = { ...((live?.extendData as object) ?? {}) } as {
      aggs?: Partial<Record<PrevHlKind, PrevHlAgg>>;
    };
    const aggs: Partial<Record<PrevHlKind, PrevHlAgg>> = {};
    for (const f of PREV_HL_LENGTH_FIELDS) {
      if (nextAggs[f.kind] !== "extreme") aggs[f.kind] = nextAggs[f.kind];
    }
    if (Object.keys(aggs).length) ext.aggs = aggs;
    else delete ext.aggs;
    chart.overrideIndicator({ name, extendData: ext }, paneId);
  };
}

// PREV_HL rolling unit (bars/minute/hour/day/week) and gap mode (trading/wallclock):
// write onto extendData and recompute. Defaults ("hour"/"trading") are omitted. Both
// share this writer so the merge logic stays in one place.
export function makeSetPrevHlRolling(
  chart: Chart,
  paneId: string,
  name: string,
  prevHlRollingUnit: string,
  prevHlGapMode: "trading" | "wallclock",
  setPrevHlRollingUnit: (unit: string) => void,
  setPrevHlGapMode: (gap: "trading" | "wallclock") => void,
) {
  return function setPrevHlRolling(next: { unit?: string; gap?: "trading" | "wallclock" }) {
    const unit = next.unit ?? prevHlRollingUnit;
    const gap = next.gap ?? prevHlGapMode;
    if (next.unit) setPrevHlRollingUnit(next.unit);
    if (next.gap) setPrevHlGapMode(next.gap);
    const live = chart.getIndicatorByPaneId(paneId, name) as Indicator | null;
    const ext = { ...((live?.extendData as object) ?? {}) } as {
      rollingUnit?: string;
      gapMode?: "trading" | "wallclock";
    };
    if (unit !== "hour") ext.rollingUnit = unit;
    else delete ext.rollingUnit;
    if (gap !== "trading") ext.gapMode = gap;
    else delete ext.gapMode;
    chart.overrideIndicator({ name, extendData: ext }, paneId);
  };
}

// PREV_HL anchor: parse the typed datetime-local (in the instance's timezone) to an
// epoch ms and write extendData.anchorTs. Empty clears it (unplaced → no line).
export function makeSetPrevHlAnchorInput(
  chart: Chart,
  paneId: string,
  name: string,
  prevHlTz: string,
  setPrevHlAnchorTs: (ts: number) => void,
) {
  return function setPrevHlAnchorInput(input: string) {
    const ts = prevHlInputToAnchor(input, prevHlTz === "chart" ? undefined : prevHlTz);
    setPrevHlAnchorTs(ts);
    const live = chart.getIndicatorByPaneId(paneId, name) as Indicator | null;
    const ext = { ...((live?.extendData as object) ?? {}) } as { anchorTs?: number };
    if (ts > 0) ext.anchorTs = ts;
    else delete ext.anchorTs;
    chart.overrideIndicator({ name, extendData: ext }, paneId);
  };
}

// PREV_HL: toggle a whole boundary (its High AND Low) from the Inputs-tab row
// checkbox. Shares the SAME `lines`/lineHidden source of truth as the Style-tab
// per-line checkboxes, so the two stay in sync. Unchecking hides both lines;
// checking shows both.
export function makeSetBoundaryVisible(
  chart: Chart,
  paneId: string,
  name: string,
  lines: LineDraft[],
  setLines: (next: LineDraft[]) => void,
) {
  return function setBoundaryVisible(kind: PrevHlKind, visible: boolean) {
    const keys = new Set([`${kind}High`, `${kind}Low`]);
    const next = lines.map((l) => (keys.has(l.key) ? { ...l, visible } : l));
    setLines(next);
    const lineHidden: Record<string, boolean> = {};
    for (const l of next) if (!l.visible) lineHidden[l.key] = true;
    const live = chart.getIndicatorByPaneId(paneId, name) as Indicator | null;
    chart.overrideIndicator(
      { name, extendData: { ...((live?.extendData as object) ?? {}), lineHidden } },
      paneId,
    );
  };
}

// A boundary is "on" if either of its lines is still visible (so the row
// checkbox reflects, and re-enables, the boundary as a whole).
export function boundaryActive(lines: LineDraft[], kind: PrevHlKind): boolean {
  return lines.some((l) => (l.key === `${kind}High` || l.key === `${kind}Low`) && l.visible);
}

// --- Inputs tab: boundary rows (Rolling range / Previous period / Anchored) ---
export function PrevHlInputsPanel({
  lines,
  prevHlLengths,
  prevHlAggs,
  prevHlRollingUnit,
  prevHlAnchorTs,
  prevHlTz,
  setBoundaryVisible,
  setPrevHlLength,
  setPrevHlRolling,
  setPrevHlAgg,
  setPrevHlAnchorInput,
}: {
  lines: LineDraft[];
  prevHlLengths: Record<PrevHlKind, number>;
  prevHlAggs: Record<PrevHlKind, PrevHlAgg>;
  prevHlRollingUnit: string;
  prevHlAnchorTs: number;
  prevHlTz: string;
  setBoundaryVisible: (kind: PrevHlKind, visible: boolean) => void;
  setPrevHlLength: (kind: PrevHlKind, value: number) => void;
  setPrevHlRolling: (next: { unit?: string; gap?: "trading" | "wallclock" }) => void;
  setPrevHlAgg: (kind: PrevHlKind, fn: PrevHlAgg) => void;
  setPrevHlAnchorInput: (input: string) => void;
}) {
  // One row renderer shared by both groups. Checkbox toggles the
  // boundary's H/L lines; greyed + disabled when off. The rolling row
  // also shows a unit selector (bars/minutes/hours/days/weeks).
  const renderRow = (f: (typeof PREV_HL_LENGTH_FIELDS)[number]) => {
    const on = boundaryActive(lines, f.kind);
    const aggTip = PREV_HL_AGG_OPTIONS.find((o) => o.value === prevHlAggs[f.kind])?.tip ?? "";
    const aggLabel = PREV_HL_AGG_OPTIONS.find((o) => o.value === prevHlAggs[f.kind])?.label ?? "";
    return (
      <div className={`ind-row${on ? "" : " is-off"}`} key={f.kind}>
        <span className="ind-row-head">
          <label className="ind-check ind-check-inline">
            <input
              type="checkbox"
              checked={on}
              onChange={(e) => setBoundaryVisible(f.kind, e.target.checked)}
            />
            <span>{f.label}</span>
          </label>
          <InfoTip
            title={f.label}
            text={[f.tip, `Function (${aggLabel}): ${aggTip}`]}
          />
        </span>
        <div className="ind-line-controls ind-prevhl-controls">
          <input
            type="number"
            min={1}
            step={1}
            value={prevHlLengths[f.kind]}
            disabled={!on}
            onChange={(e) => setPrevHlLength(f.kind, Number(e.target.value))}
          />
          {f.kind === "rolling" && (
            <select
              className="ind-unit-select"
              value={prevHlRollingUnit}
              disabled={!on}
              onChange={(e) => setPrevHlRolling({ unit: e.target.value })}
            >
              {PREV_HL_ROLLING_UNITS.map((u) => (
                <option key={u.value} value={u.value}>
                  {u.label}
                </option>
              ))}
            </select>
          )}
          <select
            value={prevHlAggs[f.kind]}
            disabled={!on}
            onChange={(e) => setPrevHlAgg(f.kind, e.target.value as PrevHlAgg)}
          >
            {PREV_HL_AGG_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    );
  };
  const on = boundaryActive(lines, "anchor");
  return (
    <>
      <div className="ind-group ind-group-head">
        <span>Rolling range</span>
        <InfoTip
          title="Rolling range"
          text="One sliding window that follows price. Pick the size and the unit. 1 hour = 60 minutes = 4 bars on a 15m chart, all the same line."
        />
      </div>
      {PREV_HL_LENGTH_FIELDS.filter((f) => f.kind === "rolling").map(renderRow)}
      <div className="ind-group ind-group-head">
        <span>Previous period</span>
        <InfoTip
          title="Previous period"
          text="High and Low of recent days and weeks. They reset at each new day or week."
        />
      </div>
      {PREV_HL_LENGTH_FIELDS.filter((f) => f.kind !== "rolling").map(renderRow)}
      <div className="ind-group ind-group-head">
        <span>Anchored</span>
        <InfoTip
          title="Anchored"
          text="Highest high and lowest low since a date you pick. The lines run from that point to now. Nothing shows before it. The date uses the Timezone below."
        />
      </div>
      <div className={`ind-row${on ? "" : " is-off"}`}>
        <label className="ind-check ind-check-inline">
          <input
            type="checkbox"
            checked={on}
            onChange={(e) => setBoundaryVisible("anchor", e.target.checked)}
          />
          <span>Anchor</span>
        </label>
        <input
          type="datetime-local"
          className="ind-anchor-input"
          disabled={!on}
          value={prevHlAnchorToInput(prevHlAnchorTs, prevHlTz === "chart" ? undefined : prevHlTz)}
          onChange={(e) => setPrevHlAnchorInput(e.target.value)}
        />
      </div>
    </>
  );
}

// --- Inputs tab: Calculation section rows (rolling span + timezone) ---
export function PrevHlCalculationRows({
  prevHlGapMode,
  prevHlTz,
  setPrevHlRolling,
  setPrevHlTimezone,
}: {
  prevHlGapMode: "trading" | "wallclock";
  prevHlTz: string;
  setPrevHlRolling: (next: { unit?: string; gap?: "trading" | "wallclock" }) => void;
  setPrevHlTimezone: (tz: string) => void;
}) {
  return (
    <>
      {/* How the rolling time-span treats closed-market time. */}
      <div className="ind-row">
        <span className="ind-row-head">
          <label>Rolling span</label>
          <InfoTip
            title="Rolling span"
            text="How the Range window handles market gaps. Trading time skips them; Wall-clock counts them. Only affects time units, not bars."
          />
        </span>
        <select
          value={prevHlGapMode}
          onChange={(e) => setPrevHlRolling({ gap: e.target.value as "trading" | "wallclock" })}
        >
          {PREV_HL_GAP_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      {/* Timezone decides where the Day/Week boundaries fall. "chart"
          follows the global axis zone; a specific zone anchors them. */}
      <div className="ind-row">
        <span className="ind-row-head">
          <label>Timezone</label>
          <InfoTip
            title="Timezone"
            text="Sets when a new day or week starts. 'Chart' uses the chart's timezone; or pick a market's zone."
          />
        </span>
        <select
          className="tz-select"
          value={prevHlTz}
          onChange={(e) => setPrevHlTimezone(e.target.value)}
        >
          <option value="chart">Chart</option>
          {TIMEZONES.filter((tz) => tz.value).map((tz) => {
            const off = offsetLabel(tz.value);
            return (
              <option key={tz.value} value={tz.value}>
                {off ? `${tz.label} ${off}` : tz.label}
              </option>
            );
          })}
        </select>
      </div>
    </>
  );
}

// --- Style tab: paired High/Low rows -----------------------------------------
// Pairs each boundary's High and Low on ONE row — "Day  High [color][size]  Low
// [color][size]" — halving the list. The boundary is greyed when deactivated in
// the Inputs tab.
export function PrevHlStylePairs({
  lines,
  setLine,
}: {
  lines: LineDraft[];
  setLine: (key: string, patch: Partial<LineDraft>) => void;
}) {
  return (
    <>
      {PREV_HL_STYLE_PAIRS.map((p) => {
        const hi = lines.find((l) => l.key === p.hiKey);
        const lo = lines.find((l) => l.key === p.loKey);
        if (!hi || !lo) return null;
        const off = !boundaryActive(lines, p.kind);
        const ctl = (l: LineDraft, side: string) => (
          <ColorLineStylePicker
            color={l.color}
            onColor={(hex) => setLine(l.key, { color: hex })}
            size={l.size}
            onSize={(s) => setLine(l.key, { size: s })}
            lineStyle={l.lineStyle}
            onLineStyle={(s) => setLine(l.key, { lineStyle: s })}
            disabled={off}
            title={`${p.label} ${side} line`}
          />
        );
        const rowTip = off
          ? `${p.label} is off. Turn it on in the Inputs tab to edit its lines.`
          : `Colour and thickness of the ${p.label} High and Low lines. Set visibility and lookback in the Inputs tab.`;
        return (
          <div
            className={`ind-row ind-style-row ind-style-pair${off ? " is-off" : ""}`}
            key={p.kind}
          >
            <span className="ind-pair-boundary">
              {p.label}
              <InfoTip title={p.label} text={rowTip} />
            </span>
            <span className="ind-pair-side">High</span>
            <div className="ind-line-controls">{ctl(hi, "High")}</div>
            <span className="ind-pair-side ind-pair-side-lo">Low</span>
            <div className="ind-line-controls">{ctl(lo, "Low")}</div>
          </div>
        );
      })}
    </>
  );
}

// --- Style tab: legend toggle ("Show ranges in legend") ----------------------
// PREV_HL shows a range summary in the legend (e.g. "1 day, since …") instead of
// per-bar values; this toggle controls that. Kept at the bottom of the Style tab.
export function PrevHlLegendToggle({
  showValue,
  toggleShowValue,
}: {
  showValue: boolean;
  toggleShowValue: (show: boolean) => void;
}) {
  return (
    <>
      <div className="ind-group">Legend</div>
      <label className="ind-check">
        <input
          type="checkbox"
          checked={showValue}
          onChange={(e) => toggleShowValue(e.target.checked)}
        />
        <span>Show ranges in legend</span>
      </label>
    </>
  );
}

// --- currentConfig() delegate --------------------------------------------------
// Per-instance timezone override + per-boundary lookback lengths/agg functions +
// rolling unit/gap mode + anchor timestamp; only non-defaults are persisted so a
// plain PREV_HL carries no extra keys. Mutates the passed extendData object.
export function prevHlConfig(
  extendData: Record<string, unknown>,
  prevHlTz: string,
  prevHlLengths: Record<PrevHlKind, number>,
  prevHlAggs: Record<PrevHlKind, PrevHlAgg>,
  prevHlRollingUnit: string,
  prevHlGapMode: "trading" | "wallclock",
  prevHlAnchorTs: number,
) {
  if (prevHlTz !== "chart") {
    // Per-instance timezone override; "chart" follows the global zone (no key).
    extendData.tz = prevHlTz;
  }
  // Per-boundary lookback lengths + agg functions; only store non-defaults
  // (length > 1, agg !== "extreme") so a default instance carries neither key.
  const lengths: Partial<Record<PrevHlKind, number>> = {};
  const aggs: Partial<Record<PrevHlKind, PrevHlAgg>> = {};
  for (const f of PREV_HL_LENGTH_FIELDS) {
    if (prevHlLengths[f.kind] > 1) lengths[f.kind] = prevHlLengths[f.kind];
    if (prevHlAggs[f.kind] !== "extreme") aggs[f.kind] = prevHlAggs[f.kind];
  }
  if (Object.keys(lengths).length) extendData.lengths = lengths;
  if (Object.keys(aggs).length) extendData.aggs = aggs;
  // Rolling unit + gap mode (non-default only).
  if (prevHlRollingUnit !== "hour") extendData.rollingUnit = prevHlRollingUnit;
  if (prevHlGapMode !== "trading") extendData.gapMode = prevHlGapMode;
  // Anchor timestamp (epoch ms); omitted when unplaced.
  if (prevHlAnchorTs > 0) extendData.anchorTs = prevHlAnchorTs;
}
