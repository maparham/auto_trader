// Shown when a replay session ends: what the session did, and — for a blind
// session — when it actually was. The reveal is the point: a masked session
// deliberately never showed a real date until now.
//
// This card is the ONE deliberate exception to the feature's blindness rule, and
// that makes it a ONE-WAY DOOR. By the time it is on screen the user has seen
// the real dates of bars they traded blind, so there must be no path from here
// back into the session: no outside-click dismiss, no Escape-to-cancel, no
// resume behind it. Done and Escape do the same thing (the real teardown).
//
// The enforcement is in two halves, because this card has no scrim (see below)
// and the pill therefore stays clickable underneath it. useReplay gates
// stepping, playback and fills on its own `pendingReport` for as long as this is
// mounted — that is the half that is authoritative — and ReplayPill disables its
// controls on the same flag, which is the half the user can see. The pill needs
// its own: without it, a click landing on ⟲ through this card would turn a ✕
// exit into a "pick new start" and change where Done lands them.
//
// Deliberately NOT following the app's "menus close on outside click" rule for
// exactly that reason: an outside click here would have to either cancel the
// exit (impossible, the reveal cannot be un-seen) or perform it silently (a
// teardown the user never asked for).
import { useEffect, useRef } from "react";
import type { ReplaySummary } from "./lib/replayLedger";

interface Props {
  summary: ReplaySummary;
  /** Real (unmasked) session bounds, formatted by the caller in the cell's timezone. */
  startLabel: string;
  endLabel: string;
  masked: boolean;
  onDone(): void;
}

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
// U+2212 MINUS SIGN, not a hyphen: it aligns with the digits under
// font-variant-numeric: tabular-nums, where a hyphen sits high and short.
const signed = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}`;

export default function ReplayReportCard({ summary, startLabel, endLabel, masked, onDone }: Props) {
  const doneRef = useRef<HTMLButtonElement | null>(null);

  // Focus the one control the card has, so a keyboard user lands on the exit
  // rather than wherever the pill left them.
  useEffect(() => {
    doneRef.current?.focus({ preventScroll: true });
  }, []);

  // Escape performs the SAME teardown as Done — never a cancel. Bound on the
  // document in the CAPTURE phase, for two reasons: the key must work wherever
  // focus is (the chart wrap holds it for most of a session), and capture at the
  // document runs before React's own listener on the root container, so the
  // cell's onKeyDown cannot spend this Escape cancelling a drawing tool first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onDone();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onDone]);

  // role="dialog" WITHOUT aria-modal: the rest of the cell is not inert (the
  // pill and the ticket are still in the tab order, just gated into no-ops by
  // the hook), and claiming otherwise would stop a screen reader announcing
  // controls its user can still reach. Making aria-modal honest would mean a
  // focus trap and a scrim, which the hook-level gate makes unnecessary.
  return (
    <div className="replay-report" role="dialog" aria-label="Replay session report">
      <div className="rr-title">Session report</div>

      {masked && (
        <div className="rr-reveal">
          <span className="rr-reveal-label">This was</span>
          <span className="rr-reveal-range">
            {startLabel} to {endLabel}
          </span>
        </div>
      )}

      <div className="rr-stats">
        <div className="rr-stat">
          <span className="rr-k">Trades</span>
          <span className="rr-v">{summary.trades}</span>
        </div>
        <div className="rr-stat">
          <span className="rr-k">Win rate</span>
          <span className="rr-v">{summary.trades ? pct(summary.winRate) : "-"}</span>
        </div>
        {/* "closed trades", not just "Net P&L": summarize() is realized-only, so
            a session that ends holding a position shows this figure directly
            beside a "Still open" count. Under a bare "Net P&L" that reads as a
            total including the open one, which it is not. Label fix only: adding
            an unrealized figure would change the ledger's tested summary shape
            for a card that is about closed results. */}
        <div className="rr-stat">
          <span className="rr-k">Net P&amp;L (closed trades)</span>
          <span className={`rr-v ${summary.netPnl >= 0 ? "pos" : "neg"}`}>{signed(summary.netPnl)}</span>
        </div>
        {summary.openPositions > 0 && (
          <div className="rr-stat">
            <span className="rr-k">Still open</span>
            <span className="rr-v">{summary.openPositions}</span>
          </div>
        )}
      </div>

      <div className="rr-note">
        Prices come straight from the candles: no spread, slippage or commission.
      </div>

      <button ref={doneRef} type="button" className="rr-done" onClick={onDone}>
        Done
      </button>
    </div>
  );
}
