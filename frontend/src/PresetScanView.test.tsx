// @vitest-environment jsdom
// The Presets half of the pattern panel: family cards, per-family param
// overrides, the scan button, and grouped results. Store-backed like
// PatternMatchesPanel, but its own component test suite (PatternPanel just
// hosts the Similar/Presets switcher).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import PresetScanView from "./PresetScanView";
import * as workspacePanel from "./WorkspacePatternPanel";
import {
  getPatternPanelState,
  resetPatternPanel,
  setPatternSeriesProvider,
} from "./lib/patternPanelStore";
import * as store from "./lib/patternPanelStore";
import * as presetApi from "./lib/presetScan";
import type { PresetFamily, PresetScanResult, UserPreset } from "./lib/presetScan";

vi.mock("./lib/notify", () => ({ toast: vi.fn() }));
vi.mock("./lib/presetScan", () => ({
  fetchFamilies: vi.fn(),
  runPresetScan: vi.fn(),
  listUserPresets: vi.fn(),
  createUserPreset: vi.fn(),
  renameUserPreset: vi.fn(),
  deleteUserPreset: vi.fn(),
}));
vi.mock("./WorkspacePatternPanel", () => ({
  default: () => null,
  jumpToMatch: vi.fn(),
}));

const mkBars = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    ts: 1_700_000_000 + i * 300, o: 10 + i, h: 11 + i, l: 9 + i, c: 10.5 + i,
  }));

const SELF = { cellId: "cell-1", tabId: "tab-1", epic: "US100", resolution: "MINUTE_5", label: "5m" };

const FAMILIES: PresetFamily[] = [
  {
    family: "hns",
    title: "Head & shoulders",
    params: [
      { name: "k", type: "float", min: 0.5, max: 6, default: 2, help: "pivot sensitivity" },
      { name: "strictness", type: "float", min: 0.2, max: 3, default: 1.6, help: "max distance" },
      { name: "min_bars", type: "int", min: 10, max: 5000, default: 20, help: "shortest instance" },
    ],
  },
  {
    family: "double",
    title: "Double top/bottom",
    params: [
      { name: "strictness", type: "float", min: 0.2, max: 3, default: 1.6, help: "max distance" },
      { name: "peak_tol", type: "float", min: 0.02, max: 0.5, default: 0.15, help: "peak tolerance" },
    ],
  },
];

const USER_PRESETS: UserPreset[] = [
  { id: "up1", name: "My preset", epic: "US100", resolution: "MINUTE_5", bars: mkBars(6), created_at: 1 },
];

const hit = (over: Partial<presetApi.PresetHit> = {}): presetApi.PresetHit => ({
  family: "hns", variant: "top", forming: false,
  ts: 1_600_000_000, endTs: 1_600_003_000, distance: 0.42, direction: -1,
  breakoutUpPct: null, target: null, tell: null, source: "Bulkowski", bars: mkBars(5),
  ...over,
});

const presetResult = (charts: presetApi.PresetChartResult[]): PresetScanResult => ({
  charts, elapsedMs: 12,
});

const props = { broker: "capital", priceSide: "bid", timezone: "UTC", onReveal: vi.fn(() => true) };

beforeEach(() => {
  vi.mocked(presetApi.fetchFamilies).mockReset().mockResolvedValue(FAMILIES);
  vi.mocked(presetApi.listUserPresets).mockReset().mockResolvedValue(USER_PRESETS);
  vi.mocked(presetApi.runPresetScan).mockReset().mockResolvedValue(presetResult([]));
  vi.mocked(presetApi.renameUserPreset).mockReset().mockResolvedValue(undefined);
  vi.mocked(presetApi.deleteUserPreset).mockReset().mockResolvedValue(undefined);
  vi.mocked(workspacePanel.jumpToMatch).mockReset();
  resetPatternPanel();
  setPatternSeriesProvider(() => [SELF]);
});

