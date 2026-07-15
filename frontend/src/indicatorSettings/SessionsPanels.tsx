// SESSIONS' Inputs-tab session-list editor, Style-tab colour rows, family
// writers (writeSessions/patchSession/addSession), and the currentConfig()
// delegate. State (`sessions`) stays in the shell (read directly by the
// persistence mega-effect and currentConfig()); writers move here since they
// only need chart/paneId/name/state, which the effect doesn't depend on.
// SESSIONS has no Style/curves tab beyond its own colour rows (no lines/
// LineDraft model — the whole config is the session list).
import type { Chart, Indicator } from "klinecharts";
import { getIndicator } from "../lib/indicators";
import ColorLineStylePicker from "../ColorLineStylePicker";
import { TIMEZONES } from "../lib/timezones";
import { DEFAULT_SESSIONS, type SessionDef } from "../lib/customIndicators";

// --- Writers ------------------------------------------------------------------
export function makeWriteSessions(chart: Chart, paneId: string, name: string, setSessions: (next: SessionDef[]) => void) {
  return function writeSessions(next: SessionDef[]) {
    setSessions(next);
    const live = getIndicator(chart, paneId, name) as Indicator | null;
    chart.overrideIndicator({ paneId, name, extendData: { ...((live?.extendData as object) ?? {}), sessions: next } });
  };
}

export function makePatchSession(sessions: SessionDef[], writeSessions: (next: SessionDef[]) => void) {
  return function patchSession(i: number, patch: Partial<SessionDef>) {
    writeSessions(sessions.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  };
}

export function makeAddSession(sessions: SessionDef[], writeSessions: (next: SessionDef[]) => void) {
  return function addSession() {
    writeSessions([
      ...sessions,
      {
        id: `s${Math.random().toString(36).slice(2, 8)}`,
        name: "New session",
        color: "#787b86",
        timezone: "Europe/London",
        open: "08:00",
        close: "16:00",
        enabled: true,
      },
    ]);
  };
}

// --- Inputs tab: editable session list -----------------------------------------
export function SessionsInputsPanel({
  sessions,
  patchSession,
  writeSessions,
  addSession,
}: {
  sessions: SessionDef[];
  patchSession: (i: number, patch: Partial<SessionDef>) => void;
  writeSessions: (next: SessionDef[]) => void;
  addSession: () => void;
}) {
  return (
    <div className="sessions-editor">
      <p className="ind-note">
        Hours are local time in each session's timezone. Set colours in the Style tab.
      </p>
      {sessions.map((s, i) => (
        <div className={`session-row${s.enabled ? "" : " is-off"}`} key={s.id}>
          <label className="ind-check ind-check-inline">
            <input
              type="checkbox"
              checked={s.enabled}
              onChange={(e) => patchSession(i, { enabled: e.target.checked })}
            />
          </label>
          <input
            className="session-name"
            type="text"
            value={s.name}
            aria-label="Session name"
            onChange={(e) => patchSession(i, { name: e.target.value })}
          />
          <select
            className="tz-select session-tz"
            value={s.timezone}
            aria-label="Session timezone"
            onChange={(e) => patchSession(i, { timezone: e.target.value })}
          >
            {/* City name only — the offset is dropped to keep the row
                short; the selected zone's city is enough to identify it. */}
            {TIMEZONES.filter((tz) => tz.value).map((tz) => (
              <option key={tz.value} value={tz.value}>
                {tz.label}
              </option>
            ))}
          </select>
          <input
            className="session-time"
            type="time"
            value={s.open}
            aria-label="Session open"
            onChange={(e) => patchSession(i, { open: e.target.value })}
          />
          <span className="session-dash">–</span>
          <input
            className="session-time"
            type="time"
            value={s.close}
            aria-label="Session close"
            onChange={(e) => patchSession(i, { close: e.target.value })}
          />
          <button
            type="button"
            className="session-remove"
            aria-label={`Remove ${s.name}`}
            onClick={() => writeSessions(sessions.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </div>
      ))}
      <button type="button" className="session-add" onClick={addSession}>
        + Add session
      </button>
    </div>
  );
}

// --- Style tab: per-session colour rows ----------------------------------------
export function SessionsStylePanel({
  sessions,
  patchSession,
}: {
  sessions: SessionDef[];
  patchSession: (i: number, patch: Partial<SessionDef>) => void;
}) {
  return (
    <>
      {sessions.map((s, i) => (
        <div className={`ind-row ind-style-row${s.enabled ? "" : " is-off"}`} key={s.id}>
          <span className="ind-row-head">
            <label>{s.name}</label>
          </span>
          <div className="ind-line-controls">
            <ColorLineStylePicker
              color={s.color}
              onColor={(hex) => patchSession(i, { color: hex })}
              title={`${s.name} colour`}
            />
          </div>
        </div>
      ))}
    </>
  );
}

// --- currentConfig() delegate --------------------------------------------------
// The whole session list (only when edited away from defaults, so a fresh
// instance carries no key and picks up future default changes).
export function sessionsConfig(extendData: Record<string, unknown>, sessions: SessionDef[]) {
  if (JSON.stringify(sessions) !== JSON.stringify(DEFAULT_SESSIONS)) {
    extendData.sessions = sessions;
  }
}
