// @vitest-environment jsdom
// The dock's All accounts tab: shown only with dealing accounts, counts the
// other accounts' positions, renders the pane, and stops fast polling when the
// dock is collapsed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const hook = vi.hoisted(() => ({ hasAccounts: true, count: 3 as number | null, calls: [] as { open: boolean }[] }));
vi.mock("./app/useAllAccounts", () => ({
  useAllAccounts: (o: { open: boolean }) => {
    hook.calls.push(o);
    return {
      visible: [], hidden: [], snaps: {}, count: hook.count, updatedAt: null,
      refresh: () => {}, setHidden: () => {}, hasAccounts: hook.hasAccounts,
    };
  },
}));
vi.mock("./AllAccountsPane", () => ({ default: () => <div>all accounts pane</div> }));

import PositionsPanel from "./PositionsPanel";
import type { BrokerAccount } from "./lib/trading";
import { DEFAULT_SETTINGS } from "./theme";

const accounts: BrokerAccount[] = [
  { key: "capital:paper", broker: "capital", env: "paper", isRealMoney: false },
  { key: "capital:demo", broker: "capital", env: "demo", isRealMoney: false },
];
const mount = () =>
  render(<PositionsPanel account="capital:paper" accounts={accounts} trading={DEFAULT_SETTINGS.trading} />);

afterEach(() => {
  cleanup();
  hook.hasAccounts = true;
  hook.count = 3;
  hook.calls = [];
});

describe("PositionsPanel All accounts tab", () => {
  it("is absent without dealing accounts", () => {
    hook.hasAccounts = false;
    mount();
    expect(screen.queryByRole("button", { name: /All accounts/ })).toBeNull();
  });

  it("shows the other accounts' count", () => {
    mount();
    expect(screen.getByRole("button", { name: /^All accounts\s*3$/ })).toBeTruthy();
  });

  it("renders the pane, not the orders table, and polls fast while shown", () => {
    mount();
    expect(hook.calls.at(-1)!.open).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /All accounts/ }));
    expect(screen.getByText("all accounts pane")).toBeTruthy();
    expect(screen.queryByText("No working orders.")).toBeNull();
    expect(hook.calls.at(-1)!.open).toBe(true);
  });

  it("stops fast polling when the dock is collapsed", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /All accounts/ }));
    const winBtns = document.querySelectorAll(".pp-winctl button");
    fireEvent.click(winBtns[winBtns.length - 1]); // "Close book"
    expect(hook.calls.at(-1)!.open).toBe(false);
  });
});
