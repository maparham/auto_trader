// @vitest-environment jsdom
// The workspace-level pattern panel: nothing but its own ✕ may destroy the
// results. Cells mounting/unmounting (tab switches), series changes and replay
// sessions may at most HIDE it; the state survives them all.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import WorkspacePatternPanel from "./WorkspacePatternPanel";
import * as api from "./lib/patternSearch";
import {
  getPatternPanelState,
  resetPatternPanel,
  runPatternSearch,
  setPatternSeriesProvider,
} from "./lib/patternPanelStore";
import {
  clearPatternTargets,
  clearPendingPatternJumps,
  registerPatternTarget,
  setPendingPatternJump,
  takePendingPatternJump,
  type PatternTarget,
} from "./lib/patternTargets";

const mkBars = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    ts: 1_700_000_000 + i * 300, o: 10 + i, h: 11 + i, l: 9 + i, c: 10.5 + i,
  }));

const match = (over: Partial<api.PatternMatch> = {}): api.PatternMatch => ({
  ts: 1_600_000_000, endTs: 1_600_000_900, distance: 0.2, bars: mkBars(4),
  forward: [], forwardComplete: false, forwardPct: null, ...over,
});

const apiResult = (matches: api.PatternMatch[] = []): api.PatternSearchResult => ({
  matches, scanned: 100, series: { oldestTs: 1, newestTs: 2, bars: 80 },
  elapsedMs: 3, cold: false,
});

const SELF = { cellId: "cell-1", tabId: "tab-1", epic: "US100", resolution: "MINUTE_5", label: "5m" };

const target = (over: Partial<PatternTarget> = {}): PatternTarget => ({
  cellId: "cell-1", epic: "US100", resolution: "MINUTE_5", label: "5m",
  showMatch: vi.fn(), clearMatchBands: vi.fn(), clearSelectionBand: vi.fn(),
  ...over,
});

/** Drag a valid range so the store holds a result. */
const search = async () => {
  vi.spyOn(api, "searchPatterns").mockResolvedValue(apiResult([match()]));
  await act(async () => {
    runPatternSearch({
      origin: { cellId: "cell-1", epic: "US100", resolution: "MINUTE_5", label: "5m" },
      broker: "capital", priceSide: "bid",
      bars: mkBars(10),
      range: { fromMs: 1_700_000_000_000, toMs: 1_700_003_000_000 },
    });
  });
};

beforeEach(() => {
  vi.restoreAllMocks();
  resetPatternPanel();
  clearPatternTargets();
  clearPendingPatternJumps();
  setPatternSeriesProvider(() => [SELF]);
});

afterEach(cleanup);

describe("WorkspacePatternPanel", () => {
  it("renders nothing before any search", () => {
    const { container } = render(<WorkspacePatternPanel timezone="UTC" hidden={false} onReveal={() => true} />);
    expect(container.childElementCount).toBe(0);
  });

  it("shows the results panel once a search ran", async () => {
    render(<WorkspacePatternPanel timezone="UTC" hidden={false} onReveal={() => true} />);
    await search();
    expect(screen.getByText("Similarity search")).toBeTruthy();
  });

  it("survives every cell unmounting: the results belong to the workspace", async () => {
    // A tab switch unregisters every target (only the active tab's cells are
    // mounted). The panel — and the state under it — must not notice.
    const off = registerPatternTarget(target());
    render(<WorkspacePatternPanel timezone="UTC" hidden={false} onReveal={() => true} />);
    await search();
    act(() => off());
    expect(screen.getByText("Similarity search")).toBeTruthy();
    expect(getPatternPanelState().result).not.toBeNull();
  });

  it("hides — state intact — while App raises the replay gate, and returns after", async () => {
    const { rerender } = render(
      <WorkspacePatternPanel timezone="UTC" hidden={false} onReveal={() => true} />,
    );
    await search();
    // Hidden: its rows carry the real dates a masked session conceals.
    rerender(<WorkspacePatternPanel timezone="UTC" hidden={true} onReveal={() => true} />);
    expect(screen.queryByText("Similarity search")).toBeNull();
    expect(getPatternPanelState().result).not.toBeNull();
    rerender(<WorkspacePatternPanel timezone="UTC" hidden={false} onReveal={() => true} />);
    expect(screen.getByText("Similarity search")).toBeTruthy();
  });

  it("a row jump routes to the mounted cell showing the series and reveals it", async () => {
    const t = target();
    registerPatternTarget(t);
    const onReveal = vi.fn(() => true);
    render(<WorkspacePatternPanel timezone="UTC" hidden={false} onReveal={onReveal} />);
    await search();
    screen.getAllByRole("button", { name: /^Go to / })[0].click();
    expect(t.showMatch).toHaveBeenCalledTimes(1);
    expect(onReveal).toHaveBeenCalledWith("cell-1");
  });

  it("a jump with no mounted chart parks the match and asks App to reveal the cell", async () => {
    const onReveal = vi.fn(() => true);
    render(<WorkspacePatternPanel timezone="UTC" hidden={false} onReveal={onReveal} />);
    await search();
    screen.getAllByRole("button", { name: /^Go to / })[0].click();
    expect(onReveal).toHaveBeenCalledWith("cell-1");
    // The pending jump waits for the cell's mount to consume it.
    expect(takePendingPatternJump("cell-1")).toBeTruthy();
  });

  it("a jump whose cell left the workspace takes the parked match back", async () => {
    const onReveal = vi.fn(() => false);
    render(<WorkspacePatternPanel timezone="UTC" hidden={false} onReveal={onReveal} />);
    await search();
    screen.getAllByRole("button", { name: /^Go to / })[0].click();
    // Not left behind: a stale parked match would fire on an unrelated later
    // mount of a cell reusing the id.
    expect(takePendingPatternJump("cell-1")).toBeUndefined();
  });

  it("the ✕ destroys the results and clears every band the panel painted", async () => {
    const origin = target();
    const sibling = target({ cellId: "cell-2", epic: "GOLD", resolution: "MINUTE_15", label: "15m" });
    registerPatternTarget(origin);
    registerPatternTarget(sibling);
    setPendingPatternJump("cell-9", match());
    render(<WorkspacePatternPanel timezone="UTC" hidden={false} onReveal={() => true} />);
    await search();
    screen.getByRole("button", { name: "Close" }).click();
    expect(getPatternPanelState().result).toBeNull();
    // Match bands on every mounted cell a row jump may have painted...
    expect(origin.clearMatchBands).toHaveBeenCalled();
    expect(sibling.clearMatchBands).toHaveBeenCalled();
    // ...the selection band only on the cell showing the ORIGIN series...
    expect(origin.clearSelectionBand).toHaveBeenCalled();
    expect(sibling.clearSelectionBand).not.toHaveBeenCalled();
    // ...and any cross-tab jump still waiting for its cell.
    expect(takePendingPatternJump("cell-9")).toBeUndefined();
  });
});
