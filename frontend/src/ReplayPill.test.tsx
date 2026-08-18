// @vitest-environment jsdom
//
// The pill's half of the report card's one-way door. useReplay refuses these
// actions regardless — that is the authoritative gate, pinned in
// chart/useReplay.report.test.tsx — but the card has no scrim, so the pill stays
// clickable underneath it, and a silently unresponsive control is worse than a
// visibly dead one. ⟲ is the one that actually bit: a click landing through the
// card turns a ✕ exit into a "pick new start", which changes where Done lands
// the user even though the hook refused nothing.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ReplayPill from "./ReplayPill";
import type { ReplayUiState } from "./chart/useReplay";

afterEach(cleanup);

const STATE: ReplayUiState = {
  mode: "active",
  startMs: 1_000,
  cursorMs: 5_000,
  highWaterMs: 5_000,
  masked: true,
  playing: false,
  speedMs: 1000,
  atEnd: false,
  loading: false,
  error: null,
  storeSeq: 0,
};

const CONTROLS = [
  "Step back",
  "Play",
  "Step forward",
  "Replay order ticket",
  "Reveal strategy",
  "Pick new start",
  "Exit replay",
] as const;

function renderPill(reportPending: boolean, opts: { hasStrategy?: boolean; showStrategy?: boolean } = {}) {
  const on = {
    onStepBack: vi.fn(),
    onPlayPause: vi.fn(),
    onStepForward: vi.fn(),
    onSpeed: vi.fn(),
    onNewStart: vi.fn(),
    onExit: vi.fn(),
    onToggleTicket: vi.fn(),
    onToggleStrategy: vi.fn(),
  };
  render(
    <ReplayPill
      state={STATE}
      readout="Day 4 09:30"
      ticketOpen={false}
      hasStrategy={opts.hasStrategy ?? true}
      showStrategy={opts.showStrategy ?? false}
      reportPending={reportPending}
      {...on}
    />,
  );
  const btn = (label: string) => screen.getByLabelText(label) as HTMLButtonElement;
  return { ...on, btn };
}

describe("ReplayPill while a session report is pending", () => {
  it("leaves every control live during a normal session", () => {
    const { btn } = renderPill(false);
    for (const label of CONTROLS) expect(btn(label).disabled).toBe(false);
    expect((screen.getByLabelText("Replay speed") as HTMLSelectElement).disabled).toBe(false);
  });

  it("disables every control once the report card is up", () => {
    const { btn } = renderPill(true);
    for (const label of CONTROLS) expect(btn(label).disabled).toBe(true);
    expect((screen.getByLabelText("Replay speed") as HTMLSelectElement).disabled).toBe(true);
  });

  it("fires nothing when a click lands through the card", () => {
    // ⟲ and ✕ specifically: these two do not merely no-op in the hook, they
    // re-enter finishSession and would flip which teardown Done performs.
    const p = renderPill(true);
    fireEvent.click(p.btn("Pick new start"));
    fireEvent.click(p.btn("Exit replay"));
    fireEvent.click(p.btn("Step forward"));
    fireEvent.click(p.btn("Play"));
    expect(p.onNewStart).not.toHaveBeenCalled();
    expect(p.onExit).not.toHaveBeenCalled();
    expect(p.onStepForward).not.toHaveBeenCalled();
    expect(p.onPlayPause).not.toHaveBeenCalled();
  });
});

// The reveal's own gate, independent of the card: a cell with nothing saved has
// nothing to reveal, and the button says so instead of doing nothing.
describe("ReplayPill's Strategy toggle", () => {
  it("is disabled, and never looks ON, on a cell with no saved backtest", () => {
    // showStrategy deliberately true: the hook keeps the toggle sticky across
    // sessions, so a cell whose backtest was cleared can arrive here with the
    // preference still set. It must not paint a dead button as active.
    const p = renderPill(false, { hasStrategy: false, showStrategy: true });
    const b = p.btn("Reveal strategy");
    expect(b.disabled).toBe(true);
    expect(b.className).not.toContain("rp-on");
    expect(b.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(b);
    expect(p.onToggleStrategy).not.toHaveBeenCalled();
  });

  it("toggles, and reads as pressed while revealing", () => {
    const off = renderPill(false, { hasStrategy: true, showStrategy: false });
    expect(off.btn("Reveal strategy").className).not.toContain("rp-on");
    fireEvent.click(off.btn("Reveal strategy"));
    expect(off.onToggleStrategy).toHaveBeenCalledTimes(1);
    cleanup();
    const on = renderPill(false, { hasStrategy: true, showStrategy: true });
    const b = on.btn("Reveal strategy");
    expect(b.className).toContain("rp-on");
    expect(b.getAttribute("aria-pressed")).toBe("true");
  });
});
