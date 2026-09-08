// @vitest-environment jsdom
// The panel host: a Similar/Presets switcher over one workspace-level pattern
// search. The switcher must not drop the Similar result when the user peeks
// at Presets and comes back — the store, not this component, owns the result.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import PatternPanel from "./PatternPanel";
import * as api from "./lib/patternSearch";
import {
  getPatternPanelState,
  resetPatternPanel,
  runPatternSearch,
  setPatternArmProvider,
  setPatternSeriesProvider,
  subscribePatternPanel,
} from "./lib/patternPanelStore";

vi.mock("./lib/notify", () => ({ toast: vi.fn() }));

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

const props = {
  timezone: "UTC",
  onReveal: () => true,
  epic: "US100",
  resolution: "MINUTE_5",
  broker: "capital",
  priceSide: "bid",
  liveBroker: "capital",
  livePriceSide: "bid",
  mode: "shape" as const,
  onModeChange: vi.fn(),
  forwardBars: 20,
  onForwardBarsChange: vi.fn(),
  scope: "all" as const,
  onScopeChange: vi.fn(),
  onCopy: vi.fn(),
  onJump: vi.fn(),
  onDismiss: vi.fn(),
};

/** Drags a valid range so the store holds a Similar result. */
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

/** Thin store-reactive wrapper, mirroring how WorkspacePatternPanel feeds
 *  live store state into PatternPanel as props (a static prop would go stale
 *  the moment the store changes underneath it). */
function Host() {
  const st = useSyncExternalStore(subscribePatternPanel, getPatternPanelState);
  return (
    <PatternPanel
      {...props}
      result={st.result}
      loading={st.loading}
      error={st.error}
      truncatedTo={st.truncatedTo}
    />
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetPatternPanel();
  setPatternSeriesProvider(() => [SELF]);
});

afterEach(cleanup);

describe("PatternPanel", () => {
  it("switches views without dropping the Similar result", async () => {
    render(<Host />);
    await search();
    expect(getPatternPanelState().result).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Presets" }));
    expect(screen.queryByText("Similarity search")).toBeNull();
    // The result is untouched underneath — switching back proves it.
    expect(getPatternPanelState().result).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Similar" }));
    expect(screen.getByText("Similarity search")).toBeTruthy();
  });

  it("the select-range button calls the registered arm provider", () => {
    const arm = vi.fn();
    setPatternArmProvider(arm);
    render(<PatternPanel {...props} result={null} loading={false} error={null} truncatedTo={null} />);
    screen.getByText("Select range on chart").click();
    expect(arm).toHaveBeenCalledOnce();
  });

  it("save-as-preset is disabled without a result", () => {
    render(<PatternPanel {...props} result={null} loading={false} error={null} truncatedTo={null} />);
    const btn = screen.getByRole("button", { name: "Save as preset" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("save-as-preset is enabled once a similarity run exists", async () => {
    render(<PatternPanel {...props} result={null} loading={false} error={null} truncatedTo={null} />);
    await search();
    const btn = screen.getByRole("button", { name: "Save as preset" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it("has a panel-level close distinct from the Similar view's dismiss", async () => {
    render(<PatternPanel {...props} result={null} loading={false} error={null} truncatedTo={null} />);
    await search();
    // Two distinct close controls must coexist: the panel's own, and the
    // Similar view's (which clears the result via onDismiss).
    expect(screen.getByRole("button", { name: "Close panel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });
});
