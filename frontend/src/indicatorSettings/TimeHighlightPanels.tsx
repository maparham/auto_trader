// TIME_HIGHLIGHT's Inputs-tab window-list editor, Style-tab colour rows,
// family writers (writeWindows/patchWindow/addWindow/addRecurringWindow), and
// the currentConfig() delegate. State (`windows`) stays in the shell (read
// directly by the persistence mega-effect and currentConfig()); writers move
// here since they only need chart/paneId/name/state, which the effect
// doesn't depend on. TIME_HIGHLIGHT has no Style/curves tab beyond its own
// colour rows (no lines/LineDraft model — the whole config is the window list).
//
// Two row kinds: daily HH:MM windows (recur every day), and recurring-range
// windows (a concrete anchor range projected onto every prior/later
// day/week/month/year, edited through the shared RangeCalendarPopover).
import { useRef, useState } from "react";
import type { Chart, Indicator } from "klinecharts";
import { getIndicator } from "../lib/indicators";
import { overrideExtend } from "../lib/overrideExtend";
import ColorLineStylePicker from "../ColorLineStylePicker";
import RangeCalendarPopover from "../RangeCalendarPopover";
import { tzDateString, tzOffsetMs } from "../lib/backtestSchedule";
import {
  DEFAULT_TIME_WINDOWS,
  isRecurringWindow,
  type RecurrencePeriod,
  type RecurringWindowDef,
  type TimeWindowDef,
  type TimeHighlightMode,
} from "../lib/customIndicators";

// --- Writers ------------------------------------------------------------------
export function makeWriteWindows(chart: Chart, paneId: string, name: string, setWindows: (next: TimeWindowDef[]) => void) {
  return function writeWindows(next: TimeWindowDef[]) {
    setWindows(next);
    const live = getIndicator(chart, paneId, name) as Indicator | null;
    // overrideExtend, not overrideIndicator: klinecharts merges extendData
    // index by index, so a DELETED row would leave the old tail painted on a
    // list that the modal and storage both show as shorter.
    overrideExtend(chart, paneId, name, { ...((live?.extendData as object) ?? {}), windows: next });
  };
}

export function makePatchWindow(windows: TimeWindowDef[], writeWindows: (next: TimeWindowDef[]) => void) {
  return function patchWindow(i: number, patch: Partial<TimeWindowDef>) {
    writeWindows(windows.map((wn, j) => (j === i ? ({ ...wn, ...patch } as TimeWindowDef) : wn)));
  };
}

const freshId = () => `w${Math.random().toString(36).slice(2, 8)}`;

export function makeAddWindow(windows: TimeWindowDef[], writeWindows: (next: TimeWindowDef[]) => void) {
  return function addWindow() {
    writeWindows([
      ...windows,
      {
        id: freshId(),
        color: "#787b86",
        from: "09:00",
        to: "17:00",
        mode: "band",
        enabled: true,
      },
    ]);
  };
}

// tz-local midnight of the day containing `ms`, as a UTC instant (guess-correct).
function dayStartUtcMs(ms: number, tz: string): number {
  const [y, mo, d] = tzDateString(ms, tz).split("-").map(Number);
  const guess = Date.UTC(y, mo - 1, d);
  return guess - tzOffsetMs(tz, guess);
}

// New recurring windows anchor on today (whole day in `tz`), repeating daily.
// The mask starts ENABLED so the calendar popover's backtest-oriented
// "default to weekdays on first span pick" branch never fires — weekday
// filtering stays purely opt-in for highlights.
export function makeAddRecurringWindow(
  windows: TimeWindowDef[],
  writeWindows: (next: TimeWindowDef[]) => void,
  tz: string,
) {
  return function addRecurringWindow() {
    const start = dayStartUtcMs(Date.now(), tz);
    writeWindows([
      ...windows,
      {
        id: freshId(),
        color: "#787b86",
        mode: "band",
        enabled: true,
        anchorStartMs: start,
        anchorEndMs: start + 86_400_000,
        period: "day",
        mask: { enabled: true },
      },
    ]);
  };
}

// "Jul 6 – Jul 8, 2026"-style label for a recurring window's anchor range
// (end shown inclusive: the display date is the last ms of the half-open range).
export function recurringRangeLabel(wn: RecurringWindowDef, tz: string): string {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", year: "numeric" });
  const from = fmt.format(wn.anchorStartMs);
  const to = fmt.format(Math.max(wn.anchorStartMs, wn.anchorEndMs - 1));
  return from === to ? from : `${from} – ${to}`;
}

const PERIOD_LABELS: Record<RecurrencePeriod, string> = {
  day: "Every day",
  week: "Every week",
  month: "Every month",
  year: "Every year",
};

