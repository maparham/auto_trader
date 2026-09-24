// The Period tab's range controls: the trading window (or, in walk-forward,
// the data window plus the train/test schedule), and the history depth loaded
// before it to warm the indicators up.
import { useMemo, useRef, useState } from "react";
import InfoTip from "../components/InfoTip";
import TipIcon from "../components/TipIcon";
import Tooltip from "../components/Tooltip";
import RangeCalendarPopover from "../RangeCalendarPopover";
import { WfoConfig } from "../WfoConfig";
import { localInputToMs, msToLocalInput } from "../lib/alertUi";
import type { BacktestConfig, RangeConfig, RecurrenceMask } from "../lib/backtestConfig";
import { buildRangeChips } from "../lib/backtestSchedule";
import { resolveWindow } from "../lib/backtestWindow";
import type { ChartController } from "../lib/chartController";
import { periodByResolution, periodGroups } from "../lib/feed";
import { splitHoldout } from "../lib/holdout";
import { loadCustomResolutions, type BacktestRunMode } from "../lib/persist";
import type { SweepAxis } from "../lib/sweep";
import type { WfoConfigState } from "../lib/wfo";
import { SweepGlyph } from "./icons";
import { Section } from "./Section";
import { WindowTimeline } from "./WindowTimeline";
import { CHIP_UNIT, HISTORY_DEPTHS, RANGE_MODES, WFO_RELATIVE_CHIPS, blockNegKeys, clampPosOnBlur, cleanNumInput } from "./shared";

