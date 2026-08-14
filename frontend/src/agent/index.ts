// Entry point: registers all action modules and starts the WS bridge when the
// build enables it (VITE_AGENT_BRIDGE=1; dev builds default on). Idempotent.
import { startAgentBridge } from "./bridge";
import { registerBacktestActions } from "./actions/backtest";
import { registerSweepActions } from "./actions/sweep";
import { registerDealingActions } from "./actions/dealing";

let initialized = false;

export function agentBridgeEnabled(): boolean {
  const env = (import.meta as unknown as { env?: Record<string, string | boolean> }).env ?? {};
  const flag = env.VITE_AGENT_BRIDGE;
  if (flag === "1" || flag === "true") return true;
  if (flag === "0" || flag === "false") return false;
  // Never dial out from a unit-test run (vitest sets DEV too, and a real
  // WebSocket there would leave a reconnect loop running across the suite).
  if (env.MODE === "test" || env.TEST === true || env.TEST === "true") return false;
  return Boolean(env.DEV);
}

export function initAgentBridge(): void {
  if (initialized) return;
  initialized = true;
  // The module flag covers StrictMode's double invoke; a Vite HMR reload of
  // THIS module resets it, and registerAction throws on a duplicate name, so
  // keep a re-registration from taking the app down with it.
  try {
    registerBacktestActions();
    registerSweepActions();
    registerDealingActions();
  } catch (e) {
    console.debug("agent: actions already registered (HMR?)", e);
  }
  if (agentBridgeEnabled()) startAgentBridge();
}
