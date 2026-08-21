// @vitest-environment jsdom
//
// The detached view's only way out. The reload that `onBackToLive` triggers is
// the exit, so the click has to reach the caller — and the label has to name the
// date the user jumped to, in the chart's zone, because a detached chart looks
// exactly like a live one that has been panned a long way back.
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import DetachedPill from "./DetachedPill";
import { maskedReplaySignal } from "./lib/maskedReplay";

afterEach(() => {
  cleanup();
  maskedReplaySignal.set({});
});

it("shows the target date and returns to live on click", () => {
  const onBack = vi.fn();
  render(<DetachedPill targetMs={Date.UTC(2024, 2, 7)} timezone="UTC" onBackToLive={onBack} />);
  expect(screen.getByText(/Mar 7, 2024/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /back to live/i }));
  expect(onBack).toHaveBeenCalledTimes(1);
});

it("falls back to the browser zone when the cell has no timezone set", () => {
  // ChartCore's `timezone` prop is "" for browser-local. Intl throws RangeError
  // on timeZone: "", so the empty string must never reach the formatter.
  const onBack = vi.fn();
  render(<DetachedPill targetMs={Date.UTC(2024, 2, 7, 12)} timezone="" onBackToLive={onBack} />);
  expect(screen.getByText(/Mar \d+, 2024/)).toBeTruthy();
});

it("labels the target in the CHART's zone, not the host's", () => {
  // 20:00 UTC on Mar 6 is already Mar 7 in Tokyo. The date the pill names has to
  // be the one the cell's axis shows, so this fails if the prop is ignored (or
  // if the formatter silently falls back to the machine's zone).
  const onBack = vi.fn();
  render(
    <DetachedPill targetMs={Date.UTC(2024, 2, 6, 20)} timezone="Asia/Tokyo" onBackToLive={onBack} />,
  );
  expect(screen.getByText(/Mar 7, 2024/)).toBeTruthy();
});

it("hides the date while a masked replay session is on screen", () => {
  maskedReplaySignal.set({
    a: { cellId: "a", startMs: Date.UTC(2024, 0, 1), clock: "24h", timezone: "UTC" },
  });
  const onBack = vi.fn();
  render(<DetachedPill targetMs={Date.UTC(2024, 2, 7)} timezone="UTC" onBackToLive={onBack} />);
  expect(screen.queryByText(/Mar 7, 2024/)).toBeNull();
  expect(screen.getByText(/hidden/)).toBeTruthy();
});
