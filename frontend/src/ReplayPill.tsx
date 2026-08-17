// Floating replay controls (TradingView puts them bottom-center). Presentational:
// every action is a callback into chart/useReplay.ts. No session state, no
// fetching, no storage lives here — the hook owns all of it.
import Tooltip from "./components/Tooltip";
import { REPLAY_SPEEDS, type ReplayUiState } from "./chart/useReplay";

interface Props {
  state: ReplayUiState;
  /** Already-formatted cursor label: a real date, or "Day N HH:mm" when masked. */
  readout: string;
  onStepBack(): void;
  onPlayPause(): void;
  onStepForward(): void;
  onSpeed(ms: number): void;
  onNewStart(): void;
  onExit(): void;
  /** Open/close the replay order ticket. */
  onToggleTicket(): void;
  ticketOpen: boolean;
  /** True while the session report card is up. The session is technically still
   * active behind it (that is what lets the card report on it), so the pill is
   * still mounted — but the card is a one-way door and every control here is
   * dead. DISABLED rather than hidden, for the same reason the atEnd note below
   * gives: a disabled button is what explains why nothing moved. */
  reportPending: boolean;
}

export default function ReplayPill({
  state,
  readout,
  onStepBack,
  onPlayPause,
  onStepForward,
  onSpeed,
  onNewStart,
  onExit,
  onToggleTicket,
  ticketOpen,
  reportPending,
}: Props) {
  // Rewound = the cursor sits behind the furthest bar this session ever revealed.
  // The hook never lowers highWaterMs, so this is a view-only state the user has
  // to leave before trading again (Task 12).
  const rewound = state.cursorMs < state.highWaterMs;
  // One explanation for every dead control, so a pill frozen behind the report
  // card says why instead of going quietly unresponsive. The hook refuses these
  // actions regardless (useReplay gates on its own pendingReport); this is the
  // half the user can see.
  const tip = (normal: string) =>
    reportPending ? "This session has ended: close the report card" : normal;
  return (
    <div className="replay-pill" role="group" aria-label="Replay controls">
      <Tooltip content={tip("Step back one bar (view only: trades are not undone)")}>
        <button
          type="button"
          className="rp-btn"
          aria-label="Step back"
          onClick={onStepBack}
          disabled={reportPending}
        >
          ⏮
        </button>
      </Tooltip>
      {/* Forward controls stay ENABLED at atEnd. "Caught up" means the store has
          no loaded bar after the cursor, but in a live market more print while the
          user sits there, and pressing forward is what re-attempts the refill that
          finds them (useReplay clears atEnd when one lands). Disabling them made
          the badge a dead end for the rest of the session. The badge, not a
          disabled button, is what explains why nothing moved.

          A pending REPORT is the opposite case and does disable them: there is
          no "later" to wait for, because the session is over and the reveal has
          already shown the user the real dates. */}
      <Tooltip
        content={tip(
          state.playing ? "Pause" : state.atEnd ? "Check for new bars, then play" : "Play",
        )}
      >
        <button
          type="button"
          className="rp-btn rp-play"
          aria-label={state.playing ? "Pause" : "Play"}
          onClick={onPlayPause}
          disabled={reportPending}
        >
          {state.playing ? "⏸" : "▶"}
        </button>
      </Tooltip>
      <Tooltip
        content={tip(
          state.atEnd ? "At the live edge: check for newly printed bars" : "Step forward one bar",
        )}
      >
        <button
          type="button"
          className="rp-btn"
          aria-label="Step forward"
          onClick={onStepForward}
          disabled={reportPending}
        >
          ⏭
        </button>
      </Tooltip>

      <select
        className="rp-speed"
        aria-label="Replay speed"
        value={state.speedMs}
        onChange={(e) => onSpeed(Number(e.target.value))}
        disabled={reportPending}
      >
        {REPLAY_SPEEDS.map((s) => (
          <option key={s.ms} value={s.ms}>
            {s.label}
          </option>
        ))}
      </select>

      <span className={`rp-readout${state.masked ? " masked" : ""}`}>{readout}</span>

      {rewound && <span className="rp-rewound">rewound</span>}
      {state.atEnd && <span className="rp-atend">caught up</span>}
      {state.error && <span className="rp-error">{state.error}</span>}

      {/* Trading during a session goes through the ledger-backed ticket, never
          the account's order ticket. Rewound is not a reason to hide it: the
          ticket is where the "step forward to X to trade" note lives, so pulling
          it would take away the explanation with the buttons. */}
      <Tooltip
        content={tip(ticketOpen ? "Hide the replay order ticket" : "Trade this replay session")}
      >
        <button
          type="button"
          className={`rp-btn rp-trade${ticketOpen ? " on" : ""}`}
          aria-label="Replay order ticket"
          aria-pressed={ticketOpen}
          onClick={onToggleTicket}
          disabled={reportPending}
        >
          Trade
        </button>
      </Tooltip>

      <Tooltip content={tip("Pick a new start point")}>
        {/* requestNewStart, never startAt or enterPicking: picking from an active
            session must END that session, and the user is owed the report card's
            reveal on the way out (the card is what then enters picking).

            Disabled while that card is up, and this is the one that BIT: without
            it, a card opened by ✕ could be turned into a ⟲ by clicking straight
            through to the button underneath, so Done would land the user in the
            picker instead of back at live. */}
        <button
          type="button"
          className="rp-btn"
          aria-label="Pick new start"
          onClick={onNewStart}
          disabled={reportPending}
        >
          ⟲
        </button>
      </Tooltip>
      <Tooltip content={tip("Exit replay and return to live")}>
        <button
          type="button"
          className="rp-btn rp-exit"
          aria-label="Exit replay"
          onClick={onExit}
          disabled={reportPending}
        >
          ✕
        </button>
      </Tooltip>
    </div>
  );
}
