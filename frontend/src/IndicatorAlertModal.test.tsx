// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

// vi.mock factories are hoisted ABOVE const declarations: a plain
// `const add = vi.fn(...)` referenced inside the factory would throw (TDZ).
// vi.hoisted runs before that hoisting and is the documented escape hatch.
const { add, patch, loadAll } = vi.hoisted(() => ({
  add: vi.fn((_a: import("./lib/alertsApi").IndicatorAlert) => Promise.resolve(true)),
  patch: vi.fn((_id: string, _p: Record<string, unknown>) => Promise.resolve(true)),
  loadAll: vi.fn((_broker?: string) => [] as import("./lib/alertsApi").IndicatorAlert[]),
}));
vi.mock("./lib/alertsApi", async (orig) => ({
  ...(await orig<typeof import("./lib/alertsApi")>()),
  addIndicatorAlert: add,
  patchIndicatorAlert: patch,
  loadAllIndicatorAlerts: loadAll,
}));

import IndicatorAlertModal from "./IndicatorAlertModal";
import { DEFAULT_ALERT_DEFAULTS } from "./theme";
import type { IndicatorAlert } from "./lib/alertsApi";
import { noteStreamingBrokers } from "./lib/trading";

afterEach(() => {
  cleanup();
  noteStreamingBrokers([]); // the streaming set is module state; don't leak it
});

beforeEach(() => {
  add.mockReset();
  add.mockResolvedValue(true);
  patch.mockReset();
  patch.mockResolvedValue(true);
  loadAll.mockReset();
  loadAll.mockReturnValue([]);
});

const draft = (over = {}) => ({
  epic: "US100", broker: "b", precision: 2, timeframe: "HOUR",
  identity: { indicator: "RSI" as const, calcParams: [14], config: { source: "close" }, priceTarget: false },
  link: { scope: "s", instanceId: "RSI" }, lastValue: 55.5, quoteOnly: false, ...over,
});

function existingAlert(over: Partial<IndicatorAlert> = {}): IndicatorAlert {
  return {
    kind: "indicator",
    id: "al-1",
    epic: "US100",
    broker: "b",
    condition: "greater",
    trigger: "once",
    message: "custom msg",
    expiresAt: null,
    notify: { toast: true, browser: true, sound: true, push: true, telegram: true },
    createdAt: 1000,
    precision: 2,
    params: {
      identity: { indicator: "RSI", calcParams: [14], config: { source: "close" }, priceTarget: false },
      line: "value",
      timeframe: "HOUR",
      target: "value",
      value: 70,
      evalOn: "close",
      link: { scope: "s", instanceId: "RSI" },
    },
    ...over,
  };
}

