// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installMemStorage } from "./lib/testMemStorage";
installMemStorage();

import { HistoryControls } from "./ToolbarControls";
import { HistoryManager } from "./lib/history";
import type { ChartController } from "./lib/chartController";

const SCOPE = "tab.T.cell.c";
const KEY = `auto-trader.${SCOPE}.drawings.US100`;

let history: HistoryManager;
const ctrl = () => ({ history }) as unknown as ChartController;
const btn = (label: string) => screen.getByLabelText(label) as HTMLButtonElement;

beforeEach(() => {
  localStorage.clear();
  history = new HistoryManager(SCOPE);
});

afterEach(cleanup);

describe("HistoryControls", () => {
  it("disables both buttons on a fresh (empty) history", () => {
    render(<HistoryControls controller={ctrl()} />);
    expect(btn("Undo").disabled).toBe(true);
    expect(btn("Redo").disabled).toBe(true);
  });

  it("enables Undo once a step lands, and Redo only after undoing", async () => {
    const user = userEvent.setup();
    render(<HistoryControls controller={ctrl()} />);

    localStorage.setItem(KEY, JSON.stringify(["a"]));
    act(() => history.push(KEY, ["a"], ["a", "b"], 1000));
    localStorage.setItem(KEY, JSON.stringify(["a", "b"]));

    expect(btn("Undo").disabled).toBe(false);
    expect(btn("Redo").disabled).toBe(true);

    await user.click(btn("Undo"));
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["a"]);
    expect(btn("Undo").disabled).toBe(true);
    expect(btn("Redo").disabled).toBe(false);

    await user.click(btn("Redo"));
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["a", "b"]);
    expect(btn("Undo").disabled).toBe(false);
    expect(btn("Redo").disabled).toBe(true);
  });

  it("renders disabled with no focused cell (blank workspace)", () => {
    render(<HistoryControls controller={null} />);
    expect(btn("Undo").disabled).toBe(true);
    expect(btn("Redo").disabled).toBe(true);
  });

  it("re-reads the stacks when focus moves to another cell", () => {
    const other = new HistoryManager("tab.T.cell.other");
    localStorage.setItem(KEY, JSON.stringify(["a"]));
    history.push(KEY, ["a"], ["a", "b"], 1000);

    const { rerender } = render(<HistoryControls controller={ctrl()} />);
    expect(btn("Undo").disabled).toBe(false);

    rerender(<HistoryControls controller={{ history: other } as unknown as ChartController} />);
    expect(btn("Undo").disabled).toBe(true);
  });
});
