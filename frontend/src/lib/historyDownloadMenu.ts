// The chart context menu's admin-only "Download history" entries.
//
// Pure builders (like chartOrderMenu) so the admin gate and the duration →
// years mapping are testable: ChartCore wires the two-level flow (the main
// item swaps the open menu for the duration chooser) and owns the job state.
import type { MenuItem } from "../ContextMenu";
import type { HistoryJob } from "../api";

export interface HistoryDownloadDeps {
  isAdmin: boolean;
  /** Synthetic charts combine other series; there is nothing to download. */
  synthetic: boolean;
  /** Sub-minute intervals live in the tick store, not the candle cache. */
  liveOnly: boolean;
  /** A download for this series is already running. */
  running: boolean;
  openDurations: () => void;
  cancel: () => void;
}

export function historyDownloadItems(d: HistoryDownloadDeps): MenuItem[] {
  if (!d.isAdmin || d.synthetic || d.liveOnly) return [];
  if (d.running) {
    return [{ label: "Cancel history download", danger: true, onClick: d.cancel }];
  }
  return [{ label: "Download history…", onClick: d.openDurations }];
}

/** null years = walk to the broker's retention floor (everything it has). */
const DURATIONS: Array<{ label: string; years: number | null }> = [
  { label: "Past year", years: 1 },
  { label: "Past 5 years", years: 5 },
  { label: "Past 10 years", years: 10 },
  { label: "All available history", years: null },
];

export function historyDurationItems(start: (years: number | null) => void): MenuItem[] {
  return DURATIONS.map((d) => ({ label: d.label, onClick: () => start(d.years) }));
}

const day = (ts: number): string => new Date(ts * 1000).toISOString().slice(0, 10);

/** One-line pill text for a job's current state. */
export function historyJobLabel(job: HistoryJob): string {
  const reached = job.oldestTs != null ? `, back to ${day(job.oldestTs)}` : "";
  if (job.status === "running") {
    const bars = job.bars > 0 ? ` (${job.bars.toLocaleString("en-US")} bars)` : "";
    // Bounded downloads know their span; "all history" only knows how deep it is.
    if (job.pct != null) return `Downloading history ${Math.round(job.pct * 100)}%${bars}`;
    return `Downloading history${reached}${bars}`;
  }
  if (job.status === "done") {
    return job.result === "floor" ? `Full history loaded${reached}` : `History loaded${reached}`;
  }
  if (job.status === "cancelled") return "History download cancelled";
  return "History download failed";
}
