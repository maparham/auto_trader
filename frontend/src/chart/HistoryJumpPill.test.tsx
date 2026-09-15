// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, act } from "@testing-library/react";
import HistoryJumpPill from "./HistoryJumpPill";
import { beginHistoryJump, historyJumpSignal } from "../lib/historyJump";

describe("HistoryJumpPill", () => {
  beforeEach(() => historyJumpSignal.set(null));
  afterEach(cleanup);

  it("renders nothing when no jump is in flight", () => {
    render(<HistoryJumpPill cellId="cell-1" />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the loading pill while a jump targets this cell", () => {
    render(<HistoryJumpPill cellId="cell-1" />);
    act(() => {
      beginHistoryJump("cell-1");
    });
    expect(screen.getByRole("status").textContent).toContain("Loading history");
  });

  it("stays hidden for a jump targeting another cell", () => {
    render(<HistoryJumpPill cellId="cell-1" />);
    act(() => {
      beginHistoryJump("cell-2");
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows fill progress counts when reported", () => {
    render(<HistoryJumpPill cellId="cell-1" />);
    act(() => {
      const jump = beginHistoryJump("cell-1");
      jump.update({ done: 12, total: 40 });
    });
    expect(screen.getByRole("status").textContent).toContain("12/40");
  });

  it("disappears when the jump ends", () => {
    render(<HistoryJumpPill cellId="cell-1" />);
    let jump!: ReturnType<typeof beginHistoryJump>;
    act(() => {
      jump = beginHistoryJump("cell-1");
    });
    act(() => {
      jump.end();
    });
    expect(screen.queryByRole("status")).toBeNull();
  });
});
