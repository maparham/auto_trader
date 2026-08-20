// @vitest-environment jsdom
//
// A drawing placed during a masked session is anchored to REPLAYED bars, so its
// Coordinates tab prints the hidden period's dates. The mask was live but
// unpinned: deleting its useMaskedReplay() call left the whole suite green.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import DrawingSettings from "./DrawingSettings";
import { armMaskedReplay, maskedReplaySignal } from "./lib/maskedReplay";
import type { OverlayManager } from "./lib/overlays";

const POINT_MS = Date.UTC(2026, 6, 13, 15, 30); // Mon 2026-07-13 15:30 UTC
const ANCHOR = Date.UTC(2026, 6, 10, 9, 30); // three calendar days earlier

// Only what the Coordinates tab reads. Everything else on the manager is
// unreachable from this test, so a partial cast is honest here.
const overlays = {
  getDrawing: () => ({
    name: "segment",
    points: [{ timestamp: POINT_MS, value: 100, dataIndex: 4 }],
    styles: { line: { color: "#2962ff", size: 1, style: "solid" } },
    lock: false,
    visible: true,
    zLevel: 0,
    extendData: {},
  }),
  setStyle: () => {},
  setPoint: () => {},
} as unknown as OverlayManager;

const openCoords = () => {
  render(
    <DrawingSettings overlays={overlays} id="draw-1" onIdChange={() => {}} onClose={() => {}} />,
  );
  fireEvent.click(screen.getByText("Coordinates"));
  return document.querySelector(".ind-coord-date")?.textContent ?? "";
};

beforeEach(() => maskedReplaySignal.set({}));
afterEach(() => {
  cleanup();
  maskedReplaySignal.set({});
});

describe("the drawing Coordinates tab during a masked replay", () => {
  it("shows a real date when nothing is masked", () => {
    expect(openCoords()).toMatch(/2026|Jul/);
  });

  // The any-cell read, on purpose: this modal is opened at app level and cannot
  // tell which cell drew the overlay, so it fails closed.
  it("relabels the anchor while any cell is masked", () => {
    maskedReplaySignal.set(
      armMaskedReplay(maskedReplaySignal.value, {
        cellId: "cell-a",
        startMs: ANCHOR,
        clock: "24h",
        timezone: "UTC",
      }),
    );
    const shown = openCoords();
    expect(shown).toBe("Day 4 15:30");
    expect(shown).not.toMatch(/2026|Jul|07/);
  });

  it("withholds the day number when two cells are masked", () => {
    let reg = armMaskedReplay(maskedReplaySignal.value, {
      cellId: "cell-a", startMs: ANCHOR, clock: "24h", timezone: "UTC",
    });
    reg = armMaskedReplay(reg, {
      cellId: "cell-b", startMs: ANCHOR - 5 * 86_400_000, clock: "24h", timezone: "UTC",
    });
    maskedReplaySignal.set(reg);
    expect(openCoords()).toBe("Day ? 15:30");
  });
});
