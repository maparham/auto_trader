// The debug popup for one Trendlines candidate: every gate with ✓ or ✗, the
// line's value against the setting, and the smallest change that passes it.
// No hue anywhere (owner's rule): glyphs and text carry pass/fail.
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import InfoTip from "./InfoTip";
import { resolveInputs } from "../lib/indicatorMeta";
import { MAX_LIVE, TRENDLINES_DEFAULTS, type TrendlinesConfig } from "../lib/indicators/trendlinesOutputs";
import {
  GATE_GROUP, whatIfFate, type DebugCandidate, type TlDebugResult, type Verdict,
} from "../lib/indicators/trendlinesDebugExplain";
import { proposeChanges, type FixResult, type SettingChange } from "../lib/indicators/trendlinesDebugFix";

const FIELD_SLOTS = Object.keys(TRENDLINES_DEFAULTS) as Array<keyof TrendlinesConfig>;

/** The Settings form's label for a config field (indicatorMeta is the one
 * source), falling back to the field name only for a slot with no input. */
export function settingLabel(field: keyof TrendlinesConfig): string {
  const idx = FIELD_SLOTS.indexOf(field);
  const inp = resolveInputs("TRENDLINES", Object.values(TRENDLINES_DEFAULTS)).find(
    (d) => d.source === "calcParam" && d.index === idx,
  );
  return inp?.label ?? field;
}

const GATE_TEXT: Partial<Record<Verdict["gate"], string>> = {
  unconfirmed: "Not confirmed yet", fractal: "Not a pivot", window: "Too far back to pair",
  liveCap: `Dropped by the ${MAX_LIVE} live line cap`, stale: "Untouched too long",
  merged: "Merged into a nearer line", perPivot: "Too many lines at a pivot", maxLines: "Past Max Trendlines",
};

const FATE_TEXT: Record<string, string> = {
  merged: "merged", perPivot: "too many at a pivot", maxLines: "past Max Trendlines",
};

const fmt = (n: number | null) =>
  n === null ? "?" : Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
const DAY_MS = 86_400_000;
/** Bar date, with HH:MM when the bars are intraday (spacing under a day). */
export const dateOf = (times: readonly number[], i: number) => {
  const t = times[Math.min(Math.max(0, i), times.length - 1)];
  if (typeof t !== "number" || !Number.isFinite(t)) return "?";
  const n = times.length;
  const intraday = n > 1 && times[n - 1] - times[n - 2] < DAY_MS;
  const iso = new Date(t).toISOString();
  return intraday ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
};

/** A failing row's cell: an Apply button only for an exact threshold change
 * that actually moves the setting; a pool setting (it reshapes every pivot,
 * so only a re-run can tell) or a no-op gets a hint instead. */
export function rowFix(ch: SettingChange | undefined): { apply: SettingChange } | { hint: string } {
  if (!ch || ch.to === ch.from) return { hint: "no setting reaches it" };
  if (ch.pool) return { hint: `needs ${settingLabel(ch.field)} ${fmt(ch.to)}, verify with Apply all` };
  return { apply: ch };
}
const changeText = (cs: readonly SettingChange[]) =>
  cs.map((c) => `${settingLabel(c.field)} ${fmt(c.to)}`).join(", ");

export interface TrendlineDebugPopupProps {
  x: number;
  y: number;
  res: TlDebugResult;
  cand: DebugCandidate;
  times: readonly number[];
  fix: FixResult | null;
  fixBusy: boolean;
  effects: { added: number; removed: number } | null;
  canUndo: boolean;
  onApply: (changes: SettingChange[]) => void;
  onApplyAll: () => void;
  onUndo: () => void;
  onCheckEffects: () => void;
  /** Place the line as a regular drawing; null when it is not on screen. */
  onToDrawing: (() => void) | null;
  onClose: () => void;
}