describe("IndicatorAlertModal", () => {
  it("oscillators only offer value vs number, prefilled with the last value", () => {
    render(<IndicatorAlertModal request={{ mode: "create", draft: draft() }} defaults={DEFAULT_ALERT_DEFAULTS} now={0} onClose={() => {}} />);
    expect(screen.queryByLabelText("Price crosses the curve")).toBeNull();
    expect((screen.getByLabelText("Alert value") as HTMLInputElement).value).toBe("55.5");
    expect(screen.getByText("RSI 14 (1H)")).toBeTruthy();
  });
  it("quote-only volume-weighted MAs disable As it happens", () => {
    const d = draft({ identity: { indicator: "MA", calcParams: [20], config: { maType: "vwma", source: "close" }, priceTarget: true }, quoteOnly: true });
    render(<IndicatorAlertModal request={{ mode: "create", draft: d }} defaults={DEFAULT_ALERT_DEFAULTS} now={0} onClose={() => {}} />);
    expect((screen.getByLabelText("As it happens") as HTMLInputElement).disabled).toBe(true);
  });
  it("creates with the wire params", async () => {
    render(<IndicatorAlertModal request={{ mode: "create", draft: draft() }} defaults={DEFAULT_ALERT_DEFAULTS} now={0} onClose={() => {}} />);
    fireEvent.click(screen.getByText("Create"));
    const a = add.mock.calls[0][0];
    expect(a.params).toMatchObject({ target: "value", value: 55.5, evalOn: "close", timeframe: "HOUR" });
  });

  it("an untyped message is saved empty, so later identity syncs and drags show fresh text", () => {
    render(<IndicatorAlertModal request={{ mode: "create", draft: draft() }} defaults={DEFAULT_ALERT_DEFAULTS} now={0} onClose={() => {}} />);
    fireEvent.click(screen.getByText("Create"));
    expect(add.mock.calls[0][0].message).toBe("");
  });

  it("a message typed identical to the default text is not baked in either", () => {
    render(<IndicatorAlertModal request={{ mode: "create", draft: draft() }} defaults={DEFAULT_ALERT_DEFAULTS} now={0} onClose={() => {}} />);
    const input = document.querySelector(".al-message") as HTMLTextAreaElement; // the modal portals
    fireEvent.change(input, { target: { value: input.placeholder } });
    fireEvent.click(screen.getByText("Create"));
    expect(add.mock.calls[0][0].message).toBe("");
  });

  it("a custom typed message is kept", () => {
    render(<IndicatorAlertModal request={{ mode: "create", draft: draft() }} defaults={DEFAULT_ALERT_DEFAULTS} now={0} onClose={() => {}} />);
    fireEvent.change(document.querySelector(".al-message")!, { target: { value: "  my note " } });
    fireEvent.click(screen.getByText("Create"));
    expect(add.mock.calls[0][0].message).toBe("my note");
  });

  it("edit mode prefills from the existing alert and patches on save", () => {
    loadAll.mockReturnValue([existingAlert()]);
    render(<IndicatorAlertModal request={{ mode: "edit", id: "al-1" }} defaults={DEFAULT_ALERT_DEFAULTS} now={0} onClose={() => {}} />);
    expect((screen.getByLabelText("Alert value") as HTMLInputElement).value).toBe("70");
    expect((screen.getByLabelText("Alert condition") as HTMLSelectElement).value).toBe("greater");
    expect(screen.getByText("Save")).toBeTruthy();

    fireEvent.click(screen.getByText("Save"));
    expect(patch).toHaveBeenCalledWith(
      "al-1",
      expect.objectContaining({
        condition: "greater",
        params: expect.objectContaining({ target: "value", value: 70, timeframe: "HOUR" }),
      }),
    );
  });

  it("edit mode reads quoteOnly from the broker's streaming capability", () => {
    const vwma = existingAlert({
      broker: "dukascopy",
      params: {
        ...existingAlert().params,
        identity: { indicator: "MA", calcParams: [20], config: { maType: "vwma", source: "close" }, priceTarget: true },
      },
    });
    noteStreamingBrokers(["capital"]);
    loadAll.mockReturnValue([vwma]);
    render(<IndicatorAlertModal request={{ mode: "edit", id: "al-1" }} defaults={DEFAULT_ALERT_DEFAULTS} now={0} onClose={() => {}} />);
    expect((screen.getByLabelText("As it happens") as HTMLInputElement).disabled).toBe(true);
    cleanup();
    loadAll.mockReturnValue([{ ...vwma, broker: "capital" }]);
    render(<IndicatorAlertModal request={{ mode: "edit", id: "al-1" }} defaults={DEFAULT_ALERT_DEFAULTS} now={0} onClose={() => {}} />);
    expect((screen.getByLabelText("As it happens") as HTMLInputElement).disabled).toBe(false);
  });

  it("price-target indicators show the Compare radios, defaulting to Price crosses the curve", () => {
    const d = draft({
      identity: { indicator: "MA", calcParams: [20], config: { maType: "sma", source: "close" }, priceTarget: true },
    });
    render(<IndicatorAlertModal request={{ mode: "create", draft: d }} defaults={DEFAULT_ALERT_DEFAULTS} now={0} onClose={() => {}} />);
    expect((screen.getByLabelText("Price crosses the curve") as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByLabelText("Alert value")).toBeNull();

    fireEvent.click(screen.getByText("Create"));
    const a = add.mock.calls[0][0];
    expect(a.params).toMatchObject({ target: "price", value: null });
  });
});