// --- Inputs tab: editable window list -----------------------------------------
export function TimeHighlightInputsPanel({
  windows,
  tz,
  patchWindow,
  writeWindows,
  addWindow,
}: {
  windows: TimeWindowDef[];
  tz: string;
  patchWindow: (i: number, patch: Partial<TimeWindowDef>) => void;
  writeWindows: (next: TimeWindowDef[]) => void;
  addWindow: () => void;
}) {
  // Which recurring row's calendar popover is open, and where it's anchored.
  const [calRow, setCalRow] = useState<number | null>(null);
  const [calAnchor, setCalAnchor] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const calBtnRef = useRef<HTMLButtonElement | null>(null);
  const addRecurring = makeAddRecurringWindow(windows, writeWindows, tz);
  const openWin = calRow != null ? windows[calRow] : undefined;

  return (
    <div className="sessions-editor">
      <p className="ind-note">Times follow the chart timezone. Set colours in the Style tab.</p>
      {windows.map((wn, i) => (
        <div className={`session-row${wn.enabled ? "" : " is-off"}`} key={wn.id}>
          <label className="ind-check ind-check-inline">
            <input
              type="checkbox"
              checked={wn.enabled}
              onChange={(e) => patchWindow(i, { enabled: e.target.checked })}
            />
          </label>
          {isRecurringWindow(wn) ? (
            <>
              <button
                type="button"
                className="session-range"
                aria-label="Edit range"
                ref={calRow === i ? calBtnRef : undefined}
                onClick={(e) => {
                  if (calRow === i) {
                    setCalRow(null);
                    return;
                  }
                  const r = e.currentTarget.getBoundingClientRect();
                  setCalAnchor({ top: r.bottom + 6, left: r.left });
                  setCalRow(i);
                }}
              >
                {recurringRangeLabel(wn, tz)}
              </button>
              <select
                className="tz-select session-tz"
                value={wn.period}
                aria-label="Repeat period"
                onChange={(e) => patchWindow(i, { period: e.target.value as RecurrencePeriod })}
              >
                {(Object.keys(PERIOD_LABELS) as RecurrencePeriod[]).map((p) => (
                  <option key={p} value={p}>
                    {PERIOD_LABELS[p]}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <>
              <input
                className="session-time"
                type="time"
                value={wn.from}
                aria-label="Window start"
                onChange={(e) => patchWindow(i, { from: e.target.value })}
              />
              <span className="session-dash">–</span>
              <input
                className="session-time"
                type="time"
                value={wn.to}
                aria-label="Window end"
                onChange={(e) => patchWindow(i, { to: e.target.value })}
              />
            </>
          )}
          <select
            className="tz-select session-tz"
            value={wn.mode}
            aria-label="Highlight style"
            onChange={(e) => patchWindow(i, { mode: e.target.value as TimeHighlightMode })}
          >
            <option value="band">Band</option>
            <option value="candles">Candles</option>
            <option value="both">Both</option>
          </select>
          <button
            type="button"
            className="session-remove"
            aria-label="Remove window"
            onClick={() => {
              if (calRow === i) setCalRow(null);
              writeWindows(windows.filter((_, j) => j !== i));
            }}
          >
            ×
          </button>
        </div>
      ))}
      <button type="button" className="session-add" onClick={addWindow}>
        + Add time window
      </button>
      <button type="button" className="session-add" onClick={addRecurring}>
        + Add recurring range
      </button>
      {calRow != null && openWin != null && isRecurringWindow(openWin) && (
        <RangeCalendarPopover
          fromMs={openWin.anchorStartMs}
          toMs={openWin.anchorEndMs}
          mask={openWin.mask}
          tz={tz}
          timeStripDisabled={false}
          anchor={calAnchor}
          onSpan={(fromMs, toMs) => patchWindow(calRow, { anchorStartMs: fromMs, anchorEndMs: toMs })}
          onMaskPatch={(patch) =>
            patchWindow(calRow, { mask: { enabled: true, ...openWin.mask, ...patch } })
          }
          onClose={() => setCalRow(null)}
          ignoreRef={calBtnRef}
        />
      )}
    </div>
  );
}

// --- Style tab: per-window colour rows ------------------------------------------
export function TimeHighlightStylePanel({
  windows,
  tz,
  patchWindow,
}: {
  windows: TimeWindowDef[];
  tz: string;
  patchWindow: (i: number, patch: Partial<TimeWindowDef>) => void;
}) {
  return (
    <>
      {windows.map((wn, i) => {
        const label = isRecurringWindow(wn) ? recurringRangeLabel(wn, tz) : `${wn.from}–${wn.to}`;
        return (
          <div className={`ind-row ind-style-row${wn.enabled ? "" : " is-off"}`} key={wn.id}>
            <span className="ind-row-head">
              <label>{label}</label>
            </span>
            <div className="ind-line-controls">
              <ColorLineStylePicker
                color={wn.color}
                onColor={(hex) => patchWindow(i, { color: hex })}
                title={`${label} colour`}
              />
            </div>
          </div>
        );
      })}
    </>
  );
}

// --- currentConfig() delegate --------------------------------------------------
// The whole window list (only when edited away from defaults, mirroring
// SESSIONS, so a fresh instance carries no key).
export function timeHighlightConfig(extendData: Record<string, unknown>, windows: TimeWindowDef[]) {
  if (JSON.stringify(windows) !== JSON.stringify(DEFAULT_TIME_WINDOWS)) {
    extendData.windows = windows;
  }
}
