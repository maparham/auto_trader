// Floating replay controls, parked at the cell's top-right corner and draggable
// anywhere inside it. Presentational as far as the SESSION goes: every action is
// a callback into chart/useReplay.ts, and no session state or fetching lives
// here. The one thing it does own is where it sits, because that is a property
// of this pill on this screen and nothing else needs to know it (lib/replayPillPos).
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import Tooltip from "./components/Tooltip";
import { REPLAY_SPEEDS, type ReplayUiState } from "./chart/useReplay";
import {
  clampPillPos,
  loadPillPos,
  savePillPos,
  clearPillPos,
  type PillPos,
} from "./lib/replayPillPos";

interface Props {
  state: ReplayUiState;
  /** The cell's persistence scope: where this pill's dragged position is kept. */
  scope: string;
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
  /** Reveal the cell's saved backtest bar by bar as the cursor passes each fill. */
  onToggleStrategy(): void;
  showStrategy: boolean;
  /** False when this cell has no saved backtest: the button is disabled and the
   * tooltip says what to do about it. */
  hasStrategy: boolean;
  /** True while the session report card is up. The session is technically still
   * active behind it (that is what lets the card report on it), so the pill is
   * still mounted — but the card is a one-way door and every control here is
   * dead. DISABLED rather than hidden, for the same reason the atEnd note below
   * gives: a disabled button is what explains why nothing moved. */
  reportPending: boolean;
}

export default function ReplayPill({
  state,
  scope,
  readout,
  onStepBack,
  onPlayPause,
  onStepForward,
  onSpeed,
  onNewStart,
  onExit,
  onToggleTicket,
  ticketOpen,
  onToggleStrategy,
  showStrategy,
  hasStrategy,
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

  // --- drag ------------------------------------------------------------------
  //
  // Null means "wherever the CSS parks it" (top-right), which is also what a
  // reset returns to: no stored position is a real state, not a position of
  // (8, 8), so the corner keeps working when the cell resizes.
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<PillPos | null>(() => loadPillPos(scope));
  // Where in the pill the pointer grabbed it, so it doesn't jump under the
  // cursor on the first move.
  const grab = useRef<{ dx: number; dy: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  // Clamp whatever is stored back inside the cell, after layout. A cell that
  // shrank, a split that went from one column to four, or a record written on a
  // wider screen would otherwise leave the pill half outside or fully hidden.
  // Layout effect, not effect: this runs before paint, so a clamped pill never
  // shows for a frame at its out-of-bounds position.
  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!el || !parent || !pos) return;
    const next = clampPillPos(pos, parent.getBoundingClientRect(), el.getBoundingClientRect());
    if (next.x !== pos.x || next.y !== pos.y) setPos(next);
  }, [pos]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Only a drag of the BAR itself. Every control on it is interactive, and a
      // press that started on one must reach it: `closest` covers the button's
      // own children (the SVG in an icon button) as well as the button.
      if ((e.target as HTMLElement).closest("button, select, input, a")) return;
      const el = ref.current;
      const parent = el?.offsetParent as HTMLElement | null;
      if (!el || !parent) return;
      const box = el.getBoundingClientRect();
      grab.current = { dx: e.clientX - box.left, dy: e.clientY - box.top };
      setDragging(true);
      // Capture on the element, so a fast drag that outruns the pointer keeps
      // sending moves here instead of to whatever is underneath — including the
      // chart, which would read them as a pan.
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const g = grab.current;
      const el = ref.current;
      const parent = el?.offsetParent as HTMLElement | null;
      if (!g || !el || !parent) return;
      const cell = parent.getBoundingClientRect();
      setPos(
        clampPillPos(
          { x: e.clientX - cell.left - g.dx, y: e.clientY - cell.top - g.dy },
          cell,
          el.getBoundingClientRect(),
        ),
      );
    },
    [],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!grab.current) return;
      grab.current = null;
      setDragging(false);
      ref.current?.releasePointerCapture(e.pointerId);
      // Persist the landed position, not every frame of the drag: a 60Hz drag
      // would otherwise write to storage sixty times a second.
      if (pos) savePillPos(scope, pos);
    },
    [pos, scope],
  );

  // Double-click the bar (not a control) to send it home. A dragged pill can end
  // up somewhere the user did not mean, and hunting for a reset in a menu for a
  // thing this small would be worse than the problem.
  const onDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).closest("button, select, input, a")) return;
      setPos(null);
      clearPillPos(scope);
    },
    [scope],
  );

  return (
    <div
      ref={ref}
      className={`replay-pill${pos ? " rp-moved" : ""}${dragging ? " rp-dragging" : ""}`}
      style={pos ? { left: pos.x, top: pos.y } : undefined}
      role="group"
      aria-label="Replay controls"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
    >
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

      {/* The saved backtest, revealed at the cursor rather than all at once.
          Two independent gates: no saved result to reveal (the tooltip says to
          run one), and the report card, which freezes every control here. The
          "on" styling reads off hasStrategy too, so a sticky toggle carried over
          from a cell that HAD a backtest never paints a disabled button as
          active. */}
      <Tooltip
        content={tip(
          hasStrategy
            ? "Reveal the saved backtest as the cursor passes each trade"
            : "Run a backtest on this chart first",
        )}
      >
        <button
          type="button"
          className={`rp-btn${hasStrategy && showStrategy ? " rp-on" : ""}`}
          aria-label="Reveal strategy"
          aria-pressed={hasStrategy && showStrategy}
          onClick={onToggleStrategy}
          disabled={!hasStrategy || reportPending}
        >
          Strategy
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
