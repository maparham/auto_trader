import { describe, it, expect } from "vitest";
// lib/persist (pulled in via the action modules) touches localStorage at
// module-eval time and vitest runs .ts tests in the 'node' env.
import { installMemStorage } from "../lib/testMemStorage";

installMemStorage();

import { agentBridgeEnabled, initAgentBridge } from "./index";
import { listActions } from "./registry";

describe("agent bootstrap", () => {
  it("never dials the relay from a unit-test run", () => {
    // If this ever flips true, initAgentBridge() below would open a real
    // WebSocket (with a reconnect loop) in every suite that imports App.
    expect(agentBridgeEnabled()).toBe(false);
  });

  it("initAgentBridge is idempotent and survives a repeat registration", () => {
    initAgentBridge();
    expect(listActions().some((a) => a.name === "backtest.run")).toBe(true);
    // Module flag makes the second call a no-op; even if HMR reset it, the
    // try/catch around the register calls keeps the duplicate from throwing.
    expect(() => initAgentBridge()).not.toThrow();
  });
});
