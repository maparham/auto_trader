// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import TrendlineDebugPopup, { dateOf, rowFix, settingLabel } from "./TrendlineDebugPopup";
import { MAX_LIVE } from "../lib/indicators/trendlinesOutputs";
import { runDebugSync } from "../lib/indicators/trendlinesDebug";
import { explain } from "../lib/indicators/trendlinesDebugExplain";
import { TRENDLINES_DEFAULTS } from "../lib/indicators/trendlinesOutputs";
import { synthBars } from "../lib/indicators/trendlinesSynth.testutil";

const bars = synthBars(900);
const res = explain(runDebugSync({
  bars, cfg: { ...TRENDLINES_DEFAULTS, minTouches: 4 }, startIdx: 0, evalIdx: bars.length - 1,
  window: [0, bars.length - 1], forced: [],
}));
const cand = res.candidates.find((c) => c.failed[0]?.gate === "minTouches")!;

const props = {
  x: 10, y: 10, res, cand, times: bars.map((b) => b.timestamp), fix: null, fixBusy: false,
  effects: null, canUndo: false,
  onApply: vi.fn(), onApplyAll: vi.fn(), onUndo: vi.fn(), onCheckEffects: vi.fn(), onToDrawing: null as (() => void) | null, onClose: vi.fn(),
};

