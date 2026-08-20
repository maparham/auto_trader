// @vitest-environment jsdom
//
// The system clipboard is a real disclosure channel: paste into any text editor
// and the JSON is there in full. On a blind replay cell both copy commands used
// to write real epochs into it — a drawing's points ARE bar timestamps, and an
// indicator's config can hold one (PREV_HL's anchor, the same field the settings
// panel masks).
//
// Driven through the hook rather than a pure seam, because the defect was never
// in a formatter: it was two commands that simply never asked whether the cell
// was masked. Only a caller-level test catches that.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { installMemStorage } from "../lib/testMemStorage";
import type { ChartHandle } from "./chartHandle";

installMemStorage();

const { useIndicatorCommands } = await import("./useIndicatorCommands");
const { armMaskedReplay, disarmMaskedReplay, maskedReplaySignal } = await import(
  "../lib/maskedReplay"
);

const CELL = "cell-a";
const DRAWING_TS = Date.UTC(2026, 6, 10, 9, 30);

const writeText = vi.fn((_text: string) => Promise.resolve());
const toasts: string[] = [];
vi.mock("../lib/notify", () => ({ toast: (m: string) => void toasts.push(m) }));

// Only what the two copy commands touch. Everything else on the handle is
// unreachable from this test, so a partial cast is honest here.
function makeHandle() {
  return {
    chartRef: { current: null },
    epicRef: { current: "US100" },
    redrawRef: { current: () => {} },
    overlays: {
      getSelectedDrawingId: () => "draw-1",
      getDrawing: () => ({
        name: "trendline",
        points: [{ timestamp: DRAWING_TS, value: 100, dataIndex: 4 }],
        styles: null,
        lock: false,
        visible: true,
        zLevel: 0,
        extendData: {},
      }),
    },
    controller: {
      selectedIndicator: { value: null, set: () => {}, subscribe: () => () => {} },
      indicatorRemoved: { value: null, set: () => {}, subscribe: () => () => {} },
      indicators: { value: [], set: () => {}, subscribe: () => () => {} },
      indicatorsHidden: { value: false, set: () => {}, subscribe: () => () => {} },
      subPanesHidden: { value: false, set: () => {}, subscribe: () => () => {} },
    },
  } as unknown as ChartHandle;
}

const DEPS = {
  cellId: CELL,
  scope: "tab.test",
  period: { resolution: "MINUTE_15" },
  snapViewRef: { current: false },
  wrapRef: { current: null },
  setPaneDropTop: () => {},
  setIndMenu: () => {},
};

const arm = () =>
  maskedReplaySignal.set(
    armMaskedReplay(maskedReplaySignal.value, {
      cellId: CELL,
      startMs: DRAWING_TS,
      clock: "24h",
      timezone: "UTC",
    }),
  );

beforeEach(() => {
  toasts.length = 0;
  writeText.mockClear();
  maskedReplaySignal.set({});
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

afterEach(() => maskedReplaySignal.set({}));

const commands = () =>
  renderHook(() => useIndicatorCommands(makeHandle(), DEPS)).result.current;

describe("drawing copy on a blind replay cell", () => {
  it("writes the drawing to the clipboard when nothing is masked", () => {
    expect(commands().copySelectedDrawing()).toBe(true);
    expect(writeText).toHaveBeenCalledOnce();
    // The very thing that must not escape while a session is running.
    expect(writeText.mock.calls[0][0]).toContain(String(DRAWING_TS));
  });

  it("writes nothing while this cell is masked", () => {
    arm();
    commands().copySelectedDrawing();
    expect(writeText).not.toHaveBeenCalled();
  });

  // Returning true is what stops the key press falling through to the browser's
  // own copy, which would put the page selection on the clipboard instead.
  it("still claims the key press so the browser does not copy the page", () => {
    arm();
    expect(commands().copySelectedDrawing()).toBe(true);
  });

  it("says why, rather than failing silently", () => {
    arm();
    commands().copySelectedDrawing();
    expect(toasts.at(-1)).toMatch(/replay/i);
  });

  // Per-cell: a session on a sibling is no reason to stop copying from a live
  // chart, and the any-cell read would have withdrawn the command everywhere.
  it("is unaffected by a masked session on another cell", () => {
    maskedReplaySignal.set(
      armMaskedReplay(maskedReplaySignal.value, {
        cellId: "cell-elsewhere",
        startMs: DRAWING_TS,
        clock: "24h",
        timezone: "UTC",
      }),
    );
    expect(commands().copySelectedDrawing()).toBe(true);
    expect(writeText).toHaveBeenCalledOnce();
  });

  it("copies again once the session ends", () => {
    arm();
    commands().copySelectedDrawing();
    expect(writeText).not.toHaveBeenCalled();
    maskedReplaySignal.set(disarmMaskedReplay(maskedReplaySignal.value, CELL));
    expect(commands().copySelectedDrawing()).toBe(true);
    expect(writeText).toHaveBeenCalledOnce();
  });
});

describe("indicator copy on a blind replay cell", () => {
  // An indicator config can carry a bar timestamp of its own (PREV_HL's anchor),
  // so it goes through the same gate.
  it("writes nothing and says why while this cell is masked", () => {
    arm();
    commands().copyIndicator("candle_pane", "PREV_HL");
    expect(writeText).not.toHaveBeenCalled();
    expect(toasts.at(-1)).toMatch(/replay/i);
  });
});
