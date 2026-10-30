// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { installMemStorage } from "./lib/testMemStorage";

installMemStorage();
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("klinecharts", () => ({ registerIndicator: () => {}, registerOverlay: () => {}, registerYAxis: () => {}, getSupportedIndicators: () => [] }));

const { Stat } = await import("./PositionsPanel");

afterEach(cleanup);

describe("dock Stat bell", () => {
  it("renders no bell without onAlert", () => {
    render(<Stat label="Balance" value="1" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("renders a bell that calls onAlert and marks an existing alert", () => {
    const onAlert = vi.fn();
    render(<Stat label="Margin level" value="77.78%" onAlert={onAlert} hasAlert alertLabel="Alert on margin level" />);
    const btn = screen.getByRole("button", { name: "Alert on margin level" });
    expect(btn.className).toContain("on");
    fireEvent.click(btn);
    expect(onAlert).toHaveBeenCalledTimes(1);
  });
});
