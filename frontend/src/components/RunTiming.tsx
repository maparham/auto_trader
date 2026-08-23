import { useEffect, useRef, useState } from "react";
import { fmtRunDuration, remainingEta } from "../lib/duration";

interface RunTimingProps {
  // Backend pace estimate from the latest poll; null/absent until the first
  // unit of work lands, which hides the "~… left" half.
  etaSeconds?: number | null;
  // Client clock (performance.now() ms) the run started; absent on re-attached
  // runs (started before this page load), which then show only the ETA.
  startedAt?: number;
  className?: string;
}

// Live "elapsed · ~eta left" readout for a running sweep or walk-forward. Its
// own component so the 1-second countdown tick re-renders only this span, never
// the (large) results table it sits above. Renders nothing when neither half is
// available, so a caller can mount it unconditionally.
export default function RunTiming({ etaSeconds, startedAt, className }: RunTimingProps) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  // The backend recomputes etaSeconds only when work completes, so between
  // chunks the value repeats — remember the client clock at which the latest
  // DISTINCT value arrived and count down from there, so the readout keeps
  // moving between polls instead of freezing on the last estimate.
  const syncRef = useRef<{ eta: number; at: number } | null>(null);
  if (etaSeconds != null && syncRef.current?.eta !== etaSeconds) {
    syncRef.current = { eta: etaSeconds, at: performance.now() };
  }
  const now = performance.now();
  const elapsed = startedAt != null ? fmtRunDuration(now - startedAt) : null;
  const eta = syncRef.current
    ? `~${fmtRunDuration(remainingEta(syncRef.current.eta, syncRef.current.at, now) * 1000)} left`
    : null;
  const timing = [elapsed, eta].filter(Boolean).join(" · ");
  if (!timing) return null;
  return <span className={className}>{timing}</span>;
}
