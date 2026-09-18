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

// The legend group header's copy button: every member's live config in ONE
// clipboard payload (items list), so paste recreates the whole group.
describe("group copy", () => {
  const ema = (name: string, period: number) => ({
    name,
    paneId: "candle_pane",
    shortName: "EMA",
    calcParams: [period],
    visible: true,
    styles: { lines: [{ color: "#fff", size: 1 }] },
    extendData: { indType: "EMA" },
  });
  const chart = () => {
    const inds = [ema("EMA", 50), ema("EMA2", 200)];
    return {
      getIndicators: (f?: { paneId?: string; name?: string }) =>
        f ? inds.filter((i) => i.paneId === f.paneId && i.name === f.name) : inds,
    } as unknown as NonNullable<ChartHandle["chartRef"]["current"]>;
  };
  const groupCommands = () => {
    const handle = makeHandle();
    (handle.chartRef as { current: unknown }).current = chart();
    return renderHook(() => useIndicatorCommands(handle, DEPS)).result.current;
  };

  it("writes one payload carrying every member's type and config", () => {
    groupCommands().copyIndicatorGroup(["EMA", "EMA2"]);
    expect(writeText).toHaveBeenCalledOnce();
    const payload = JSON.parse(writeText.mock.calls[0][0]);
    expect(payload.__autoTraderIndicator).toBe(1);
    expect(payload.items.map((it: { type: string }) => it.type)).toEqual(["EMA", "EMA"]);
    expect(payload.items.map((it: { config: { calcParams: number[] } }) => it.config.calcParams)).toEqual([
      [50],
      [200],
    ]);
  });

  it("writes nothing while this cell is masked", () => {
    arm();
    groupCommands().copyIndicatorGroup(["EMA", "EMA2"]);
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("indicator copy carries settings, not computed state", () => {
  // A Trendlines pinned to a higher timeframe holds the coordinator's stash on
  // extendData.mtf: the SOURCE chart's HTF bars, lines and pivots. Copying
  // that verbatim made a paste onto another symbol draw the source's lines.
  const tl = {
    name: "TRENDLINES",
    paneId: "candle_pane",
    shortName: "Trendlines",
    calcParams: [5, 0, 2],
    visible: true,
    styles: undefined,
    extendData: {
      indType: "TRENDLINES",
      extend: "segment",
      tlFloorTs: DRAWING_TS,
      mtf: {
        timeframe: "1D",
        waitClose: true,
        htfStarts: [DRAWING_TS],
        htfMs: 86_400_000,
        htfLines: [{ i1: 0, i2: 1 }],
        htfPivots: { highs: [1], lows: [0] },
        htfPoints: [{}],
        coveredFromMs: DRAWING_TS,
      },
    },
  };
  const tlCommands = () => {
    const handle = makeHandle();
    (handle.chartRef as { current: unknown }).current = {
      getIndicators: () => [tl],
    };
    return renderHook(() => useIndicatorCommands(handle, DEPS)).result.current;
  };

  it("keeps the timeframe pin and drawing options, drops the stash and floor", () => {
    tlCommands().copyIndicator("candle_pane", "TRENDLINES");
    const payload = JSON.parse(writeText.mock.calls[0][0]);
    expect(payload.config.extendData).toEqual({
      indType: "TRENDLINES",
      extend: "segment",
      mtf: { timeframe: "1D", waitClose: true },
    });
    // The live instance is untouched.
    expect(tl.extendData.mtf.htfLines).toHaveLength(1);
    expect(tl.extendData.tlFloorTs).toBe(DRAWING_TS);
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
