import { describe, it, expect, afterEach } from "vitest";
import {
  anyCellInReadout,
  anyCellReplaying,
  setCellReadout,
  setCellReplaying,
  subscribeReplayingCells,
} from "./replayingCells";

afterEach(() => {
  // The registries are module-level; put back what a test set.
  setCellReplaying("a", false);
  setCellReplaying("b", false);
  setCellReadout("a", false);
  setCellReadout("b", false);
});

describe("replayingCells", () => {
  it("readout is the wider fact: picking counts, without marking the cell as replaying", () => {
    // Folding picking into replayingCells would mute broadcasts and trip the
    // dealing gate for a session that has not started; the two sets exist so
    // the pattern panel can hide on the wider fact alone.
    setCellReadout("a", true);
    expect(anyCellInReadout()).toBe(true);
    expect(anyCellReplaying()).toBe(false);
  });

  it("notifies subscribers on membership changes of either set, not on no-ops", () => {
    let fired = 0;
    const off = subscribeReplayingCells(() => fired++);
    setCellReadout("a", true);
    setCellReadout("a", true); // already in: silence
    setCellReplaying("b", true);
    setCellReplaying("b", false);
    expect(fired).toBe(3);
    off();
    setCellReadout("a", false);
    expect(fired).toBe(3);
  });

  it("a cell's readout entry is released independently per cell", () => {
    setCellReadout("a", true);
    setCellReadout("b", true);
    setCellReadout("a", false);
    expect(anyCellInReadout()).toBe(true);
    setCellReadout("b", false);
    expect(anyCellInReadout()).toBe(false);
  });
});
