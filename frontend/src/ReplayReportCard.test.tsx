// @vitest-environment jsdom
//
// The card is the ONE surface allowed to print a blind session's real dates, so
// the thing worth pinning is when it prints them: the reveal block is gated on
// `masked`, and an unmasked session (whose dates were on the axis all along)
// must not grow a redundant "This was ..." row. The rest is the stat rows the
// user's session is judged by, and the two ways out — both of which are exits,
// neither of which is a cancel.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ReplayReportCard from "./ReplayReportCard";
import type { ReplaySummary } from "./lib/replayLedger";

afterEach(cleanup);

const SUMMARY: ReplaySummary = {
  trades: 4,
  wins: 3,
  winRate: 0.75,
  netPnl: 12.5,
  openPositions: 0,
};

function renderCard(over: Partial<Parameters<typeof ReplayReportCard>[0]> = {}) {
  const onDone = vi.fn();
  render(
    <ReplayReportCard
      summary={SUMMARY}
      startLabel="2021-05-17 09:00"
      endLabel="2021-05-17 15:30"
      masked
      onDone={onDone}
      {...over}
    />,
  );
  // The stat rows are label/value pairs; read the value beside a given label.
  const stat = (k: string) =>
    screen.getByText(k).parentElement?.querySelector(".rr-v")?.textContent;
  return { onDone, stat };
}

describe("ReplayReportCard", () => {
  it("renders the stat rows", () => {
    const { stat } = renderCard();
    expect(stat("Trades")).toBe("4");
    expect(stat("Win rate")).toBe("75%");
    expect(stat("Net P&L (closed trades)")).toBe("+12.50");
    // Nothing left open: the row is absent rather than showing a zero.
    expect(screen.queryByText("Still open")).toBeNull();
  });

  it("marks a losing session's P&L negative", () => {
    const { stat } = renderCard({
      summary: { trades: 2, wins: 0, winRate: 0, netPnl: -8.25, openPositions: 2 },
    });
    expect(stat("Net P&L (closed trades)")).toBe("−8.25");
    expect(screen.getByText("Net P&L (closed trades)").parentElement?.querySelector(".rr-v")?.className).toContain("neg");
    expect(stat("Still open")).toBe("2");
  });

  it("shows a dash rather than 0% when the session took no trades", () => {
    const { stat } = renderCard({
      summary: { trades: 0, wins: 0, winRate: 0, netPnl: 0, openPositions: 0 },
    });
    expect(stat("Trades")).toBe("0");
    expect(stat("Win rate")).toBe("-");
  });

  it("reveals the real date range only for a MASKED session", () => {
    renderCard({ masked: true });
    expect(screen.getByText("This was")).toBeTruthy();
    expect(screen.getByText(/2021-05-17 09:00 to 2021-05-17 15:30/)).toBeTruthy();

    cleanup();
    renderCard({ masked: false });
    // An unmasked session had its dates on the axis throughout; there is nothing
    // to unhide, so the block is absent entirely.
    expect(screen.queryByText("This was")).toBeNull();
    expect(screen.queryByText(/2021-05-17 09:00 to/)).toBeNull();
  });

  it("exits on Done", () => {
    const { onDone } = renderCard();
    fireEvent.click(screen.getByText("Done"));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("exits on Escape too (never cancels)", () => {
    // Escape here is NOT a dismiss: the reveal cannot be un-seen, so the only
    // honest thing it can do is the same teardown Done performs.
    const { onDone } = renderCard();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("does NOT close on an outside click", () => {
    // Deliberately against the app's outside-click convention: see the header
    // comment in ReplayReportCard.tsx. A stray click must not silently end a
    // session, and it cannot cancel one either.
    const { onDone } = renderCard();
    fireEvent.mouseDown(document.body);
    fireEvent.click(document.body);
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Replay session report" })).toBeTruthy();
  });
});
