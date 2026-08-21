// @vitest-environment jsdom
//
// The two chart study modes after they moved out of the cell and into the
// toolbar. What moved is not just markup: there is now ONE of each, acting on
// whichever cell has focus, so the state the buttons read has to arrive over the
// focused ChartController rather than from props.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { installMemStorage } from "./lib/testMemStorage";

installMemStorage();

const { default: Toolbar } = await import("./Toolbar");
const { ChartController } = await import("./lib/chartController");

const SYMBOL = { epic: "US100", name: "US 100", status: null, pricePrecision: 1 };
const PERIOD = { label: "15m", resolution: "MINUTE_15", seconds: 900 };

let controller: InstanceType<typeof ChartController>;

const view = {
  side: "long" as const,
  basis: "volatility" as const,
  width: 2,
  window: 200,
  atrLength: 14,
  agg: "max" as const,
  baseResolution: "MINUTE_15",
};

const setOn = vi.fn();
const setView = vi.fn();

const publishHeatmap = (on: boolean) =>
  controller.heatmap.set({ on, view, belowBase: false, setOn, setView });

const publishReplay = (available: boolean, active: boolean) =>
  controller.replayEntry.set({ available, active, enter: enterReplay });

const enterReplay = vi.fn();

function paint() {
  render(
    <Toolbar
      controller={controller}
      symbol={SYMBOL as never}
      period={PERIOD as never}
      onSymbol={() => {}}
      onPeriod={() => {}}
      brokerId="capital"
      priceSide={"mid" as never}
      accounts={[]}
      onSelectBroker={() => {}}
      maximized={false}
      onToggleMaximize={() => {}}
    />,
  );
}

const replayBtn = () => document.querySelector(".toolbar .replay-toggle") as HTMLButtonElement;
const heatBtn = () => document.querySelector(".toolbar .heatmap-toggle") as HTMLButtonElement;
const caretBtn = () => document.querySelector(".toolbar .heatmap-caret") as HTMLButtonElement;
const panel = () => document.querySelectorAll(".heatmap-panel").length;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  controller = new ChartController("cell-a", "tab.test");
});

afterEach(cleanup);

describe("the replay entry in the toolbar", () => {
  it("starts a session on the focused cell", () => {
    publishReplay(true, false);
    paint();
    expect(replayBtn().disabled).toBe(false);
    fireEvent.click(replayBtn());
    expect(enterReplay).toHaveBeenCalledOnce();
  });

  // Disabled rather than hidden: the toolbar is stable chrome, and a control that
  // vanishes reads as a bug. The two refusals are different facts.
  it("is disabled, not absent, on a cell that can never replay", () => {
    publishReplay(false, false);
    paint();
    expect(replayBtn()).not.toBeNull();
    expect(replayBtn().disabled).toBe(true);
  });

  it("is disabled while a session is already running", () => {
    publishReplay(true, true);
    paint();
    expect(replayBtn().disabled).toBe(true);
  });

  // No chart mounted: nothing published, so the button must not act on a cell
  // that isn't there.
  it("is disabled when the cell has published nothing", () => {
    paint();
    expect(replayBtn().disabled).toBe(true);
    fireEvent.click(replayBtn());
    expect(enterReplay).not.toHaveBeenCalled();
  });
});

describe("the heatmap split in the toolbar", () => {
  it("toggles the paint and opens the settings with it", () => {
    publishHeatmap(false);
    paint();
    expect(panel()).toBe(0);
    fireEvent.click(heatBtn());
    expect(setOn).toHaveBeenCalledWith(true);
    // The panel opens off the click, not off the published state (which a real
    // cell republishes a tick later).
    expect(panel()).toBe(1);
  });

  // House rule: every popover closes on an outside mousedown. The thing worth
  // asserting beyond that is what SURVIVES the close — the heatmap keeps
  // painting, which is the whole reason the panel and the toggle are separate
  // controls now.
  it("closes the panel on an outside click, leaving the heatmap on", () => {
    publishHeatmap(false);
    paint();
    fireEvent.click(heatBtn());
    expect(panel()).toBe(1);
    fireEvent.mouseDown(document.body);
    expect(panel()).toBe(0);
    expect(setOn).toHaveBeenCalledTimes(1); // the close did NOT turn it off
    expect(setOn).toHaveBeenLastCalledWith(true);
  });

  it("stays open when the click lands inside it", () => {
    publishHeatmap(true);
    paint();
    fireEvent.click(caretBtn());
    expect(panel()).toBe(1);
    fireEvent.mouseDown(document.querySelector(".heatmap-panel")!);
    expect(panel()).toBe(1);
  });

  it("reopens the settings from the caret without touching the paint", () => {
    publishHeatmap(true);
    paint();
    fireEvent.click(caretBtn());
    expect(panel()).toBe(1);
    expect(setOn).not.toHaveBeenCalled();
  });

  it("shows the ON state on the face", () => {
    publishHeatmap(true);
    paint();
    expect(heatBtn().className).toContain("seg-on");
  });

  it("edits the view through the panel", () => {
    publishHeatmap(true);
    paint();
    fireEvent.click(caretBtn());
    fireEvent.click(screen.getByText("Short"));
    expect(setView).toHaveBeenCalledWith({ side: "short" });
  });

  it("is disabled when the cell has published nothing", () => {
    paint();
    expect(heatBtn().disabled).toBe(true);
    expect(caretBtn().disabled).toBe(true);
  });
});
