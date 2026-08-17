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
};

const CONTROLS = [
  "Step back",
  "Play",
  "Step forward",
  "Replay order ticket",
  "Pick new start",
  "Exit replay",
] as const;

function renderPill(reportPending: boolean) {
  const on = {
    onStepBack: vi.fn(),
    onPlayPause: vi.fn(),
    onStepForward: vi.fn(),
    onSpeed: vi.fn(),
    onNewStart: vi.fn(),
    onExit: vi.fn(),
    onToggleTicket: vi.fn(),
  };
  render(
    <ReplayPill state={STATE} readout="Day 4 09:30" ticketOpen={false} reportPending={reportPending} {...on} />,
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
