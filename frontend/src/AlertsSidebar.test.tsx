// @vitest-environment jsdom
// The alerts panel's trigger badge reads the shared TRIGGER_LABELS, so a
// repeating alert says "Once per bar" like every other alert surface.
import { describe, it, expect, vi, afterEach } from "vitest";
import { installMemStorage } from "./lib/testMemStorage";

installMemStorage();
import { cleanup, render, screen } from "@testing-library/react";

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

vi.mock("./lib/alertsApi", async (orig) => ({
  ...(await orig<typeof import("./lib/alertsApi")>()),
  loadServerAlerts: () => [indAlert],
  loadAllServerAlerts: () => [indAlert],
  loadAccountAlerts: () => [acctAlert, eqAlert],
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
