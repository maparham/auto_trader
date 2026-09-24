// The Period tab's recurring-window mask: weekdays, months, a clock window
// or market session, the time-window sweep, and the coverage preview.
import { useMemo } from "react";
import InfoTip from "../components/InfoTip";
import Tooltip from "../components/Tooltip";
import type { BacktestConfig, RecurrenceMask, SessionPreset } from "../lib/backtestConfig";
import { SESSION_PRESETS, coverage, isActive, minToTime, resolveMask, sessionWindowInTz } from "../lib/backtestSchedule";
import { resolveWindow } from "../lib/backtestWindow";
import type { BacktestRunMode } from "../lib/persist";
import type { SweepAxis, SweepOption } from "../lib/sweep";
import { SweepGlyph } from "./icons";
import { SessionFillMenu } from "./menus";
import { Section } from "./Section";
import { DOW_LABELS, MONTH_LABELS, timeToMin, toggle, tzDisplay, withEnd, withStart } from "./shared";

export function ActiveWindowsSection({
  cfg,
  setMask,
  btMode,
  resSeconds,
  chartTimezone,
  timeWindowAxis,
  toggleTimeWindowSweepAxis,
  addTimeWindowOption,
  addSessionWindowOption,
  removeTimeWindowOption,
  twOption,
}: {
  cfg: BacktestConfig;
  setMask: (patch: Partial<RecurrenceMask>) => void;
  btMode: BacktestRunMode;
  resSeconds: number;
  chartTimezone: string;
  timeWindowAxis: SweepAxis | undefined;
  toggleTimeWindowSweepAxis: () => void;
  addTimeWindowOption: (o: SweepOption) => void;
  addSessionWindowOption: (key: SessionPreset | "") => void;
  removeTimeWindowOption: (i: number) => void;
  twOption: (startMin: number, endMin: number, tz: string, label?: string) => SweepOption;
}) {
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

  return (
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
                    const r = resolveMask({ enabled: false, ...cfg.range.mask, session: key });
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
  );
}
