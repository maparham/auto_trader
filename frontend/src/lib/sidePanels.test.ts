import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  claimSidePanel,
  endSidePanelRestore,
  registerSidePanel,
  resetSidePanelsForTest,
} from "./sidePanels";
import {
  alertsPanelOpen,
  livePanelOpen,
  tradeListPanelOpen,
  tradePanelOpen,
  toggleSidePanel,
} from "./signals";

// Only one right-docked side panel may be open at a time: opening one closes
// whichever other one was open.
describe("side panel exclusivity", () => {
  beforeEach(() => {
    resetSidePanelsForTest();
    for (const s of [alertsPanelOpen, livePanelOpen, tradeListPanelOpen, tradePanelOpen])
      s.set(false);
    registerSidePanel("alerts", () => alertsPanelOpen.set(false));
    registerSidePanel("trade", () => tradePanelOpen.set(false));
    registerSidePanel("tradeList", () => tradeListPanelOpen.set(false));
    registerSidePanel("live", () => livePanelOpen.set(false));
  });

  it("toggling one panel on closes the others", () => {
    toggleSidePanel("alerts");
    expect(alertsPanelOpen.value).toBe(true);

    toggleSidePanel("tradeList");
    expect(tradeListPanelOpen.value).toBe(true);
    expect(alertsPanelOpen.value).toBe(false);

    toggleSidePanel("live");
    expect(livePanelOpen.value).toBe(true);
    expect(tradeListPanelOpen.value).toBe(false);
  });

  it("toggling the open panel again just closes it", () => {
    toggleSidePanel("trade");
    toggleSidePanel("trade");
    expect(tradePanelOpen.value).toBe(false);
  });

  it("closers registered from outside signals.ts (backtest, patterns) fire too", () => {
    let backtestOpen = true;
    registerSidePanel("backtest", () => {
      backtestOpen = false;
    });
    toggleSidePanel("alerts");
    expect(backtestOpen).toBe(false);
    expect(alertsPanelOpen.value).toBe(true);
  });

  it("a claim does not close the claimant, even via a reentrant closer", () => {
    // stageChartOrder clears the trade selection (which closes the trade panel)
    // on its way to opening it — a nested claim must not undo the outer one.
    registerSidePanel("alerts", () => {
      alertsPanelOpen.set(false);
      claimSidePanel("alerts"); // reentrant
    });
    alertsPanelOpen.set(true);
    toggleSidePanel("trade");
    expect(tradePanelOpen.value).toBe(true);
    expect(alertsPanelOpen.value).toBe(false);
  });

  it("claims are inert until boot restore is over", async () => {
    // Fresh module so the restoring latch is armed again, as it is at app boot:
    // restoring a persisted panel must not run another panel's closer (those
    // closers persist, so a cross-close at boot would wipe saved state).
    vi.resetModules();
    const fresh = await import("./sidePanels");
    let closed = false;
    fresh.registerSidePanel("backtest", () => {
      closed = true;
    });
    fresh.claimSidePanel("live");
    expect(closed).toBe(false);

    fresh.endSidePanelRestore();
    fresh.claimSidePanel("live");
    expect(closed).toBe(true);
  });
});
