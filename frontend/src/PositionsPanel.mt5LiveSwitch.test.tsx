// @vitest-environment jsdom
// MT5 coming on (off → on) jumps the dock to the live account so its balance and
// positions show; a boot read that finds MT5 already on leaves the pick alone.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

vi.mock("./Mt5DeployButton", () => ({ default: () => null }));

import PositionsPanel from "./PositionsPanel";
import { mt5DeployStateSignal } from "./lib/signals";
import type { BrokerAccount } from "./lib/trading";
import { DEFAULT_SETTINGS } from "./theme";

const accounts: BrokerAccount[] = [
  { key: "mt5:paper", broker: "mt5", env: "paper", isRealMoney: false },
  { key: "mt5:live", broker: "mt5", env: "live", isRealMoney: true },
];

function mount(account: string) {
  const onAccountChange = vi.fn();
  render(
    <PositionsPanel
      account={account}
      accounts={accounts}
      onAccountChange={onAccountChange}
      trading={DEFAULT_SETTINGS.trading}
    />,
  );
  return onAccountChange;
}

afterEach(() => {
  cleanup();
  mt5DeployStateSignal.set("unknown");
});

describe("PositionsPanel MT5 live auto-switch", () => {
  it("switches paper to live when MT5 comes on", () => {
    mt5DeployStateSignal.set("off");
    const change = mount("mt5:paper");
    act(() => mt5DeployStateSignal.set("turning-on"));
    act(() => mt5DeployStateSignal.set("on"));
    expect(change).toHaveBeenCalledWith("mt5:live");
  });

  it("leaves a paper pick alone when MT5 is already on at boot", () => {
    const change = mount("mt5:paper");
    act(() => mt5DeployStateSignal.set("on")); // first poll: unknown → on
    act(() => mt5DeployStateSignal.set("on")); // later polls repeat "on"
    expect(change).not.toHaveBeenCalled();
  });
});