export function PeriodSection({
  cfg,
  setCfg,
  setRange,
  setMask,
  btMode,
  controller,
  chartTimezone,
  resolution,
  resSeconds,
  pickingRange,
  pickBlocked,
  holdout,
  changeHoldoutPct,
  runInFlight,
  evaluateHoldout,
  wfoCfg,
  changeWfoCfg,
  wfoDroppedAxes,
  periodAxis,
  togglePeriodSweepAxis,
  setPeriodN,
}: {
  cfg: BacktestConfig;
  setCfg: (c: BacktestConfig) => void;
  setRange: (patch: Partial<RangeConfig>) => void;
  setMask: (patch: Partial<RecurrenceMask>) => void;
  btMode: BacktestRunMode;
  controller: ChartController | null;
  chartTimezone: string;
  // The chart's own timeframe, named in the "Chart (...)" option.
  resolution: string;
  resSeconds: number;
  pickingRange: boolean;
  pickBlocked: string | null;
  holdout: { pct: number; peeks: number } | null;
  changeHoldoutPct: (pct: number | null) => void;
  runInFlight: boolean;
  evaluateHoldout: () => void;
  wfoCfg: WfoConfigState;
  changeWfoCfg: (n: WfoConfigState) => void;
  wfoDroppedAxes: string[];
  periodAxis: SweepAxis | undefined;
  togglePeriodSweepAxis: () => void;
  setPeriodN: (n: number) => void;
}) {
  // The reserved holdout window ("from → to" of the locked-away tail), for the
  // holdout note. Recomputed with the range so it tracks edits live.
  const holdoutReserved = useMemo(() => {
    if (!holdout) return null;
    const { fromMs, toMs } = resolveWindow(cfg, resSeconds, Date.now());
    const { holdoutFromMs } = splitHoldout(fromMs, toMs, holdout.pct);
    const fmt = (ms: number) => new Date(ms).toLocaleDateString();
    return `${fmt(holdoutFromMs)} to ${fmt(toMs)}`;
  }, [holdout, cfg, resSeconds]);

  // The From/To fields are always visible and always show the actual window the
  // run would use: an explicit anchor (chip click, manual edit, chart pick) when
  // set, otherwise the rolling window the relative mode resolves to right now.
  const resolvedWindow = resolveWindow(cfg, resSeconds, Date.now());
  const pickerFromMs =
    btMode === "walkforward" ? resolvedWindow.fromMs : cfg.range.fromMs ?? resolvedWindow.fromMs;
  const pickerToMs =
    btMode === "walkforward" ? resolvedWindow.toMs : cfg.range.toMs ?? resolvedWindow.toMs;

  // "Chart" follows the active chart timeframe — name it so the menu says which.
  const chartTfLabel = periodByResolution(resolution)?.label;
  const chartOptionLabel = chartTfLabel ? `Chart (${chartTfLabel})` : "Chart";

  // A config already targeting a custom timeframe since deleted from the saved
  // list falls out of periodGroups(loadCustomResolutions()) entirely, which
  // would leave the controlled <select> showing no matching option (and the
  // browser silently falling back to the first one) while cfg.range.resolution
  // still names the deleted TF. Same "stay visible and reselectable-away-from"
  // treatment as IndicatorSettings' pinBelowChart precedent: surface it as its
  // own option so the select's value always has a match.
  // The groups exactly as both timeframe selects render them (live-only
  // seconds dropped, empty groups gone), so "missing" means "no rendered match".
  const tfGroups = periodGroups(loadCustomResolutions())
    .map((group) => ({ ...group, periods: group.periods.filter((p) => !p.liveOnly) }))
    .filter((group) => group.periods.length > 0);
  const currentTfRes = cfg.range.resolution;
  const missingCurrentTf =
    currentTfRes && !tfGroups.some((g) => g.periods.some((p) => p.resolution === currentTfRes))
      ? periodByResolution(currentTfRes)
      : undefined;

  // The walk-forward grid and the plain range row share these controls.
  const tfOptions = (
    <>
      <option value="">{chartOptionLabel}</option>
      {missingCurrentTf && (
        <option value={currentTfRes}>{missingCurrentTf.label}</option>
      )}
      {tfGroups.map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.periods.map((p) => (
            <option key={p.resolution} value={p.resolution}>
              {p.label}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
  const holdoutOptions = (
    <>
      <option value={0}>None</option>
      <option value={10}>10%</option>
      <option value={20}>20%</option>
      <option value={30}>30%</option>
    </>
  );
  const pickRangeButton = (
    <Tooltip
      content={
        !controller
          ? "Focus a chart to pick a range"
          : pickBlocked
            ? pickBlocked
            : pickingRange
              ? "Picking… drag across the chart's time axis, or click a start then an end. Esc cancels."
              : "Pick the range on the chart: drag across the time axis, or click a start then an end"
      }
    >
      <button
        type="button"
        className={`bt-pick-range${pickingRange ? " on" : ""}`}
        disabled={!controller || !!pickBlocked}
        aria-label="Pick range on chart"
        onClick={() => {
          // pickBlocked is the same decision the disabled state above reads;
          // re-asserted here so a click that arrives anyway (a keyboard
          // activation racing the session start) cannot arm the chart.
          if (!controller || pickBlocked) return;
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
  );
  const holdoutNote = holdout && (
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
  );

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
        {tfOptions}
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
        {holdoutOptions}
      </select>
    </label>
  );

  // Range calendar popover: open state + the fixed-position anchor measured
  // from the trigger button at click time.
  const [calOpen, setCalOpen] = useState(false);
  const [calAnchor, setCalAnchor] = useState<{ top: number; left: number } | null>(null);
  const calBtnRef = useRef<HTMLButtonElement>(null);

  const rangePicker = (
    <div className="al-row bt-range-row">
      {calOpen && calAnchor && (
        <RangeCalendarPopover
          fromMs={pickerFromMs}
          toMs={pickerToMs}
          mask={cfg.range.mask}
          tz={chartTimezone}
          timeStripDisabled={resSeconds >= 86400}
          anchor={calAnchor}
          onSpan={(fromMs, toMs) => setRange({ mode: "custom", fromMs, toMs })}
          onMaskPatch={(patch) => setMask(patch)}
          onClose={() => setCalOpen(false)}
          ignoreRef={calBtnRef}
        />
      )}
      <label className="bt-range-field">
        <span>From</span>
        <input
          type="datetime-local"
          value={pickerFromMs ? msToLocalInput(pickerFromMs) : ""}
          onChange={(e) =>
            // Editing a field freezes the window: anchor the other side at its
            // currently displayed (possibly rolling-resolved) value so it
            // doesn't jump when the mode falls back to custom.
            setRange({ mode: "custom", fromMs: localInputToMs(e.target.value) ?? undefined, toMs: pickerToMs })
          }
        />
      </label>
      <label className="bt-range-field">
        <span>To</span>
        <input
          type="datetime-local"
          value={pickerToMs ? msToLocalInput(pickerToMs) : ""}
          onChange={(e) =>
            setRange({ mode: "custom", toMs: localInputToMs(e.target.value) ?? undefined, fromMs: pickerFromMs })
          }
        />
      </label>
      {pickRangeButton}
      <Tooltip content={pickBlocked || "Pick the range visually: month grid + recurrence mask"}>
        <button
          ref={calBtnRef}
          type="button"
          className="bt-pick-range"
          disabled={!!pickBlocked}
          aria-label="Open range calendar"
          onClick={() => {
            if (pickBlocked) return;
            const r = calBtnRef.current?.getBoundingClientRect();
            if (!r) return;
            const left = Math.max(8, Math.min(r.left, window.innerWidth - 320 - 8));
            setCalAnchor({ top: r.bottom + 4, left });
            setCalOpen((on) => !on);
          }}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="1.5" y="2.5" width="13" height="12" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M1.5 5.5h13M5 1v3M11 1v3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </Tooltip>
    </div>
  );

  return (
          btMode === "walkforward" ? (
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
                    {pickRangeButton}
                    <span />
                    <select
                      className="bt-wfo-gs"
                      aria-label="Timeframe"
                      value={cfg.range.resolution ?? ""}
                      onChange={(e) => setRange({ resolution: e.target.value || undefined })}
                    >
                      {tfOptions}
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
                      {holdoutOptions}
                    </select>
                  </div>
                </div>
                {holdoutNote}
              </Section>
              <Section
                title="Schedule"
                info="The train/test cadence walk-forward optimizes on: how much history each fold trains over, how far it tests forward, and which metric picks the winning cell."
              >
                <WfoConfig
                  cfg={wfoCfg}
                  onChange={changeWfoCfg}
                  droppedAxes={wfoDroppedAxes}
                />
              </Section>
            </>
          ) : (
          <Section
            title="Time range"
            info="The span of history the backtest trades over. Pick a relative window (last day/week/month/year) or a calendar period via the chips; either just fills the From/To, which you can always edit directly."
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
      {CHIP_UNIT[cfg.range.mode] && (
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
        </div>
      )}
      {rangePicker}
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
      {/* Holdout ("lockbox") reserves the last part of the range as an
          out-of-sample tail. The picker itself lives up in the Time range
          header (next to Timeframe/Windows); here we only surface the
          reserved-tail note + Evaluate button once a holdout is set. Runs
          and sweeps clamp to the training span; the reserved tail is only
          touched by Evaluate on holdout, and every look is counted. */}
      {holdoutNote}
    </Section>
          )
  );
}

export function HistoryDepthSection({ cfg, setRange, effectiveRes, controller }: {
  cfg: BacktestConfig;
  setRange: (patch: Partial<RangeConfig>) => void;
  effectiveRes: string;
  controller: ChartController | null;
}) {
  return (
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
            <TipIcon text={h.tip} />
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
      <WindowTimeline cfg={cfg} resolution={effectiveRes} controller={controller} />
    </Section>
  );
}
