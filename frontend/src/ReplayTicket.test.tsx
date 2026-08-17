// @vitest-environment jsdom
//
// The ticket's only real logic is turning half-typed text into numbers. Getting
// that wrong is silent: `Number("1,5")` is NaN, `??` does not catch it, and a
// NaN limit rests an order that can never fill while a NaN stop leaves a
// position with no stop at all. Both change the user's risk without saying so,
// which is the one thing a tool for practising risk must not do.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ReplayTicket from "./ReplayTicket";

afterEach(cleanup);

type Placed = Parameters<Parameters<typeof ReplayTicket>[0]["onPlace"]>[0];

function renderTicket(over: Partial<Parameters<typeof ReplayTicket>[0]> = {}) {
  const onPlace = vi.fn<(a: Placed) => void>();
  render(
    <ReplayTicket
      mark={2451.5}
      precision={1}
      canTrade
      returnTo="Day 4 09:30"
      onPlace={onPlace}
      onClose={() => {}}
      {...over}
    />,
  );
  const type = (label: string, value: string) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  const buy = () => screen.getByText("Buy") as HTMLButtonElement;
  return { onPlace, type, buy };
}

describe("ReplayTicket number parsing", () => {
  it("places a market order with the levels typed", () => {
    const { onPlace, type, buy } = renderTicket();
    type("Units", "3");
    type("Stop", "2440");
    type("Target", "2470.25");
    fireEvent.click(buy());
    expect(onPlace).toHaveBeenCalledWith({
      side: "buy",
      quantity: 3,
      type: "market",
      price: null,
      stop: 2440,
      takeProfit: 2470.25,
    });
  });

  it("leaves empty levels null (an absent stop is legitimate)", () => {
    const { onPlace, type, buy } = renderTicket();
    type("Stop", "   ");
    fireEvent.click(buy());
    expect(onPlace.mock.calls[0][0]).toMatchObject({ stop: null, takeProfit: null, quantity: 1 });
  });

  it("refuses to submit a stop that is not a number, instead of dropping it", () => {
    const { onPlace, type, buy } = renderTicket();
    type("Stop", "1,5"); // decimal comma: Number() gives NaN
    expect(buy().disabled).toBe(true);
    fireEvent.click(buy());
    expect(onPlace).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Stop").className).toContain("rt-bad");
  });

  it("refuses to submit a limit that is not a number, instead of resting it at the mark", () => {
    const { onPlace, type, buy } = renderTicket();
    fireEvent.click(screen.getByText("Limit"));
    type("Limit", "1.2.3");
    expect(buy().disabled).toBe(true);
    fireEvent.click(buy());
    expect(onPlace).not.toHaveBeenCalled();
  });

  it("recovers once the bad field is corrected", () => {
    const { onPlace, type, buy } = renderTicket();
    type("Stop", "1,5");
    expect(buy().disabled).toBe(true);
    type("Stop", "1.5");
    expect(buy().disabled).toBe(false);
    fireEvent.click(buy());
    expect(onPlace.mock.calls[0][0]).toMatchObject({ stop: 1.5 });
  });

  it("keeps Buy/Sell disabled while the cursor is rewound", () => {
    const { onPlace, buy } = renderTicket({ canTrade: false });
    expect(buy().disabled).toBe(true);
    fireEvent.click(buy());
    expect(onPlace).not.toHaveBeenCalled();
    expect(screen.getByText(/Rewound/).textContent).toContain("Day 4 09:30");
  });
});
