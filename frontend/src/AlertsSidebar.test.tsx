// @vitest-environment jsdom
// The alerts panel's trigger badge reads the shared TRIGGER_LABELS, so a
// repeating alert says "Once per bar" like every other alert surface.
import { describe, it, expect, vi, afterEach } from "vitest";
import { installMemStorage } from "./lib/testMemStorage";

installMemStorage();
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

const indAlert = {
  kind: "indicator" as const,
  id: "ia-1",
  epic: "US100",
  broker: "capital",
  condition: "crossing" as const,
  trigger: "every" as const,
  message: "",
  expiresAt: null,
  notify: { toast: true, browser: true, sound: true, push: true, telegram: true },
  createdAt: 1,
  precision: 2,
  params: {
    type: "RSI",
    config: { source: "close" },
    output: "value",
    timeframe: "HOUR",
    target: "value" as const,
    value: 70,
    evalOn: "close" as const,
    link: null,
  },
};

const acctAlert = {
  kind: "account" as const, id: "al-a1", account: "capital-live:live", metric: "marginLevel" as const,
  tiers: [{ level: 150, label: "warn" as const }, { level: 120, label: "danger" as const }],
  message: "", expiresAt: null, precision: 2,
  notify: { toast: true, browser: true, sound: true, push: true, telegram: true },
  current: 118.4, firedTiers: [150, 120], monitored: false, unmonitoredReason: "session dropped",
};

// An amount metric: the panel labels it with the account's currency.
const eqAlert = {
  kind: "account" as const, id: "al-e1", account: "capital:demo", metric: "equity" as const,
  tiers: [{ level: 5000, label: "warn" as const }],
  message: "", expiresAt: null, precision: 2,
  notify: { toast: true, browser: true, sound: true, push: true, telegram: true },
  current: 4210, firedTiers: [], monitored: true, currency: "EUR",
};

// History rows and the resync spy are swapped per test (vi.mock is hoisted,
// so they live in vi.hoisted state).
const mocks = vi.hoisted(() => ({
  triggered: [] as unknown[],
  resync: vi.fn(async () => {}),
}));

vi.mock("./lib/alertsApi", async (orig) => ({
  ...(await orig<typeof import("./lib/alertsApi")>()),
  loadServerAlerts: () => [indAlert],
  loadAllServerAlerts: () => [indAlert],
  loadAccountAlerts: () => [acctAlert, eqAlert],
  loadTriggered: () => mocks.triggered,
  resyncAlerts: mocks.resync,
}));

const { default: AlertsSidebar } = await import("./AlertsSidebar");

afterEach(cleanup);

describe("AlertsSidebar trigger badge", () => {
  it("labels a repeating alert 'Once per bar', never 'Every time'", () => {
    const priceAlert = {
      id: "a-1", level: 100, condition: "crossing", trigger: "every", message: "",
      expiresAt: null, startAtCreation: true, createdAt: 2,
      hovered: false, active: false, selected: false,
    };
    const controller = {
      overlays: {
        getAlerts: () => [priceAlert],
        getSelectedAlertId: () => null,
        getHoveredAlertId: () => null,
      },
    };
    render(
      <AlertsSidebar
        controller={controller as any}
        epic="US100"
        precision={2}
        tabs={[]}
        visibleCells={[]}
        brokerId="capital"
        onOpenAlert={() => {}}
      />,
    );
    expect(screen.getAllByText("Once per bar")).toHaveLength(2);
    expect(screen.queryByText("Every time")).toBeNull();
  });
});

describe("AlertsSidebar account group", () => {
  it("lists account alerts with value, fired tiers and an unmonitored badge", () => {
    const controller = {
      overlays: {
        getAlerts: () => [],
        getSelectedAlertId: () => null,
        getHoveredAlertId: () => null,
      },
    };
    render(
      <AlertsSidebar
        controller={controller as any}
        epic="US100"
        precision={2}
        tabs={[]}
        visibleCells={[]}
        brokerId="capital"
        onOpenAlert={() => {}}
      />,
    );
    expect(screen.getByText("Account")).toBeTruthy();
    expect(screen.getByText("Capital live")).toBeTruthy();
    expect(screen.getByText(/Margin level/)).toBeTruthy();
    expect(screen.getByText(/now 118\.4%/)).toBeTruthy();
    expect(screen.getByText("Unmonitored")).toBeTruthy();
    const danger = screen.getByText("120%");
    expect(danger.className).toContain("fired");
  });

  it("labels amount metrics with the account currency", () => {
    const controller = {
      overlays: { getAlerts: () => [], getSelectedAlertId: () => null, getHoveredAlertId: () => null },
    };
    render(
      <AlertsSidebar
        controller={controller as any}
        epic="US100"
        precision={2}
        tabs={[]}
        visibleCells={[]}
        brokerId="capital"
        onOpenAlert={() => {}}
      />,
    );
    expect(screen.getByText(/now 4,210 EUR/)).toBeTruthy();
    expect(screen.getByText("5,000 EUR")).toBeTruthy();
  });
});

const bareController = {
  overlays: { getAlerts: () => [], getSelectedAlertId: () => null, getHoveredAlertId: () => null },
};

function renderSidebar() {
  return render(
    <AlertsSidebar
      controller={bareController as any}
      epic="US100"
      precision={2}
      tabs={[]}
      visibleCells={[]}
      brokerId="capital"
      onOpenAlert={() => {}}
    />,
  );
}

describe("AlertsSidebar history: account firings", () => {
  afterEach(() => {
    mocks.triggered.length = 0;
    mocks.resync.mockClear();
  });

  it("names the account, prints the headline and offers no Go-to", () => {
    mocks.triggered.push(
      {
        time: Date.now() - 60_000, epic: "", broker: "capital-live:live", kind: "account",
        condition: "below", level: 120, price: 118.4, message: "", precision: 2, alertId: "al-a1",
        headline: "Margin level 118.4% < 120% (danger)",
      },
      {
        time: Date.now() - 120_000, epic: "US100", broker: "capital", condition: "crossing_up",
        level: 100, price: 100.5, message: "", precision: 2, alertId: "a-1",
      },
    );
    const { container } = renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: /History/ }));
    const rows = container.querySelectorAll(".ap-row-hist");
    expect(rows).toHaveLength(2);
    const acct = rows[0];
    expect(acct.querySelector(".ap-sym")?.textContent).toBe("Capital live");
    expect(acct.querySelector(".ap-cond")?.textContent).toBe("Margin level 118.4% < 120% (danger)");
    // No broker chip ("Capital:demo"), no price text, no Go-to button.
    expect(acct.querySelector(".ap-broker")).toBeNull();
    expect(acct.textContent).not.toMatch(/@/);
    expect(acct.querySelector(".ap-icon-btn")).toBeNull();
    // The price firing beside it keeps its Go-to.
    expect(rows[1].querySelector(".ap-icon-btn")).not.toBeNull();
    expect(rows[1].querySelector(".ap-sym")?.textContent).toBe("US100");
  });

  it("re-pulls the alerts on the 30 s tick while account alerts exist", () => {
    vi.useFakeTimers();
    try {
      renderSidebar();
      expect(mocks.resync).not.toHaveBeenCalled();
      vi.advanceTimersByTime(30_000);
      expect(mocks.resync).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(30_000);
      expect(mocks.resync).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