describe("TrendlineDebugPopup", () => {
  afterEach(cleanup);
  it("lists gates with ✓/✗ glyphs, measured / limit and the UI label", () => {
    render(<TrendlineDebugPopup {...props} />);
    expect(screen.getByText(settingLabel("minTouches"))).toBeTruthy();
    expect(screen.getAllByText("✗").length).toBeGreaterThan(0);
    expect(screen.getAllByText("✓").length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText("fail").length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText("pass").length).toBeGreaterThan(0);
  });
  it("a limit of 0 that means no limit reads off, not 0", () => {
    // Defaults leave Max Span, Max Touches and Max Crossings at 0 (no limit).
    const rows = cand.verdicts.filter((v) => v.limit === 0);
    expect(rows.map((v) => v.gate)).toEqual(expect.arrayContaining(["maxSpan", "maxTouches", "maxCrossings"]));
    expect(rows.every((v) => v.off)).toBe(true);
    render(<TrendlineDebugPopup {...props} />);
    const nums = [...document.body.querySelectorAll(".tl-dbg-num")].map((n) => n.textContent ?? "");
    expect(nums.some((t) => t.endsWith("/ off"))).toBe(true);
    expect(nums.some((t) => t.endsWith("/ 0"))).toBe(false);
  });
  it("To drawing shows only when the line can be copied", () => {
    render(<TrendlineDebugPopup {...props} />);
    expect(screen.queryByRole("button", { name: "To drawing" })).toBeNull();
    cleanup();
    const onToDrawing = vi.fn();
    render(<TrendlineDebugPopup {...props} onToDrawing={onToDrawing} />);
    fireEvent.click(screen.getByRole("button", { name: "To drawing" }));
    expect(onToDrawing).toHaveBeenCalledOnce();
  });
  it("Apply on a row sends that one change", () => {
    render(<TrendlineDebugPopup {...props} />);
    fireEvent.click(screen.getAllByRole("button", { name: /apply/i })[0]);
    expect(props.onApply).toHaveBeenCalledWith([
      expect.objectContaining({ field: "minTouches", from: 4 }),
    ]);
  });
  it("never renders an em dash or a hue class", () => {
    const { container } = render(<TrendlineDebugPopup {...props} />);
    expect(document.body.textContent).not.toMatch(/—|--/);
    // No inline colour and no hue-named class anywhere in the markup.
    expect(document.body.innerHTML).not.toMatch(/color:|class="[^"]*\b(red|green|pass-color|fail-color)\b/i);
    void container;
  });
  it("labels every exact change field", () => {
    for (const f of ["minTouches", "maxSlopeAtr", "pivotLen", "maxLines", "mergeAtr"] as const)
      expect(settingLabel(f)).not.toBe(f);
  });
  it("offers Apply all only for a verified fix", () => {
    const change = { field: "minTouches" as const, from: 4, to: 3, pool: false };
    const covered = { changes: [change], attempted: [], covered: true, viaKey: "k", blockers: [] };
    const { unmount } = render(<TrendlineDebugPopup {...props} fix={covered} />);
    expect(screen.getByRole("button", { name: /apply all/i })).toBeTruthy();
    unmount();
    const miss = { changes: [], attempted: [change], covered: false, viaKey: null, blockers: [] };
    render(<TrendlineDebugPopup {...props} fix={miss} />);
    expect(screen.queryByRole("button", { name: /apply all/i })).toBeNull();
    expect(screen.getByText("No settings change found.")).toBeTruthy();
    expect(screen.getByText(`Tried: ${settingLabel("minTouches")} 3`)).toBeTruthy();
  });
  it("shows a fix search error", () => {
    const err = { changes: [], attempted: [], covered: false, viaKey: null, blockers: [], error: "Line is off the loaded bars." };
    render(<TrendlineDebugPopup {...props} fix={err} />);
    expect(screen.getByText("Line is off the loaded bars.")).toBeTruthy();
    expect(screen.queryByText("No settings change found.")).toBeNull();
  });
  it("a pool setting or a no-op gets a hint, never an Apply button", () => {
    expect(rowFix({ field: "minTouches", from: 4, to: 3, pool: false })).toHaveProperty("apply");
    const pool = rowFix({ field: "pivotLen", from: 5, to: 3, pool: true });
    expect(pool).toEqual({ hint: `needs ${settingLabel("pivotLen")} 3, verify with Apply all` });
    expect(rowFix({ field: "minTouches", from: 2, to: 2, pool: false })).toEqual({ hint: "no setting reaches it" });
    expect(rowFix(undefined)).toEqual({ hint: "no setting reaches it" });
    // Rendered: a pool-only candidate offers no row Apply.
    const pc = res.candidates.find((c) => c.failed.length && c.failed.every((v) => v.gate === "minTouches"))!;
    const fake = { ...pc, failed: [{ gate: "fractal" as const, field: "pivotLen" as const, measured: 3, limit: 5, pass: false, anchor: 1 as const }] };
    fake.verdicts = [...fake.failed];
    render(<TrendlineDebugPopup {...props} cand={fake} />);
    expect(screen.queryByRole("button", { name: /^apply/i })).toBeNull();
    expect(screen.getByText(/verify with Apply all/)).toBeTruthy();
  });
  it("dates carry HH:MM on intraday bars only", () => {
    const t0 = Date.UTC(2026, 0, 5, 14, 30);
    expect(dateOf([t0, t0 + 3_600_000], 0)).toBe("2026-01-05 14:30");
    expect(dateOf([t0, t0 + 86_400_000], 0)).toBe("2026-01-05");
  });
  it("names the live cap from MAX_LIVE", () => {
    const capped = { ...cand, failed: [{ gate: "liveCap" as const, field: null, measured: null, limit: null, pass: false }] };
    capped.verdicts = [...capped.failed];
    render(<TrendlineDebugPopup {...props} cand={capped} />);
    expect(screen.getByText(`Dropped by the ${MAX_LIVE} live line cap`)).toBeTruthy();
  });
  it("a live candidate is live from its confirm bar", () => {
    const live = res.candidates.find((c) => c.origin === "live")!;
    const times = bars.map((b) => b.timestamp);
    render(<TrendlineDebugPopup {...props} cand={live} times={times} />);
    const want = `Live from ${dateOf(times, live.line.i2 + res.cfg.pivotLen)}`;
    expect(document.querySelector(".tl-dbg-live")!.textContent!.startsWith(want)).toBe(true);
  });
});
