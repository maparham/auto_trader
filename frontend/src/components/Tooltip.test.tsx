// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import Tooltip from "./Tooltip";

afterEach(cleanup);
beforeEach(() => { vi.useRealTimers(); });

describe("Tooltip", () => {
  it("shows after the delay on hover, hides on mouse leave", () => {
    vi.useFakeTimers();
    render(<Tooltip content="Close book"><button>x</button></Tooltip>);
    // expire any grace window left by a previous test
    act(() => { vi.advanceTimersByTime(600); });

    fireEvent.mouseEnter(screen.getByText("x").parentElement!);
    expect(screen.queryByRole("tooltip")).toBeNull();      // still within delay
    act(() => { vi.advanceTimersByTime(100); });
    expect(screen.getByRole("tooltip").textContent).toContain("Close book");

    fireEvent.mouseLeave(screen.getByText("x").parentElement!);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows instantly on keyboard focus", () => {
    render(<Tooltip content="Hi"><button>btn</button></Tooltip>);
    fireEvent.focus(screen.getByText("btn").parentElement!);
    expect(screen.getByRole("tooltip").textContent).toContain("Hi");
  });

  it("renders a string array as separate description lines, plus a title", () => {
    render(
      <Tooltip title="Margin" content={["Line one.", "Line two."]}>
        <span>m</span>
      </Tooltip>,
    );
    fireEvent.focus(screen.getByText("m").parentElement!);
    const tip = screen.getByRole("tooltip");
    expect(tip.querySelector(".tooltip-title")?.textContent).toBe("Margin");
    expect(tip.querySelectorAll(".tooltip-desc").length).toBe(2);
  });

  it("renders nothing and stays inert when content is empty", () => {
    render(<Tooltip content=""><button>bare</button></Tooltip>);
    fireEvent.focus(screen.getByText("bare").parentElement!);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("does not show when disabled", () => {
    render(<Tooltip content="nope" disabled><button>d</button></Tooltip>);
    fireEvent.focus(screen.getByText("d").parentElement!);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("skips the delay for a different trigger hovered within the grace window", () => {
    vi.useFakeTimers();
    render(
      <>
        <Tooltip content="First"><button>one</button></Tooltip>
        <Tooltip content="Second"><button>two</button></Tooltip>
      </>,
    );
    // expire any grace window left by a previous test
    act(() => { vi.advanceTimersByTime(600); });

    const first = screen.getByText("one").parentElement!;
    const second = screen.getByText("two").parentElement!;

    fireEvent.mouseEnter(first);
    act(() => { vi.advanceTimersByTime(100); });
    expect(screen.getByRole("tooltip").textContent).toContain("First");

    fireEvent.mouseLeave(first);
    expect(screen.queryByRole("tooltip")).toBeNull();

    // Within the grace window: hovering a different trigger shows it instantly,
    // with zero further timer advancement.
    fireEvent.mouseEnter(second);
    expect(screen.getByRole("tooltip").textContent).toContain("Second");
  });
});
