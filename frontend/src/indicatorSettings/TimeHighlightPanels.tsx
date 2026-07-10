// TIME_HIGHLIGHT's Inputs-tab window-list editor, Style-tab colour rows,
// family writers (writeWindows/patchWindow/addWindow), and the
// currentConfig() delegate. State (`windows`) stays in the shell (read
// directly by the persistence mega-effect and currentConfig()); writers move
// here since they only need chart/paneId/name/state, which the effect
// doesn't depend on. TIME_HIGHLIGHT has no Style/curves tab beyond its own
// colour rows (no lines/LineDraft model — the whole config is the window list).
import type { Chart, Indicator } from "klinecharts";
import ColorLineStylePicker from "../ColorLineStylePicker";
import {
  DEFAULT_TIME_WINDOWS,
  type TimeWindowDef,
  type TimeHighlightMode,
} from "../lib/customIndicators";

// --- Writers ------------------------------------------------------------------
export function makeWriteWindows(chart: Chart, paneId: string, name: string, setWindows: (next: TimeWindowDef[]) => void) {
  return function writeWindows(next: TimeWindowDef[]) {
    setWindows(next);
    const live = chart.getIndicatorByPaneId(paneId, name) as Indicator | null;
    chart.overrideIndicator(
      { name, extendData: { ...((live?.extendData as object) ?? {}), windows: next } },
      paneId,
    );
  };
}

export function makePatchWindow(windows: TimeWindowDef[], writeWindows: (next: TimeWindowDef[]) => void) {
  return function patchWindow(i: number, patch: Partial<TimeWindowDef>) {
    writeWindows(windows.map((wn, j) => (j === i ? { ...wn, ...patch } : wn)));
  };
}

export function makeAddWindow(windows: TimeWindowDef[], writeWindows: (next: TimeWindowDef[]) => void) {
  return function addWindow() {
    writeWindows([
      ...windows,
      {
        id: `w${Math.random().toString(36).slice(2, 8)}`,
        color: "#787b86",
        from: "09:00",
        to: "17:00",
        mode: "band",
        enabled: true,
      },
    ]);
  };
}

// --- Inputs tab: editable window list -----------------------------------------
export function TimeHighlightInputsPanel({
  windows,
  patchWindow,
  writeWindows,
  addWindow,
}: {
  windows: TimeWindowDef[];
  patchWindow: (i: number, patch: Partial<TimeWindowDef>) => void;
  writeWindows: (next: TimeWindowDef[]) => void;
  addWindow: () => void;
}) {
  return (
    <div className="sessions-editor">
      <p className="ind-note">Times are your device's local time. Set colours in the Style tab.</p>
      {windows.map((wn, i) => (
        <div className={`session-row${wn.enabled ? "" : " is-off"}`} key={wn.id}>
          <label className="ind-check ind-check-inline">
            <input
              type="checkbox"
              checked={wn.enabled}
              onChange={(e) => patchWindow(i, { enabled: e.target.checked })}
            />
          </label>
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
            onClick={() => writeWindows(windows.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </div>
      ))}
      <button type="button" className="session-add" onClick={addWindow}>
        + Add window
      </button>
    </div>
  );
}

// --- Style tab: per-window colour rows ------------------------------------------
export function TimeHighlightStylePanel({
  windows,
  patchWindow,
}: {
  windows: TimeWindowDef[];
  patchWindow: (i: number, patch: Partial<TimeWindowDef>) => void;
}) {
  return (
    <>
      {windows.map((wn, i) => (
        <div className={`ind-row ind-style-row${wn.enabled ? "" : " is-off"}`} key={wn.id}>
          <span className="ind-row-head">
            <label>{`${wn.from}–${wn.to}`}</label>
          </span>
          <div className="ind-line-controls">
            <ColorLineStylePicker
              color={wn.color}
              onColor={(hex) => patchWindow(i, { color: hex })}
              title={`${wn.from}–${wn.to} colour`}
            />
          </div>
        </div>
      ))}
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
