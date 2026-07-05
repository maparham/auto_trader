// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SortHeader } from "./PositionsPanel";

afterEach(cleanup);

describe("SortHeader", () => {
  it("shows the title as a tooltip on focus", () => {
    render(
      <SortHeader
        label="Qty"
        col="quantity"
        sort={{ key: "openedAt", dir: "desc" }}
        onSort={() => {}}
        title="Position size (number of contracts / shares)"
      />,
    );
    fireEvent.focus(screen.getByRole("button", { name: /Qty/ }));
    expect(screen.getByRole("tooltip").textContent).toContain(
      "Position size (number of contracts / shares)",
    );
  });

  it("renders inertly with no tooltip when title is omitted", () => {
    render(
      <SortHeader
        label="Symbol"
        col="epic"
        sort={{ key: "openedAt", dir: "desc" }}
        onSort={() => {}}
      />,
    );
    fireEvent.focus(screen.getByRole("button", { name: /Symbol/ }));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("still calls onSort when clicked", () => {
    let sorted: string | null = null;
    render(
      <SortHeader
        label="Qty"
        col="quantity"
        sort={{ key: "openedAt", dir: "desc" }}
        onSort={(key) => { sorted = key; }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Qty/ }));
    expect(sorted).toBe("quantity");
  });
});
