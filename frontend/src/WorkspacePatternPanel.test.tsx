// @vitest-environment jsdom
// The workspace-level pattern panel: nothing but its own ✕ may destroy the
// results. Cells mounting/unmounting (tab switches), series changes and replay
// sessions may at most HIDE it; the state survives them all.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import WorkspacePatternPanel from "./WorkspacePatternPanel";
import * as api from "./lib/patternSearch";
import * as presetApi from "./lib/presetScan";
import type { PresetFamily, PresetScanResult } from "./lib/presetScan";
import {
  closePatternPanel,
  getPatternPanelState,
  openPatternPanel,
  resetPatternPanel,
  runPatternSearch,
  setPatternSeriesProvider,
  setPatternView,
} from "./lib/patternPanelStore";
import {
  clearPatternTargets,
  clearPendingPatternJumps,
  registerPatternTarget,
  setPendingPatternJump,
  takePendingPatternJump,
  type PatternTarget,
} from "./lib/patternTargets";

vi.mock("./lib/presetScan", async () => {
  const actual = await vi.importActual<typeof import("./lib/presetScan")>("./lib/presetScan");
  return {
    ...actual,
    fetchFamilies: vi.fn(),
    runPresetScan: vi.fn(),
    listUserPresets: vi.fn(),
  };
});

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
    const { container } = render(<WorkspacePatternPanel timezone="UTC" hidden={false} onReveal={() => true} broker="capital" priceSide="bid" />);
    expect(container.childElementCount).toBe(0);
  });

  it("shows the results panel once a search ran", async () => {
    render(<WorkspacePatternPanel timezone="UTC" hidden={false} onReveal={() => true} broker="capital" priceSide="bid" />);
    await search();
    expect(screen.getByText("Similarity search")).toBeTruthy();
  });

  // `open` is the single source of visibility now: a drag-search must flip it
  // on (so the toolbar button lights and closePatternPanel actually works),
  // and closing genuinely hides the panel rather than the old gate falling
  // back to "a result exists" and ignoring the close.
  it("a drag-search opens the panel (open: true), and closePatternPanel actually hides it", async () => {
    render(<WorkspacePatternPanel timezone="UTC" hidden={false} onReveal={() => true} broker="capital" priceSide="bid" />);
    await search();
    expect(getPatternPanelState().open).toBe(true);
    expect(screen.getByText("Similarity search")).toBeTruthy();
    act(() => closePatternPanel());
    expect(screen.queryByText("Similarity search")).toBeNull();
    // The result itself survives the close — only dismiss destroys it.
    expect(getPatternPanelState().result).not.toBeNull();
  });

  it("survives every cell unmounting: the results belong to the workspace", async () => {
    // A tab switch unregisters every target (only the active tab's cells are
    // mounted). The panel — and the state under it — must not notice.
    const off = registerPatternTarget(target());
    render(<WorkspacePatternPanel timezone="UTC" hidden={false} onReveal={() => true} broker="capital" priceSide="bid" />);
    await search();
    act(() => off());
    expect(screen.getByText("Similarity search")).toBeTruthy();
    expect(getPatternPanelState().result).not.toBeNull();
  });

  it("hides — state intact — while App raises the replay gate, and returns after", async () => {
    const { rerender } = render(
      <WorkspacePatternPanel timezone="UTC" hidden={false} onReveal={() => true} broker="capital" priceSide="bid" />,
    );
    await search();
    // Hidden: its rows carry the real dates a masked session conceals.
    rerender(<WorkspacePatternPanel timezone="UTC" hidden={true} onReveal={() => true} broker="capital" priceSide="bid" />);
    expect(screen.queryByText("Similarity search")).toBeNull();
    expect(getPatternPanelState().result).not.toBeNull();
    rerender(<WorkspacePatternPanel timezone="UTC" hidden={false} onReveal={() => true} broker="capital" priceSide="bid" />);
    expect(screen.getByText("Similarity search")).toBeTruthy();
  });

  it("a row jump routes to the mounted cell showing the series and reveals it", async () => {
    const t = target();
    registerPatternTarget(t);
    const onReveal = vi.fn(() => true);
    render(<WorkspacePatternPanel timezone="UTC" hidden={false} onReveal={onReveal} broker="capital" priceSide="bid" />);
    await search();
    screen.getAllByRole("button", { name: /^Go to / })[0].click();
    expect(t.showMatch).toHaveBeenCalledTimes(1);
    expect(onReveal).toHaveBeenCalledWith("cell-1");
  });

  it("a jump with no mounted chart parks the match and asks App to reveal the cell", async () => {
    const onReveal = vi.fn(() => true);
    render(<WorkspacePatternPanel timezone="UTC" hidden={false} onReveal={onReveal} broker="capital" priceSide="bid" />);
    await search();
    screen.getAllByRole("button", { name: /^Go to / })[0].click();
    expect(onReveal).toHaveBeenCalledWith("cell-1");
    // The pending jump waits for the cell's mount to consume it.
    expect(takePendingPatternJump("cell-1")).toBeTruthy();
  });

  it("a jump whose cell left the workspace takes the parked match back", async () => {
    const onReveal = vi.fn(() => false);
    render(<WorkspacePatternPanel timezone="UTC" hidden={false} onReveal={onReveal} broker="capital" priceSide="bid" />);
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
    render(<WorkspacePatternPanel timezone="UTC" hidden={false} onReveal={() => true} broker="capital" priceSide="bid" />);
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

  // Regression: "preset scan failed (422)" whenever no Similar search had run
  // yet this session. runPresetScanNow used to be fed store.broker/priceSide
  // (only seeded by a completed Similar search, "" until then) instead of
  // App's live values, so the backend's price_side (pattern bid|mid|ask) 422'd
  // on "". broker/priceSide "ig"/"ask" here can't pass by accident against the
  // store's unseeded "" default, unlike "capital"/"bid" used elsewhere.
  it("Scan open charts uses the live broker/priceSide props, not the unseeded store fields", async () => {
    const families: PresetFamily[] = [
      { family: "hns", title: "Head & shoulders", params: [] },
    ];
    vi.mocked(presetApi.fetchFamilies).mockResolvedValue(families);
    vi.mocked(presetApi.listUserPresets).mockResolvedValue([]);
    vi.mocked(presetApi.runPresetScan).mockResolvedValue(
      { charts: [], elapsedMs: 1 } as PresetScanResult,
    );

    render(
      <WorkspacePatternPanel
        timezone="UTC"
        hidden={false}
        onReveal={() => true}
        broker="ig"
        priceSide="ask"
      />,
    );
    // No Similar search ran this session — the store's own broker/priceSide
    // fields are still their unseeded "" defaults.
    expect(getPatternPanelState().broker).toBe("");
    expect(getPatternPanelState().priceSide).toBe("");

    act(() => openPatternPanel());
    act(() => setPatternView("presets"));
    await waitFor(() => expect(getPatternPanelState().families).not.toBeNull());

    fireEvent.click(screen.getByText("Head & shoulders").closest("button")!);
    fireEvent.click(screen.getByRole("button", { name: /scan open charts/i }));

    await waitFor(() => expect(presetApi.runPresetScan).toHaveBeenCalled());
    const req = vi.mocked(presetApi.runPresetScan).mock.calls[0][0];
    expect(req.broker).toBe("ig");
    expect(req.priceSide).toBe("ask");
  });
});
