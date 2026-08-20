// @vitest-environment jsdom
//
// This popover labels bars that are ON SCREEN, so on a blind session it would
// otherwise print the exact date the session hides. The mask was live but
// unpinned: deleting its useBarTimeLabel() call left the whole suite green.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import TradeExitClusterPopover from "./TradeExitClusterPopover";
import { liveExitClusterHoverSignal } from "./lib/signals";
import { armMaskedReplay, maskedReplaySignal } from "./lib/maskedReplay";
import type { JournalTrade } from "./lib/liveJournal";

const EXIT_MS = Date.UTC(2026, 6, 13, 15, 30); // Mon 2026-07-13 15:30 UTC
const ANCHOR = Date.UTC(2026, 6, 10, 9, 30); // three calendar days earlier

const exit: JournalTrade = {
  ts: EXIT_MS / 1000,
  epic: "US100",
  leg: "long",
  entry: 100,
  exit: 110,
  quantity: 1,
  pnl: 10,
};

const hover = () => liveExitClusterHoverSignal.set({ exits: [exit], x: 20, y: 20 });

beforeEach(() => {
  maskedReplaySignal.set({});
  liveExitClusterHoverSignal.set(null);
});

afterEach(() => {
  cleanup();
  maskedReplaySignal.set({});
  liveExitClusterHoverSignal.set(null);
});

const timeCell = () => document.querySelector(".bt-cluster-pop-time")?.textContent ?? "";

describe("the live exit-cluster popover during a masked replay", () => {
  it("shows a real date when nothing is masked", () => {
    hover();
    render(<TradeExitClusterPopover />);
    expect(timeCell()).toMatch(/2026|Jul/);
  });

  // The any-cell read, on purpose: this popover is portaled at app level and
  // cannot tell which cell's bar the cursor is over, so it fails closed.
  it("relabels the bar time while any cell is masked", () => {
    maskedReplaySignal.set(
      armMaskedReplay(maskedReplaySignal.value, {
        cellId: "cell-a",
        startMs: ANCHOR,
        clock: "24h",
        timezone: "UTC",
      }),
    );
    hover();
    render(<TradeExitClusterPopover />);
    expect(timeCell()).toBe("Day 4 15:30");
    expect(timeCell()).not.toMatch(/2026|Jul|07/);
  });

  // Two masked cells: no anchor is correct for a popover that cannot say which
  // cell it is describing, so the day number is withheld rather than guessed.
  it("withholds the day number when two cells are masked", () => {
    let reg = armMaskedReplay(maskedReplaySignal.value, {
      cellId: "cell-a", startMs: ANCHOR, clock: "24h", timezone: "UTC",
    });
    reg = armMaskedReplay(reg, {
      cellId: "cell-b", startMs: ANCHOR - 5 * 86_400_000, clock: "24h", timezone: "UTC",
    });
    maskedReplaySignal.set(reg);
    hover();
    render(<TradeExitClusterPopover />);
    expect(timeCell()).toBe("Day ? 15:30");
  });

  it("renders nothing when the cursor is not over a cluster", () => {
    render(<TradeExitClusterPopover />);
    expect(screen.queryByText(/Long/)).toBeNull();
  });
});
