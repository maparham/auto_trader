// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import AllAccountsPane from "./AllAccountsPane";
import type { AllAccountsData } from "./app/useAllAccounts";
import type { AccountSnapshot } from "./lib/allAccounts";
import { brokerLabel, type BrokerAccount, type TradeView } from "./lib/trading";
import { DEFAULT_SETTINGS } from "./theme";

const acct = (key: string): BrokerAccount => ({
  key,
  broker: key.split(":")[0],
  env: key.split(":")[1],
  isRealMoney: key.endsWith(":live"),
});
const pos = (id: string, extra: Partial<TradeView> = {}): TradeView => ({
  kind: "position", id, epic: "US100", side: "buy", quantity: 2, priceLevel: 100.5,
  stop: null, takeProfit: null, upnl: 12.5, openedAt: null, expiresAt: null, leverage: null, margin: null,
  mark: null, ...extra,
});
const snap = (account: string, extra: Partial<AccountSnapshot> = {}): AccountSnapshot => ({
  account, positions: null, summary: null, error: null, fetchedAt: null, ...extra,
});

function data(over: Partial<AllAccountsData> = {}): AllAccountsData {
  return {
    visible: [acct("capital:demo"), acct("ig-live:live")],
    hidden: [],
    snaps: {},
    count: null,
    updatedAt: null,
    refresh: vi.fn(),
    setHidden: vi.fn(),
    hasAccounts: true,
    ...over,
  };
}

const section = (key: string) => screen.getByRole("region", { name: brokerLabel(key.split(":")[0]) });

function mount(d: AllAccountsData, onOpen = vi.fn()) {
  const r = render(
    <AllAccountsPane data={d} active="capital:demo" trading={DEFAULT_SETTINGS.trading} onOpen={onOpen} />,
  );
  return { ...r, onOpen };
}

afterEach(cleanup);

describe("AllAccountsPane", () => {
  it("renders one section per visible account and marks the current one", () => {
    mount(data());
    expect(within(section("capital:demo")).getByText("current")).toBeTruthy();
    expect(within(section("ig-live:live")).queryByText("current")).toBeNull();
  });

  it("expands an account that loads with positions and collapses one that loads empty", () => {
    const d = data({ snaps: { "capital:demo": snap("capital:demo") } });
    const { rerender } = mount(d);
    const loaded = data({
      snaps: {
        "capital:demo": snap("capital:demo", { positions: [] }),
        "ig-live:live": snap("ig-live:live", { positions: [pos("D1")] }),
      },
    });
    rerender(<AllAccountsPane data={loaded} active="capital:demo" trading={DEFAULT_SETTINGS.trading} onOpen={vi.fn()} />);
    expect(within(section("ig-live:live")).getByText("US100")).toBeTruthy();
    const demo = section("capital:demo");
    expect(within(demo).queryByText("No open positions")).toBeNull();
    fireEvent.click(within(demo).getByRole("button", { expanded: false }));
    expect(within(demo).getByText("No open positions")).toBeTruthy();
  });

  it("shows the Positions tab's columns and dashes for missing values", () => {
    mount(
      data({
        snaps: {
          "ig-live:live": snap("ig-live:live", {
            positions: [pos("D1", { mark: 100, stop: 99.6, takeProfit: null })],
          }),
        },
      }),
    );
    const s = section("ig-live:live");
    for (const h of ["Symbol", "Side", "Qty", "P&L", "Avg fill", "TP", "SL", "Last", "Lev", "Margin", "Time"]) {
      expect(within(s).getByRole("button", { name: h })).toBeTruthy();
    }
    const row = within(s).getByText("US100").closest("tr")!;
    const text = row.textContent!;
    expect(text).toContain("Long");
    expect(text).toContain("100.5");
    expect(text).toContain("+12.50");
    expect(text).toContain("99.6");
    expect(within(row).getAllByText("—").length).toBeGreaterThanOrEqual(2); // TP level and time
  });

  it("groups several positions of one symbol under a fold row", () => {
    mount(
      data({
        snaps: { "ig-live:live": snap("ig-live:live", { positions: [pos("D1"), pos("D2", { upnl: 1 })] }) },
      }),
    );
    const s = section("ig-live:live");
    expect(within(s).getAllByText("US100").length).toBe(3);
    fireEvent.click(within(s).getByRole("button", { name: "Hide positions" }));
    expect(within(s).getAllByText("US100").length).toBe(1);
  });

  it("drops row and header tooltips with tips off", () => {
    vi.useFakeTimers();
    try {
      render(
        <AllAccountsPane
          data={data({ snaps: { "ig-live:live": snap("ig-live:live", { positions: [pos("D1")] }) } })}
          active="capital:demo"
          trading={DEFAULT_SETTINGS.trading}
          onOpen={vi.fn()}
          tips={false}
        />,
      );
      const s = section("ig-live:live");
      fireEvent.mouseEnter(within(s).getByText("US100").closest("tr")!);
      fireEvent.mouseEnter(within(s).getByRole("button", { name: "Qty" }));
      act(() => vi.advanceTimersByTime(500));
      expect(screen.queryByRole("tooltip")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows an account's error with its last positions", () => {
    mount(
      data({
        snaps: { "ig-live:live": snap("ig-live:live", { positions: [pos("D1")], error: "positions failed (502)" }) },
      }),
    );
    const s = section("ig-live:live");
    expect(within(s).getByText("positions failed (502)")).toBeTruthy();
    expect(within(s).getByText("US100")).toBeTruthy();
  });

  it("calls onOpen with account, epic and deal id on row click", () => {
    const { onOpen } = mount(
      data({ snaps: { "ig-live:live": snap("ig-live:live", { positions: [pos("D1")] }) } }),
    );
    fireEvent.click(within(section("ig-live:live")).getByText("US100"));
    expect(onOpen).toHaveBeenCalledWith("ig-live:live", "US100", "D1");
  });

  it("hides and shows accounts", () => {
    const d = data({ visible: [acct("capital:demo")], hidden: [acct("ig-live:live")] });
    mount(d);
    fireEvent.click(within(section("capital:demo")).getByRole("button", { name: "Hide this account" }));
    expect(d.setHidden).toHaveBeenCalledWith("capital:demo", true);
    fireEvent.click(screen.getByText("Hidden (1)"));
    fireEvent.click(screen.getByRole("button", { name: "Show this account" }));
    expect(d.setHidden).toHaveBeenCalledWith("ig-live:live", false);
  });

  it("refreshes on the refresh button", () => {
    const d = data();
    mount(d);
    fireEvent.click(screen.getByRole("button", { name: "Refresh now" }));
    expect(d.refresh).toHaveBeenCalled();
  });

  it("shows prices with the most decimals among entry, mark and levels", () => {
    mount(
      data({
        snaps: {
          "ig-live:live": snap("ig-live:live", {
            positions: [pos("D1", { priceLevel: 18000, mark: 18001.37, stop: 17950 })],
          }),
        },
      }),
    );
    const row = within(section("ig-live:live")).getByText("US100").closest("tr")!;
    expect(row.textContent).toContain("18001.37");
    expect(row.textContent).toContain("18000.00");
    expect(row.textContent).toContain("17950.00");
  });

  it("says not loaded, not empty, for an account that never loaded", () => {
    mount(data({ snaps: { "ig-live:live": snap("ig-live:live", { error: "down" }) } }));
    const s = section("ig-live:live");
    fireEvent.click(within(s).getByRole("button", { expanded: false }));
    expect(within(s).queryByText("No open positions")).toBeNull();
    expect(within(s).getByText("Not loaded yet")).toBeTruthy();
  });
});
