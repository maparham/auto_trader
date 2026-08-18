// @vitest-environment jsdom
//
// The PREV_HL anchor field's replay masking, and specifically WHICH cell's
// session it reads.
//
// Masking a bar timestamp fail-closed (any cell on screen) is right for a
// LABEL — over-masking prints "Day 3 09:30" where a real date would have done,
// which costs nothing. This field is not a label: while masked it swaps a
// working datetime editor for a read-only span and a "exit replay to edit"
// tooltip. Read any-cell, that is a functional lockout of an editor on a chart
// that is not replaying, with no session for the user to exit.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PrevHlInputsPanel } from "./PrevHlPanels";
import { maskedReplaySignal } from "../lib/maskedReplay";
import type { LineDraft, PrevHlKind } from "./shared";
import type { PrevHlAgg } from "../lib/customIndicators";

afterEach(() => {
  cleanup();
  maskedReplaySignal.set({});
});

const ANCHOR_TS = Date.UTC(2026, 2, 2, 12, 30);

const LINES: LineDraft[] = [
  { key: "anchorHigh", label: "Anchor High", visible: true } as unknown as LineDraft,
  { key: "anchorLow", label: "Anchor Low", visible: true } as unknown as LineDraft,
];

const zeros = <T,>(v: T) =>
  ({ day: v, week: v, month: v, quarter: v, year: v, rolling: v, anchor: v }) as Record<PrevHlKind, T>;

function renderPanel(cellId: string) {
  render(
    <PrevHlInputsPanel
      cellId={cellId}
      lines={LINES}
      prevHlLengths={zeros(1)}
      prevHlAggs={zeros("extreme" as PrevHlAgg)}
      prevHlRollingUnit="hour"
      prevHlAnchorTs={ANCHOR_TS}
      prevHlTz="chart"
      setBoundaryVisible={() => {}}
      setPrevHlLength={() => {}}
      setPrevHlRolling={() => {}}
      setPrevHlAgg={() => {}}
      setPrevHlAnchorInput={() => {}}
    />,
  );
}

/** The editable field is a datetime-local input; the masked form is a span. */
const anchorInput = () => document.querySelector("input.ind-anchor-input");
const maskedSpan = () => document.querySelector("span.ind-anchor-masked");

const armCell = (cellId: string) =>
  maskedReplaySignal.set({
    [cellId]: { cellId, startMs: ANCHOR_TS - 86_400_000, clock: "24h", timezone: "UTC" },
  });

describe("the PREV_HL anchor field during a masked replay", () => {
  it("is editable when no session is running anywhere", () => {
    renderPanel("cell-A");
    expect(anchorInput()).not.toBeNull();
    expect(maskedSpan()).toBeNull();
  });

  it("is masked and read-only while THIS cell replays", () => {
    armCell("cell-A");
    renderPanel("cell-A");
    expect(anchorInput()).toBeNull();
    expect(maskedSpan()).not.toBeNull();
    // The real date must not be anywhere in the panel.
    expect(screen.queryByDisplayValue(/2026-03-02/)).toBeNull();
  });

  it("stays editable while a SIBLING cell replays", () => {
    // The bug: a session on cell A locked the anchor editor on cell B, which has
    // no session and therefore no way to unlock it.
    armCell("cell-A");
    renderPanel("cell-B");
    expect(anchorInput()).not.toBeNull();
    expect(maskedSpan()).toBeNull();
  });

  it("masks each cell independently when two sessions run at once", () => {
    maskedReplaySignal.set({
      "cell-A": { cellId: "cell-A", startMs: ANCHOR_TS, clock: "24h", timezone: "UTC" },
      "cell-B": { cellId: "cell-B", startMs: ANCHOR_TS, clock: "24h", timezone: "UTC" },
    });
    renderPanel("cell-B");
    expect(maskedSpan()).not.toBeNull();
    cleanup();
    renderPanel("cell-C");
    expect(anchorInput()).not.toBeNull();
  });
});
