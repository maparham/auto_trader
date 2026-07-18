import { useEffect, useState } from "react";

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

  // App-wide poll of the host state so the pill always reflects reality (a sweep
  // from another tab, a manual stop, the idle self-stop). A setTimeout chain, not
  // setInterval, so it can stop cleanly on "unconfigured" (no EC2 host to manage).
  // Faster cadence while booting so "ready" shows promptly after Start.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const { state: s, activeJobs } = await computeHostState();
        if (!alive) return;
        computeHostStateSignal.set(s);
        computeHostJobsSignal.set(activeJobs);
        if (s === "unconfigured") return; // nothing to manage; stop the loop
        timer = setTimeout(poll, s === "booting" ? 5000 : 12000);
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

  const onStart = async () => {
    computeHostStateSignal.set("booting"); // optimistic; the poll confirms
    try {
      const res = await startComputeHost();
      computeHostStateSignal.set(res.state);
    } catch (e) {
      computeHostStateSignal.set("stopped");
      toast(e instanceof Error ? e.message : "could not start the compute host");
    }
  };

  const doStop = async () => {
    computeHostStateSignal.set("stopped"); // optimistic
    try {
      const res = await stopComputeHost();
      computeHostStateSignal.set(res.state);
    } catch (e) {
      toast(e instanceof Error ? e.message : "could not stop the compute host");
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
