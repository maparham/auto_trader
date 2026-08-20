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

  it("sets a note apart from the description, and only warns when asked", () => {
    render(
      <Tooltip content="Invert scale" note="Session only (resets on reload)" noteWarn>
        <span>i</span>
      </Tooltip>,
    );
    fireEvent.focus(screen.getByText("i").parentElement!);
    const tip = screen.getByRole("tooltip");
    const note = tip.querySelector(".tooltip-note");
    // The note must NOT land among the description lines — its whole job is to
    // read as secondary rather than as one more line of the explanation.
    expect(tip.querySelectorAll(".tooltip-desc").length).toBe(1);
    expect(note?.textContent).toBe("Session only (resets on reload)");
    expect(note?.classList.contains("warn")).toBe(true);
    expect(note?.querySelector("svg")).not.toBeNull();

    cleanup();
    render(
      <Tooltip content="Stretch" note="Double-click the price axis to cycle">
        <span>s</span>
      </Tooltip>,
    );
    fireEvent.focus(screen.getByText("s").parentElement!);
    const plain = screen.getByRole("tooltip").querySelector(".tooltip-note");
    expect(plain?.classList.contains("warn")).toBe(false);
    expect(plain?.querySelector("svg")).toBeNull();
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

  it("stands down when it is disabled while showing, and stays down", () => {
    // A menu trigger's tooltip: hovering opens the bubble, clicking opens the
    // flyout in the same spot. The bubble has to go, and it must not pop back
    // when the menu closes without the pointer moving.
    const { rerender } = render(
      <Tooltip content="Pattern clipboard"><button>menu</button></Tooltip>,
    );
    fireEvent.focus(screen.getByText("menu").parentElement!);
    expect(screen.getByRole("tooltip")).toBeTruthy();

    rerender(<Tooltip content="Pattern clipboard" disabled><button>menu</button></Tooltip>);
    expect(screen.queryByRole("tooltip")).toBeNull();

    rerender(<Tooltip content="Pattern clipboard"><button>menu</button></Tooltip>);
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
