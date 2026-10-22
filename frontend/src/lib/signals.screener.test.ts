import { beforeEach, describe, expect, it } from "vitest";
import { endSidePanelRestore } from "./sidePanels";
import { alertsPanelOpen, screenerPanelOpen, toggleSidePanel } from "./signals";

beforeEach(() => {
  endSidePanelRestore();
  alertsPanelOpen.set(false);
  screenerPanelOpen.set(false);
});

describe("screener side panel", () => {
  it("toggles open and closed", () => {
    toggleSidePanel("screener");
    expect(screenerPanelOpen.value).toBe(true);
    toggleSidePanel("screener");
    expect(screenerPanelOpen.value).toBe(false);
  });

  it("claims the dock from another panel and yields it back", () => {
    toggleSidePanel("alerts");
    toggleSidePanel("screener");
    expect(alertsPanelOpen.value).toBe(false);
    expect(screenerPanelOpen.value).toBe(true);
    toggleSidePanel("alerts");
    expect(screenerPanelOpen.value).toBe(false);
  });
});
