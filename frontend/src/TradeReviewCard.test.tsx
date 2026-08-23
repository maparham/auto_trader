// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import TradeReviewCard from "./TradeReviewCard";
import {
  backtestResultSignal,
  selectedTradeSignal,
  tradeReviewSignal,
} from "./lib/signals";
import { reviewOrder } from "./lib/tradeReview";
import type { StoredBacktestResult } from "./lib/persist";

type Trade = StoredBacktestResult["trades"][number];

function trade(over: Partial<Trade>): Trade {
  return {
    side: "buy",
    quantity: 1,
    entry_time: 1000,
    entry_price: 100,
    exit_time: 2000,
    exit_price: 101,
    pnl: 1,
    leg: "long",
    reason: "target",
    stop_initial: null,
    stop_final: null,
    target: null,
    mae: 0,
    mfe: 0,
    mae_r: null,
    mfe_r: null,
    context: null,
    ...over,
  } as Trade;
}

const trades = [
  trade({ entry_time: 1000, pnl: -5, reason: "stop", leg: "long" }),
  trade({ entry_time: 2000, pnl: 3 }),
  trade({ entry_time: 3000, pnl: -1, reason: "session-close", leg: "short" }),
];

const result = {
  trades,
  markers: [],
  resolution: "MINUTE_5",
} as unknown as StoredBacktestResult;

function enterReview() {
  backtestResultSignal.set(result);
  const order = reviewOrder(trades, "losses");
  tradeReviewSignal.set({ cohort: "losses", order, pos: 0, drill: false });
}

beforeEach(() => {
  backtestResultSignal.set(null);
  tradeReviewSignal.set(null);
  selectedTradeSignal.set(null);
});
afterEach(cleanup);

describe("TradeReviewCard", () => {
  it("renders nothing while no review is active", () => {
    const { container } = render(<TradeReviewCard />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the current trade's position, outcome and reason", () => {
    enterReview();
    render(<TradeReviewCard />);
    expect(screen.getByText(/Loss 1\/2/)).toBeTruthy();
    expect(screen.getByText(/stop/)).toBeTruthy();
  });

  it("steps with arrow keys and drives the shared trade selection", () => {
    enterReview();
    render(<TradeReviewCard />);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(tradeReviewSignal.value?.pos).toBe(1);
    // second loss is trades[2]
    expect(selectedTradeSignal.value).toBe(2);
    expect(screen.getByText(/Loss 2\/2/)).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(tradeReviewSignal.value?.pos).toBe(0);
    expect(selectedTradeSignal.value).toBe(0);
  });

  it("exits on Escape", () => {
    enterReview();
    render(<TradeReviewCard />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(tradeReviewSignal.value).toBeNull();
  });

  it("switching cohort rebuilds the order and selects its first trade", () => {
    enterReview();
    render(<TradeReviewCard />);
    fireEvent.click(screen.getByRole("tab", { name: "Wins" }));
    expect(tradeReviewSignal.value?.order).toEqual([1]);
    expect(tradeReviewSignal.value?.pos).toBe(0);
    expect(selectedTradeSignal.value).toBe(1);
    expect(screen.getByText(/Win 1\/1/)).toBeTruthy();
  });

  it("exits when the active result changes", () => {
    enterReview();
    render(<TradeReviewCard />);
    backtestResultSignal.set(null);
    expect(tradeReviewSignal.value).toBeNull();
  });

  it("shows a custom-cohort chip when the review carries a label", () => {
    backtestResultSignal.set(result);
    // A contrast-bucket cohort: e.g. all trades where trend was down.
    tradeReviewSignal.set({ cohort: "all", order: [0, 2], pos: 0, drill: false, label: "trend: down" });
    render(<TradeReviewCard />);
    const chip = screen.getByRole("tab", { name: "trend: down" });
    expect(chip.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "All" }).getAttribute("aria-selected")).toBe("false");
  });

  it("clears the custom cohort when a standard cohort is picked", () => {
    backtestResultSignal.set(result);
    tradeReviewSignal.set({ cohort: "all", order: [0, 2], pos: 0, drill: false, label: "trend: down" });
    render(<TradeReviewCard />);
    fireEvent.click(screen.getByRole("tab", { name: "Losses" }));
    expect(tradeReviewSignal.value?.label).toBeUndefined();
    expect(tradeReviewSignal.value?.order).toEqual([0, 2]); // the run's losses
    expect(screen.queryByRole("tab", { name: "trend: down" })).toBeNull();
  });

  it("explains each field on hover", () => {
    // Keyboard focus shows a Tooltip instantly (no delay, no grace window).
    const tipOf = (label: string): string => {
      // getAllByText: the open tooltip repeats the label as its title.
      const trigger = screen.getAllByText(label)[0].closest(".tooltip-trigger")!;
      fireEvent.focus(trigger);
      const text = screen.getByRole("tooltip").textContent ?? "";
      fireEvent.blur(trigger);
      return text;
    };
    backtestResultSignal.set({
      ...result,
      trades: [
        { ...trades[0], mae_r: -1.11, mfe_r: 0.42, context: { vol_regime: "mid", hour_utc: 13 } },
      ],
    } as unknown as StoredBacktestResult);
    tradeReviewSignal.set({ cohort: "losses", order: [0], pos: 0, drill: false });
    render(<TradeReviewCard />);
    expect(tipOf("MAE / MFE")).toMatch(/against|worst/i);
    expect(tipOf("Held")).toBeTruthy();
    expect(tipOf("Reason")).toBeTruthy();
    // Context keys are raw backend field names, so they carry their own tips.
    expect(tipOf("vol_regime")).toMatch(/volatil/i);
    expect(tipOf("hour_utc")).toMatch(/UTC/);
  });

  it("survives the SAME result being re-published (drill-in rehydrate)", () => {
    // A drill-in step switches timeframe; the rehydrate re-fires the result
    // signal with the identical object. That must not end the tour.
    enterReview();
    render(<TradeReviewCard />);
    backtestResultSignal.set(result);
    expect(tradeReviewSignal.value).not.toBeNull();
  });
});
