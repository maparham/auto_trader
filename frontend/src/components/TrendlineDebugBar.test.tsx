// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import TrendlineDebugBar, { groupLabel } from "./TrendlineDebugBar";

const base = {
  counts: [{ group: "drawn", n: 3, shown: 3 }, { group: "touches", n: 112, shown: 10 }],
  pivots: 0, hidden: new Set<string>(), expanded: new Set<string>(), overflow: 0, armed: null, message: null,
  onToggle: vi.fn(), onArm: vi.fn(), onClearTarget: null,
};

describe("TrendlineDebugBar", () => {
  afterEach(cleanup);
  it("labels a sampled group with how many are shown", () => {
    expect(groupLabel({ group: "touches", n: 112, shown: 10 }, false)).toBe("112 touches (10 shown)");
    expect(groupLabel({ group: "touches", n: 112, shown: 10 }, true)).toBe("112 touches");
    expect(groupLabel({ group: "slope", n: 4, shown: 4 }, false)).toBe("4 slope");
  });
  it("drawn is a label, not a toggle; a group click passes its size", () => {
    render(<TrendlineDebugBar {...base} />);
    expect(screen.queryByRole("button", { name: /drawn/ })).toBeNull();
    expect(screen.getByText("3 drawn")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "112 touches (10 shown)" }));
    expect(base.onToggle).toHaveBeenCalledWith("touches", 112);
  });
  it("lists near matches as buttons and edits the similarity limits", () => {
    const onPickMatch = vi.fn();
    const onSim = vi.fn();
    const matches = [{ key: "k1", dev: 0.23, cover: 0.95, reason: "touches 1.5/2" }];
    render(
      <TrendlineDebugBar
        {...base} matches={matches} onPickMatch={onPickMatch}
        sim={{ priceAtr: 0.5, spanPct: 0.8 }} onSim={onSim}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "0.2 ATR, 95%: touches 1.5/2" }));
    expect(onPickMatch).toHaveBeenCalledWith("k1", expect.anything());
    fireEvent.change(screen.getByLabelText("Price limit, ATR"), { target: { value: "0.8" } });
    expect(onSim).toHaveBeenCalledWith({ priceAtr: 0.8, spanPct: 0.8 });
    fireEvent.change(screen.getByLabelText("Span cover, percent"), { target: { value: "60" } });
    expect(onSim).toHaveBeenCalledWith({ priceAtr: 0.5, spanPct: 0.6 });
    expect(document.body.textContent).not.toMatch(/—|--/);
  });
});
