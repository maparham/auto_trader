// The detached view's visible exit. A Go-to-date jump deep enough to leave the
// loadable window swaps the cell onto a standalone window around that date with
// the live stream shut (chart/detachedView.ts), and nothing else on screen says
// so: a detached chart looks exactly like a live one panned a long way back.
// This pill is the difference, and its button is the ONLY way back — clearing
// `detached` is what reloads the live series.
//
// Presentational: it owns no state, reads the target from props, and hands the
// exit straight back to ChartCore.
import Tooltip from "./components/Tooltip";
import { browserTimezone } from "./chart/chartPainters";
import { useMaskedReplay } from "./lib/useMaskedReplay";

interface Props {
  /** The jump target, for the label. */
  targetMs: number;
  /** IANA zone for the label; "" means browser local (ChartCore's convention). */
  timezone: string;
  onBackToLive(): void;
}

export default function DetachedPill({ targetMs, timezone, onBackToLive }: Props) {
  // Fail closed the way every other date-printing surface outside ChartCore
  // does: any masked replay session anywhere on screen means no real date is
  // printed, even though this pill belongs to a cell that cannot itself be
  // replaying (detached and replay are mutually exclusive). A sibling cell's
  // blind session is exactly the case a per-cell check would miss.
  const masked = useMaskedReplay() !== null;
  // Locale pinned: the label is chrome the tests and the copy rules both read as
  // "Mar 7, 2024", not whatever the host's locale would reorder it into. The
  // zone is not pinned — it follows the cell's axis, so the date named here is
  // the date the axis shows.
  const label = masked
    ? "<hidden>"
    : new Intl.DateTimeFormat("en-US", {
        timeZone: timezone || browserTimezone(),
        year: "numeric",
        month: "short",
        day: "numeric",
      }).format(targetMs);

  return (
    <div className="chart-detached">
      <span className="chart-detached-label">Viewing {label}</span>
      <Tooltip content="The cell's live series, reloaded. Streaming resumes." placement="bottom">
        <button type="button" className="chart-detached-btn" onClick={onBackToLive}>
          Back to live
        </button>
      </Tooltip>
    </div>
  );
}
