import { useEffect, useRef, useState } from "react";

import Tooltip from "./components/Tooltip";
import { toast } from "./lib/notify";
import { mt5DeployStateSignal, type Mt5DeployUiState } from "./lib/signals";
import { deployMt5, mt5DeployState, undeployMt5 } from "./api";

// Dock control for the MetaApi (MT5) cloud account — the cost toggle. Rendered
// in the trading dock's account strip, only when MT5 is the active broker.
// Undeployed accounts don't bill, so the deployed state is impossible to miss:
// a filled amber "MT5 ON" pill with a Stop button while deployed, a subtle grey
// "MT5 off" + Start while undeployed, a spinner through the ~1-2 min
// deploy/undeploy transitions. Renders nothing when MetaApi isn't configured.
// Turning off confirms first: data + trading stop, and open positions stay
// open at the broker, unmanaged.
// mm:ss for the idle countdown.
function fmtCountdown(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function Mt5DeployButton() {
  const [state, setState] = useState<Mt5DeployUiState>(mt5DeployStateSignal.value);
  useEffect(() => mt5DeployStateSignal.subscribe(setState), []);

  // Idle-undeploy countdown (seconds), seeded from each poll's idle_seconds_remaining
  // and ticked down locally between polls; the server resets it on MT5 activity, so a
  // poll can jump it back up. null → no countdown (not deployed / not reported).
  const [remaining, setRemaining] = useState<number | null>(null);

  // Generation counter: a Start/Stop (and its error refresh) bumps it; any async
  // read only writes the signal if the generation it captured is still current.
  // Prevents a slow in-flight GET from repainting "ON" on an account the user
  // just undeployed (a false billing signal) until the next poll tick.
  const genRef = useRef(0);

  const applyState = (s: Mt5DeployUiState, gen: number) => {
    if (genRef.current !== gen) return false; // a newer action superseded this read
    mt5DeployStateSignal.set(s);
    return true;
  };

  // Background poll so the pill reflects reality (dashboard-side deploys, another
  // tab). setTimeout chain, not setInterval, so it stops cleanly on "unconfigured".
  // Faster cadence through transitions so "on"/"off" shows promptly.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const gen = genRef.current;
      try {
        const { state: s, idle_seconds_remaining } = await mt5DeployState();
        if (!alive) return;
        const applied = applyState(s, gen);
        if (applied) setRemaining(s === "on" ? idle_seconds_remaining : null);
        if (applied && s === "unconfigured") return; // nothing to manage; stop the loop
        const cur = mt5DeployStateSignal.value;
        timer = setTimeout(poll, cur === "turning-on" || cur === "turning-off" ? 5000 : 12000);
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

  // Tick the countdown down locally between polls so it reads smoothly; the poll
  // re-syncs it (and resets on activity). Only runs while a countdown is showing.
  useEffect(() => {
    if (remaining == null) return;
    const id = setInterval(() => setRemaining((r) => (r == null ? r : Math.max(0, r - 1))), 1000);
    return () => clearInterval(id);
  }, [remaining == null]);

  // One-shot re-read after a failed action: for a cost signal, a false "off"
  // (or "on") must be corrected immediately, not 12s later.
  const refresh = async () => {
    const gen = (genRef.current += 1);
    try {
      const { state: s } = await mt5DeployState();
      applyState(s, gen);
    } catch {
      /* leave last-known state; the background poll will retry */
    }
  };

  const onStart = async () => {
    const gen = (genRef.current += 1);
    mt5DeployStateSignal.set("turning-on"); // optimistic; the return confirms
    try {
      const res = await deployMt5();
      applyState(res.state, gen);
    } catch (e) {
      toast(e instanceof Error ? e.message : "could not deploy the MT5 account");
      void refresh();
    }
  };

  const doStop = async () => {
    const gen = (genRef.current += 1);
    mt5DeployStateSignal.set("turning-off"); // optimistic; the return confirms
    try {
      const res = await undeployMt5();
      applyState(res.state, gen);
    } catch (e) {
      toast(e instanceof Error ? e.message : "could not undeploy the MT5 account");
      void refresh(); // a rejected stop must not show a false "off" (still billing)
    }
  };

  const onStop = () => {
    const ok = window.confirm(
      "Turn MT5 off?\n\nThis undeploys the MetaApi account: price data and order " +
        "execution stop until you turn it back on (~1-2 min to redeploy). Open " +
        "positions at the broker stay open — and unmanaged — while it's off.",
    );
    if (ok) void doStop();
  };

  if (state === "unknown" || state === "unconfigured") return null;

  if (state === "turning-on" || state === "turning-off") {
    return (
      <Tooltip
        content={
          state === "turning-on"
            ? "MT5 account is deploying (~1-2 min). Data and trading resume when it's up."
            : "MT5 account is undeploying. Billing stops once it's down."
        }
      >
        <span className="compute-host-btn is-booting" aria-live="polite">
          <span className="chart-nodata-spinner" aria-hidden="true" />
          <span>{state === "turning-on" ? "MT5 starting…" : "MT5 stopping…"}</span>
        </span>
      </Tooltip>
    );
  }

  if (state === "on") {
    return (
      <span className="compute-host-btn is-on" aria-live="polite">
        <span className="compute-host-dot" aria-hidden="true" />
        <span>MT5 ON</span>
        {remaining != null && (
          <Tooltip content="Auto-undeploys when idle to stop hosting cost; using MT5 resets this.">
            <span className="compute-host-countdown" aria-label={`auto-undeploy in ${fmtCountdown(remaining)}`}>
              {fmtCountdown(remaining)}
            </span>
          </Tooltip>
        )}
        <Tooltip content="Undeploy the MetaApi account to pause its hosting cost. Open positions stay open at the broker.">
          <button type="button" className="compute-host-stop" onClick={onStop}>
            Stop
          </button>
        </Tooltip>
      </span>
    );
  }

  // off
  return (
    <span className="compute-host-btn is-off">
      <span>MT5 off</span>
      <Tooltip content="Deploy the MetaApi account (~1-2 min) to resume MT5 data and trading. Hosting billing runs while deployed.">
        <button type="button" className="compute-host-start" onClick={() => void onStart()}>
          Start
        </button>
      </Tooltip>
    </span>
  );
}
