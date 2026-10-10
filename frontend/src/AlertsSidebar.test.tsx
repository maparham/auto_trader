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
    identity: { indicator: "RSI" as const, calcParams: [14], config: { source: "close" }, priceTarget: false },
    line: "value" as const,
    timeframe: "HOUR",
    target: "value" as const,
    value: 70,
    evalOn: "close" as const,
    link: null,
  },
};

vi.mock("./lib/alertsApi", async (orig) => ({
  ...(await orig<typeof import("./lib/alertsApi")>()),
  loadIndicatorAlerts: () => [indAlert],
  loadAllIndicatorAlerts: () => [indAlert],
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
