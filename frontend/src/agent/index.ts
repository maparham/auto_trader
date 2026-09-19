// Entry point: registers all action modules and starts the WS bridge when the
// build enables it (VITE_AGENT_BRIDGE=1; dev builds default on). Idempotent.
import { startAgentBridge } from "agent-ui-bridge";
import { API_BASE } from "../lib/http";
import { getAuthToken, hasTokenGetter } from "../lib/authToken";
import { withImpersonation } from "../lib/impersonation";
import { registerBacktestActions } from "./actions/backtest";
import { registerSweepActions } from "./actions/sweep";
import { registerDealingActions } from "./actions/dealing";
import { registerDrawingActions } from "./actions/drawings";
import { registerChartActions } from "./actions/chart";
import { registerIndicatorActions } from "./actions/indicators";
import { registerTabActions } from "./actions/tab";

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
    registerDrawingActions();
    registerChartActions();
    registerIndicatorActions();
    registerTabActions();
  } catch (e) {
    console.debug("agent: actions already registered (HMR?)", e);
  }
  if (!agentBridgeEnabled()) return;
  startAgentBridge({
    url: `${API_BASE.replace(/^http/, "ws")}/ws/agent-ui`,
    // Resolved per (re)connect, not once: ClerkTokenBridge may register its
    // getter after this runs, and Clerk tokens live about 60s. With no getter
    // registered (local dev, tests) this answers null synchronously and the
    // bridge dials in the same tick, exactly as it did before auth existed.
    token: () => (hasTokenGetter() ? getAuthToken() : null),
    decorateUrl: withImpersonation,
  });
}
