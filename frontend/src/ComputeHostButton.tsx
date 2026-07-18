import { useEffect, useRef, useState } from "react";

import Tooltip from "./components/Tooltip";
import { toast } from "./lib/notify";
import {
  computeHostStateSignal,
  computeHostJobsSignal,
  sweepStateSignal,
  requestConfirm,
  type ComputeHostUiState,
} from "./lib/signals";
import { computeHostState, startComputeHost, stopComputeHost } from "./api";

// Toolbar control for the managed EC2 compute host. Always visible once the host
// is configured so the running instance (and its ~$3/hr cost) is impossible to
// miss: a filled amber "Compute host ON" pill with a Stop button while running,
// a subtle grey "Host off" + Start while stopped, a spinner while booting.
// Renders nothing on non-EC2 installs (state "unknown"/"unconfigured").
export default function ComputeHostButton() {
  const [state, setState] = useState<ComputeHostUiState>(computeHostStateSignal.value);
  useEffect(() => computeHostStateSignal.subscribe(setState), []);

  // A generation counter that a Start/Stop (and its error refresh) bumps. Any
  // async read — the background poll or the confirmed action return — only writes
  // the signal if the generation it captured before awaiting is still current.
  // Without this, a slow GET /api/compute/host that was already in flight when
  // the user hit Stop can resolve afterwards and repaint the amber "ON" pill on a
  // host they just stopped (a false billing signal) until the next poll tick.
  const genRef = useRef(0);

  const applyState = (s: ComputeHostUiState, activeJobs: number, gen: number) => {
    if (genRef.current !== gen) return false; // a newer action superseded this read
    computeHostStateSignal.set(s);
    computeHostJobsSignal.set(activeJobs);
    return true;
  };

  // App-wide poll of the host state so the pill always reflects reality (a sweep
  // from another tab, a manual stop, the idle self-stop). A setTimeout chain, not
  // setInterval, so it can stop cleanly on "unconfigured" (no EC2 host to manage).
  // Faster cadence while booting so "ready" shows promptly after Start.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const gen = genRef.current;
      try {
        const { state: s, activeJobs } = await computeHostState();
        if (!alive) return;
        const applied = applyState(s, activeJobs, gen);
        if (applied && s === "unconfigured") return; // nothing to manage; stop the loop
        // Cadence off the authoritative current state (an action may have won).
        timer = setTimeout(poll, computeHostStateSignal.value === "booting" ? 5000 : 12000);
      } catch {
        if (alive) timer = setTimeout(poll, 12000); // transient error: keep trying
      }
    };
    void poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Best-effort one-shot re-read of the true host state. Used after a failed
  // action so the pill never lingers on an optimistic value — for a cost signal,
  // a false "off" (or "on") must be corrected immediately, not 12s later.
  const refresh = async () => {
    const gen = (genRef.current += 1);
    try {
      const { state: s, activeJobs } = await computeHostState();
      applyState(s, activeJobs, gen);
    } catch {
      /* leave last-known state; the background poll will retry */
    }
  };

  const onStart = async () => {
    const gen = (genRef.current += 1);
    computeHostStateSignal.set("booting"); // optimistic; the poll/return confirms
    try {
      const res = await startComputeHost();
      applyState(res.state, computeHostJobsSignal.value, gen);
    } catch (e) {
      toast(e instanceof Error ? e.message : "could not start the compute host");
      void refresh(); // don't strand a false state; read what AWS actually reports
    }
  };

  const doStop = async () => {
    const gen = (genRef.current += 1);
    computeHostStateSignal.set("stopped"); // optimistic; the return is AWS-confirmed
    try {
      const res = await stopComputeHost();
      applyState(res.state, 0, gen);
    } catch (e) {
      toast(e instanceof Error ? e.message : "could not stop the compute host");
      void refresh(); // a rejected stop must not show a false "off" (still billing)
    }
  };

  const onStop = () => {
    const sweeping =
      sweepStateSignal.value?.running === true || computeHostJobsSignal.value > 0;
    requestConfirm({
      title: "Stop compute host?",
      message: sweeping
        ? "A sweep is running on the host. Stopping it now will cancel that run. Stop anyway?"
        : "Stop the compute host? You can start it again from here when you next need it.",
      confirmLabel: "Stop",
      onConfirm: () => void doStop(),
    });
  };

  if (state === "unknown" || state === "unconfigured") return null;

  if (state === "booting") {
    return (
      <Tooltip content="Compute host is starting (~40s). It will be ready shortly.">
        <span className="compute-host-btn is-booting" aria-live="polite">
          <span className="chart-nodata-spinner" aria-hidden="true" />
          <span>Starting…</span>
        </span>
      </Tooltip>
    );
  }

  if (state === "ready") {
    return (
      <span className="compute-host-btn is-on" aria-live="polite">
        <span className="compute-host-dot" aria-hidden="true" />
        <span>Compute host ON</span>
        <Tooltip content="Stop the EC2 compute host now to stop its hourly cost. It also stops itself after 15 idle minutes.">
          <button type="button" className="compute-host-stop" onClick={onStop}>
            Stop
          </button>
        </Tooltip>
      </span>
    );
  }

  // stopped
  return (
    <span className="compute-host-btn is-off">
      <span>Host off</span>
      <Tooltip content="Start the EC2 compute host for remote sweeps (~$3/hr while running; auto-stops when idle).">
        <button type="button" className="compute-host-start" onClick={() => void onStart()}>
          Start
        </button>
      </Tooltip>
    </span>
  );
}
