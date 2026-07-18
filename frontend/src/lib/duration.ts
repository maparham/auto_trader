// Shared run-duration formatting + sweep ETA countdown math, used by the
// settings modal's "Took Ns" footer readout and the sweep progress bar's
// live "elapsed · ~eta left" readout.

// Sub-10s keeps a decimal (short runs would all read "4s"), longer runs round
// to whole units.
export function fmtRunDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s - m * 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// Live ETA between polls: the backend recomputes etaSeconds on each poll
// (~700ms), and the UI ticks every second in between. Given the eta value and
// the client clock (performance.now() ms) at which it was received, return the
// seconds still remaining at `nowMs` — clamped at 0 so a sweep that runs past
// its estimate reads "~0s left" rather than counting negative.
export function remainingEta(etaSeconds: number, syncedAtMs: number, nowMs: number): number {
  return Math.max(0, etaSeconds - (nowMs - syncedAtMs) / 1000);
}
