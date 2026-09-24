// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { installMemStorage } from "../lib/testMemStorage";
import { loadCustomResolutions, saveCustomResolutions } from "../lib/persist";

installMemStorage();
afterEach(() => {
  cleanup();
  saveCustomResolutions([]);
});

import MobilePeriodSheet from "./MobilePeriodSheet";

const HOUR = { resolution: "HOUR", label: "1H" };

function group(name: string) {
  return screen.getByRole("group", { name });
}

describe("MobilePeriodSheet", () => {
  it("groups the built-in timeframes, derived ones included, without live-only seconds", () => {
    render(<MobilePeriodSheet current={HOUR} onPick={vi.fn()} onClose={vi.fn()} />);
    expect(within(group("Minutes")).getByRole("button", { name: "3m" })).toBeTruthy();
    expect(within(group("Weeks")).getByRole("button", { name: "2W" })).toBeTruthy();
    expect(within(group("Months")).getByRole("button", { name: "1M" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Seconds" })).toBeNull();
  });

  it("marks the current timeframe, even a custom one that is not saved", () => {
    render(
      <MobilePeriodSheet current={{ resolution: "HOUR_6", label: "6H" }} onPick={vi.fn()} onClose={vi.fn()} />,
    );
    const chip = within(group("Custom")).getByRole("button", { name: "6H" });
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "1H" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("picks a timeframe", () => {
    const onPick = vi.fn();
    render(<MobilePeriodSheet current={HOUR} onPick={onPick} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "4H" }));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ resolution: "HOUR_4" }));
  });

  it("lists saved custom timeframes", () => {
    saveCustomResolutions(["DAY_2", "MINUTE_7"]);
    render(<MobilePeriodSheet current={HOUR} onPick={vi.fn()} onClose={vi.fn()} />);
    const names = within(group("Custom"))
      .getAllByRole("button")
      .map((b) => b.textContent)
      .filter((t) => t === "7m" || t === "2D");
    expect(names).toEqual(["7m", "2D"]);
  });

  it("adds a custom timeframe, saves it and picks it", () => {
    const onPick = vi.fn();
    render(<MobilePeriodSheet current={HOUR} onPick={onPick} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("radio", { name: "hours" }));
    fireEvent.change(screen.getByLabelText("Custom timeframe size"), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "Add 6H" }));
    expect(onPick).toHaveBeenCalledWith({ resolution: "HOUR_6", label: "6H" });
    expect(loadCustomResolutions()).toEqual(["HOUR_6"]);
  });

  it("adding a built-in picks it without saving it", () => {
    const onPick = vi.fn();
    render(<MobilePeriodSheet current={HOUR} onPick={onPick} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("radio", { name: "hours" }));
    fireEvent.change(screen.getByLabelText("Custom timeframe size"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Add 4H" }));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ resolution: "HOUR_4" }));
    expect(loadCustomResolutions()).toEqual([]);
  });
});