afterEach(cleanup);

async function renderReady() {
  const view = render(<PresetScanView {...props} />);
  await waitFor(() => expect(getPatternPanelState().families).not.toBeNull());
  await waitFor(() => expect(getPatternPanelState().userPresets).not.toBeNull());
  return view;
}

describe("PresetScanView", () => {
  it("fetches the families manifest and user presets on mount", async () => {
    await renderReady();
    expect(presetApi.fetchFamilies).toHaveBeenCalled();
    expect(presetApi.listUserPresets).toHaveBeenCalled();
    expect(screen.getByText("Head & shoulders")).toBeTruthy();
    expect(screen.getByText("Double top/bottom")).toBeTruthy();
    expect(screen.getByText("My preset")).toBeTruthy();
  });

  it("clicking a family card toggles selection in the store", async () => {
    await renderReady();
    const card = screen.getByText("Head & shoulders").closest("button")!;
    expect(getPatternPanelState().selectedFamilies).not.toContain("hns");
    fireEvent.click(card);
    expect(getPatternPanelState().selectedFamilies).toContain("hns");
    expect(card.className).toMatch(/selected/);
    fireEvent.click(card);
    expect(getPatternPanelState().selectedFamilies).not.toContain("hns");
  });

  it("shows params for a selected family: strictness always visible, others under Advanced", async () => {
    await renderReady();
    fireEvent.click(screen.getByText("Head & shoulders").closest("button")!);
    // Strictness is always visible (not just inside <details>).
    expect(screen.getByLabelText(/^strictness$/i)).toBeTruthy();
    const advanced = screen.getByText("Advanced").closest("details")!;
    // k and min_bars are the non-strictness schema params, tucked under Advanced.
    const kInput = within(advanced).getByLabelText(/^k$/i) as HTMLInputElement;
    expect(kInput.value).toBe("2");
    expect(within(advanced).getByLabelText(/^min_bars$/i)).toBeTruthy();
  });

  it("editing a param writes through setFamilyParam", async () => {
    await renderReady();
    fireEvent.click(screen.getByText("Head & shoulders").closest("button")!);
    const strictness = screen.getByLabelText(/^strictness$/i) as HTMLInputElement;
    fireEvent.change(strictness, { target: { value: "2.4" } });
    expect(getPatternPanelState().paramsByFamily.hns?.strictness).toBe(2.4);
  });

  it("Scan button is disabled with no families selected", async () => {
    await renderReady();
    const btn = screen.getByRole("button", { name: /scan open charts/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("Scan button is disabled with an empty chart list even with a family selected", async () => {
    setPatternSeriesProvider(() => []);
    await renderReady();
    fireEvent.click(screen.getByText("Head & shoulders").closest("button")!);
    const btn = screen.getByRole("button", { name: /scan open charts/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("Scan button runs the scan and reads Scanning… while loading", async () => {
    await renderReady();
    fireEvent.click(screen.getByText("Head & shoulders").closest("button")!);
    let resolveScan: (v: PresetScanResult) => void = () => {};
    vi.mocked(presetApi.runPresetScan).mockReturnValue(
      new Promise((res) => { resolveScan = res; }),
    );
    const btn = screen.getByRole("button", { name: /scan open charts/i }) as HTMLButtonElement;
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByRole("button", { name: /scanning/i })).toBeTruthy());
    expect((screen.getByRole("button", { name: /scanning/i }) as HTMLButtonElement).disabled).toBe(true);
    resolveScan(presetResult([]));
    await waitFor(() => expect(getPatternPanelState().presetLoading).toBe(false));
  });

  it("renders results grouped by chart, forming badge first, and a no-history warning line", async () => {
    await renderReady();
    const charts: presetApi.PresetChartResult[] = [
      {
        epic: "US100", resolution: "MINUTE_5", status: "ok", error: null,
        hits: [hit({ forming: true, variant: "inverse" }), hit({ forming: false, variant: "top" })],
      },
      { epic: "GOLD", resolution: "MINUTE_15", status: "no-history", error: null, hits: [] },
    ];
    fireEvent.click(screen.getByText("Head & shoulders").closest("button")!);
    vi.mocked(presetApi.runPresetScan).mockResolvedValue(presetResult(charts));
    fireEvent.click(screen.getByRole("button", { name: /scan open charts/i }));
    await waitFor(() => expect(getPatternPanelState().presetResult).not.toBeNull());

    expect(screen.getByText(/US100 · MINUTE_5 \(2\)/)).toBeTruthy();
    expect(screen.getByText(/GOLD · MINUTE_15 \(0\)/)).toBeTruthy();
    expect(screen.getByText(/no stored history/i)).toBeTruthy();

    const badges = screen.getAllByText(/forming|done/i);
    expect(badges[0].textContent).toMatch(/forming/i);
    expect(badges[1].textContent).toMatch(/done/i);
  });

  it("shows the source citation for a stats row without a tell (breakoutUpPct only)", async () => {
    await renderReady();
    const charts: presetApi.PresetChartResult[] = [
      {
        epic: "US100", resolution: "MINUTE_5", status: "ok", error: null,
        hits: [hit({ breakoutUpPct: 12, tell: null, source: "Bulkowski" })],
      },
    ];
    fireEvent.click(screen.getByText("Head & shoulders").closest("button")!);
    vi.mocked(presetApi.runPresetScan).mockResolvedValue(presetResult(charts));
    fireEvent.click(screen.getByRole("button", { name: /scan open charts/i }));
    await waitFor(() => expect(getPatternPanelState().presetResult).not.toBeNull());

    expect(screen.getByRole("button", { name: /about source/i })).toBeTruthy();
  });

  it("shows no source citation when a row has neither breakoutUpPct nor a tell", async () => {
    await renderReady();
    const charts: presetApi.PresetChartResult[] = [
      {
        epic: "US100", resolution: "MINUTE_5", status: "ok", error: null,
        hits: [hit({ breakoutUpPct: null, tell: null })],
      },
    ];
    fireEvent.click(screen.getByText("Head & shoulders").closest("button")!);
    vi.mocked(presetApi.runPresetScan).mockResolvedValue(presetResult(charts));
    fireEvent.click(screen.getByRole("button", { name: /scan open charts/i }));
    await waitFor(() => expect(getPatternPanelState().presetResult).not.toBeNull());

    expect(screen.queryByRole("button", { name: /about source/i })).toBeNull();
  });

  it("clicking a hit row jumps via jumpToMatch", async () => {
    await renderReady();
    const charts: presetApi.PresetChartResult[] = [
      { epic: "US100", resolution: "MINUTE_5", status: "ok", error: null, hits: [hit()] },
    ];
    fireEvent.click(screen.getByText("Head & shoulders").closest("button")!);
    vi.mocked(presetApi.runPresetScan).mockResolvedValue(presetResult(charts));
    fireEvent.click(screen.getByRole("button", { name: /scan open charts/i }));
    await waitFor(() => expect(getPatternPanelState().presetResult).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: /go to top match/i }));
    expect(workspacePanel.jumpToMatch).toHaveBeenCalledTimes(1);
    const [match] = vi.mocked(workspacePanel.jumpToMatch).mock.calls[0];
    expect(match.ts).toBe(1_600_000_000);
    // The hit's series (US100 MINUTE_5) is the mounted SELF cell — the source
    // resolves to its REAL identity, not a placeholder cellId.
    expect(match.source).toEqual(SELF);
  });

  it("row selection is sticky: marked on click, survives unmount/remount, cleared by a rescan", async () => {
    const { unmount } = await renderReady();
    const charts: presetApi.PresetChartResult[] = [
      { epic: "US100", resolution: "MINUTE_5", status: "ok", error: null, hits: [hit()] },
    ];
    fireEvent.click(screen.getByText("Head & shoulders").closest("button")!);
    vi.mocked(presetApi.runPresetScan).mockResolvedValue(presetResult(charts));
    fireEvent.click(screen.getByRole("button", { name: /scan open charts/i }));
    await waitFor(() => expect(getPatternPanelState().presetResult).not.toBeNull());

    const row = () => screen.getByRole("button", { name: /go to top match/i });
    expect(row().className).not.toContain("selected");
    fireEvent.click(row());
    expect(row().className).toContain("selected");
    expect(row().getAttribute("aria-pressed")).toBe("true");

    // The Presets view unmounts on a view switch; the store keeps the mark.
    unmount();
    await renderReady();
    expect(row().className).toContain("selected");

    // A fresh scan retires the selection with the rows it pointed into.
    fireEvent.click(screen.getByRole("button", { name: /scan open charts/i }));
    await waitFor(() => expect(getPatternPanelState().presetSelectedHit).toBeNull());
    expect(row().className).not.toContain("selected");
  });

  it("a hit for a series only the provider knows (not the dragged origin) jumps with THAT source's cellId, not ''", async () => {
    const OTHER = { cellId: "cell-2", tabId: "tab-2", epic: "GOLD", resolution: "MINUTE_15", label: "15m" };
    setPatternSeriesProvider(() => [SELF, OTHER]);
    await renderReady();
    const charts: presetApi.PresetChartResult[] = [
      { epic: "GOLD", resolution: "MINUTE_15", status: "ok", error: null, hits: [hit()] },
    ];
    fireEvent.click(screen.getByText("Head & shoulders").closest("button")!);
    vi.mocked(presetApi.runPresetScan).mockResolvedValue(presetResult(charts));
    fireEvent.click(screen.getByRole("button", { name: /scan open charts/i }));
    await waitFor(() => expect(getPatternPanelState().presetResult).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: /go to top match/i }));
    expect(workspacePanel.jumpToMatch).toHaveBeenCalledTimes(1);
    const [match] = vi.mocked(workspacePanel.jumpToMatch).mock.calls[0];
    expect(match.source).toEqual(OTHER);
    expect(match.source?.cellId).not.toBe("");
  });

  it("Find similar switches to the Similar view and calls runPatternSearch", async () => {
    const runSpy = vi.spyOn(store, "runPatternSearch").mockImplementation(() => {});
    await renderReady();
    const charts: presetApi.PresetChartResult[] = [
      { epic: "US100", resolution: "MINUTE_5", status: "ok", error: null, hits: [hit()] },
    ];
    fireEvent.click(screen.getByText("Head & shoulders").closest("button")!);
    vi.mocked(presetApi.runPresetScan).mockResolvedValue(presetResult(charts));
    fireEvent.click(screen.getByRole("button", { name: /scan open charts/i }));
    await waitFor(() => expect(getPatternPanelState().presetResult).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: /find similar/i }));
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(getPatternPanelState().view).toBe("similar");
    runSpy.mockRestore();
  });

  it("renames a user preset", async () => {
    await renderReady();
    fireEvent.click(screen.getByRole("button", { name: /rename my preset/i }));
    const input = screen.getByDisplayValue("My preset");
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(presetApi.renameUserPreset).toHaveBeenCalledWith("up1", "Renamed"));
  });

  it("deletes a user preset and un-selects it if it was selected", async () => {
    await renderReady();
    fireEvent.click(screen.getByText("My preset").closest("button")!);
    expect(getPatternPanelState().selectedFamilies).toContain("user:up1");
    fireEvent.click(screen.getByRole("button", { name: /delete my preset/i }));
    await waitFor(() => expect(presetApi.deleteUserPreset).toHaveBeenCalledWith("up1"));
    expect(getPatternPanelState().selectedFamilies).not.toContain("user:up1");
  });
});