export default function TrendlineDebugPopup(p: TrendlineDebugPopupProps) {
  const { cand, res, times, fix } = p;
  const { changes, impossible } = proposeChanges(cand, res.cfg);
  const changeFor = (v: Verdict) => (v.field ? changes.find((c) => c.field === v.field) : undefined);
  const extra =
    !cand.drawn && cand.failed.length === 0 && cand.record ? whatIfFate(res, cand.line) : null;
  const rows = [...cand.verdicts].sort((a, b) => Number(a.pass) - Number(b.pass));
  const canApplyAll = !!fix && fix.covered && fix.changes.length > 0;
  // Kept on screen: flips to the pointer's left when it would run off the
  // right edge (the popup is at most 340px wide).
  // Flipped above the pointer when its measured height would run off the
  // bottom (a popup opened from the strip at the chart's foot).
  const vw = typeof window === "undefined" ? Infinity : window.innerWidth;
  const vh = typeof window === "undefined" ? Infinity : window.innerHeight;
  const ref = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(0);
  useLayoutEffect(() => {
    const next = ref.current?.offsetHeight ?? 0;
    if (next !== h) setH(next);
  });
  // The reason strip sits at the chart's foot; the popup stays above it.
  const stripTop = typeof document === "undefined" ? Infinity
    : document.querySelector(".tl-dbg-bar")?.getBoundingClientRect().top ?? Infinity;
  const floor = Math.min(vh, stripTop - 4);
  const below = p.y + 12;
  const top = h && below + h > floor ? Math.max(4, Math.min(p.y - 12, floor) - h) : below;
  const style = { left: p.x + 12 + 352 > vw ? Math.max(4, p.x - 352) : p.x + 12, top };
  return createPortal(
    <div ref={ref} className="tl-dbg-pop" style={style} role="dialog" aria-label="Trendline debug">
      <div className="tl-dbg-head">
        <span>
          {dateOf(times, cand.line.i1)} to {dateOf(times, cand.line.i2)}
          {cand.origin === "forced" ? " (your line)" : ""}
        </span>
        <button className="tl-dbg-x" onClick={p.onClose} aria-label="Close">×</button>
      </div>
      <div className="tl-dbg-state">
        {cand.drawn ? "Drawn." : cand.outranked ? "Passes every filter. Outranked." : "Blocked."}
      </div>
      <table className="tl-dbg-gates">
        <tbody>
          {rows.map((v, n) => {
            const fx = v.pass ? null : rowFix(changeFor(v));
            return (
              <tr key={`${v.gate}-${v.anchor ?? 0}-${n}`} className={v.pass ? "is-pass" : "is-fail"}>
                <td className="tl-dbg-glyph" aria-label={v.pass ? "pass" : "fail"}>{v.pass ? "✓" : "✗"}</td>
                <td>
                  {v.field ? settingLabel(v.field) : GATE_TEXT[v.gate] ?? GATE_GROUP[v.gate]}
                  {v.anchor ? ` (anchor ${v.anchor})` : ""}
                </td>
                <td className="tl-dbg-num">{fmt(v.measured)} / {v.off ? "off" : fmt(v.limit)}</td>
                <td>
                  {fx && "apply" in fx ? (
                    <button
                      onClick={() => p.onApply([fx.apply])}
                      aria-label={`Apply ${settingLabel(fx.apply.field)} ${fmt(fx.apply.to)}`}
                    >
                      {fmt(fx.apply.from)} to {fmt(fx.apply.to)}
                    </button>
                  ) : fx ? (
                    <span className="tl-dbg-hint">{fx.hint}</span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {cand.fate?.kind === "merged" ? <div className="tl-dbg-note">Winner glows on the chart.</div> : null}
      {extra && extra.kind !== "drawn" ? (
        <div className="tl-dbg-note">If it were live it would still lose: {FATE_TEXT[extra.kind] ?? extra.kind}.</div>
      ) : null}
      {impossible.some((v) => v.gate === "liveCap") ? (
        <div className="tl-dbg-note">
          No setting controls the live cap.
          <InfoTip text={["Tighter filters that end lines sooner leave it more room."]} />
        </div>
      ) : null}
      <div className="tl-dbg-live">
        {/* A live line was built on its second anchor's confirm bar. */}
        Live from {dateOf(times, cand.record?.bornAt ?? cand.line.i2 + res.cfg.pivotLen)}
        {cand.record?.endedAt != null
          ? ` to ${dateOf(times, cand.record.endedAt)}, ended by ${cand.record.endedBy === "stale" ? "Max Projection" : "Lookback"}`
          : " to now"}
      </div>
      <div className="tl-dbg-actions">
        {p.fixBusy ? <span className="tl-dbg-busy">Searching for a fix…</span> : null}
        {fix && !p.fixBusy ? (
          fix.error ? <span>{fix.error}</span>
          : fix.covered && fix.changes.length === 0
            ? <span>{cand.drawn ? "Already drawn." : "A drawn line already looks like this one."}</span>
          : canApplyAll ? (
            <button onClick={p.onApplyAll}>Apply all ({changeText(fix.changes)})</button>
          ) : (
            <span>No settings change found.</span>
          )
        ) : null}
        {canApplyAll ? <button onClick={p.onCheckEffects}>What else changes?</button> : null}
        {p.effects ? <span>+{p.effects.added} lines, -{p.effects.removed} lines</span> : null}
        {p.canUndo ? <button onClick={p.onUndo}>Undo</button> : null}
        {p.onToDrawing ? <button onClick={p.onToDrawing}>To drawing</button> : null}
      </div>
      {fix && !p.fixBusy && !fix.covered && !fix.error && fix.attempted.length ? (
        <div className="tl-dbg-tried">Tried: {changeText(fix.attempted)}</div>
      ) : null}
    </div>,
    document.body,
  );
}
