// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

// vi.mock factories are hoisted ABOVE const declarations: a plain
// `const add = vi.fn(...)` referenced inside the factory would throw (TDZ).
// vi.hoisted runs before that hoisting and is the documented escape hatch.
// `describeFn` (not `describe`) to avoid shadowing vitest's own `describe`.
const { add, patch, loadAll, describeFn } = vi.hoisted(() => ({
  add: vi.fn((_a: import("./lib/alertsApi").IndicatorAlert) => Promise.resolve(true)),
  patch: vi.fn((_id: string, _p: Record<string, unknown>) => Promise.resolve(true)),
  loadAll: vi.fn((_broker?: string) => [] as import("./lib/alertsApi").IndicatorAlert[]),
  describeFn: vi.fn((_b: unknown) => Promise.resolve(null as import("./lib/alertsApi").AlertDescription | null)),
}));
vi.mock("./lib/alertsApi", async (orig) => ({
  ...(await orig<typeof import("./lib/alertsApi")>()),
  addIndicatorAlert: add,
  patchIndicatorAlert: patch,
  loadAllIndicatorAlerts: loadAll,
  describeIndicatorAlert: describeFn,
}));

import IndicatorAlertModal from "./IndicatorAlertModal";
import { DEFAULT_ALERT_DEFAULTS } from "./theme";
import type { IndicatorAlert, AlertDescription } from "./lib/alertsApi";
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
  describeFn.mockReset();
  describeFn.mockResolvedValue(null);
});

const RSI_DESC: AlertDescription = {
  type: "RSI", timeframe: "HOUR", needsVolume: false, refusal: null,
  outputs: [
    { name: "value", label: "RSI 14", kind: "level", priceScale: false, priceOnly: false },
    { name: "bullDiv", label: "RSI 14 bullish divergence", kind: "event", priceScale: false, priceOnly: false },
  ],
  lastValues: { value: 55.5, bullDiv: 0 },
};
const MA_DESC: AlertDescription = {
  type: "MA", timeframe: "HOUR", needsVolume: false, refusal: null,
  outputs: [{ name: "ma", label: "SMA 20", kind: "level", priceScale: true, priceOnly: false }],
  lastValues: { ma: 101.5 },
};

const draft = (over: Record<string, unknown> = {}) => ({
  epic: "US100", broker: "b", precision: 2, chartTimeframe: "HOUR",
  instance: { type: "RSI", calcParams: [14], extendData: {} },
  link: { scope: "s", instanceId: "RSI" }, quoteOnly: false, ...over,
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
    label: "RSI 14 (1H)",
    params: {
      type: "RSI", config: {}, output: "value", timeframe: "HOUR",
      target: "value", value: 70, evalOn: "close", link: null,
    },
    ...over,
  };
}

describe("IndicatorAlertModal", () => {
  it("prefills the value from the server once described", async () => {
    describeFn.mockResolvedValue(RSI_DESC);
    render(<IndicatorAlertModal request={{ mode: "create", draft: draft() }} defaults={DEFAULT_ALERT_DEFAULTS} now={0} onClose={() => {}} />);
    expect(await screen.findByDisplayValue("55.5")).toBeTruthy();
    expect(document.querySelector(".al-subject")?.textContent).toBe("Indicator");
    expect(screen.queryByLabelText("Compare")).toBeNull();
  });

  it("offers a Line picker when the pane has several outputs", async () => {
    describeFn.mockResolvedValue(RSI_DESC);
    render(<IndicatorAlertModal request={{ mode: "create", draft: draft() }} defaults={DEFAULT_ALERT_DEFAULTS} now={0} onClose={() => {}} />);
    const select = (await screen.findByLabelText("Line")) as HTMLSelectElement;
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toEqual(["RSI 14", "RSI 14 bullish divergence"]);
  });

  it("an event output reads as a sentence with no value", async () => {
    describeFn.mockResolvedValue(RSI_DESC);
    render(<IndicatorAlertModal request={{ mode: "create", draft: draft() }} defaults={DEFAULT_ALERT_DEFAULTS} now={0} onClose={() => {}} />);
    const select = await screen.findByLabelText("Line");
    fireEvent.change(select, { target: { value: "bullDiv" } });
    expect(screen.getByText("happens")).toBeTruthy();
    expect(screen.queryByLabelText("Alert value")).toBeNull();
    expect((screen.getByLabelText("As it happens") as HTMLInputElement).disabled).toBe(true);

    fireEvent.click(screen.getByText("Create"));
    const a = add.mock.calls[0][0];
    expect(a.params).toMatchObject({ output: "bullDiv", target: "value", value: 0.5, evalOn: "close" });
    expect(a.condition).toBe("crossing_up");
  });

  it("price-scale outputs show Compare defaulting to Price", async () => {
    describeFn.mockResolvedValue(MA_DESC);
    const d = draft({ instance: { type: "MA", calcParams: [20], extendData: {} } });
    render(<IndicatorAlertModal request={{ mode: "create", draft: d }} defaults={DEFAULT_ALERT_DEFAULTS} now={0} onClose={() => {}} />);
    expect(((await screen.findByLabelText("Compare")) as HTMLSelectElement).value).toBe("price");
    expect(screen.getByText("the curve")).toBeTruthy();
  });

  it("a refusal disables Create and says why", async () => {
    describeFn.mockResolvedValue({ ...RSI_DESC, refusal: "Alerts on this timeframe are coming later" });
    render(<IndicatorAlertModal request={{ mode: "create", draft: draft() }} defaults={DEFAULT_ALERT_DEFAULTS} now={0} onClose={() => {}} />);
    expect(await screen.findByText("Alerts on this timeframe are coming later")).toBeTruthy();
    expect((screen.getByText("Create") as HTMLButtonElement).disabled).toBe(true);
  });

  it("creates with the instance and the described timeframe", async () => {
    describeFn.mockResolvedValue(RSI_DESC);
    render(<IndicatorAlertModal request={{ mode: "create", draft: draft() }} defaults={DEFAULT_ALERT_DEFAULTS} now={0} onClose={() => {}} />);
    await screen.findByDisplayValue("55.5");
    fireEvent.click(screen.getByText("Create"));
    const a = add.mock.calls[0][0];
    expect(a.params).toMatchObject({
      instance: draft().instance, output: "value", timeframe: "HOUR", target: "value", value: 55.5, evalOn: "close",
    });
  });

  it("edit mode describes by alert id and patches without an instance", async () => {
    loadAll.mockReturnValue([existingAlert()]);
    describeFn.mockResolvedValue(RSI_DESC);
    render(<IndicatorAlertModal request={{ mode: "edit", id: "al-1" }} defaults={DEFAULT_ALERT_DEFAULTS} now={0} onClose={() => {}} />);
    await screen.findByDisplayValue("70");
    expect(describeFn).toHaveBeenCalledWith(expect.objectContaining({ alertId: "al-1" }));

    fireEvent.click(screen.getByText("Save"));
    expect(patch).toHaveBeenCalledWith(
      "al-1",
      expect.objectContaining({
        params: expect.not.objectContaining({ instance: expect.anything() }),
      }),
    );
  });

  it("an untyped message is saved empty, so later identity syncs and drags show fresh text", async () => {
    describeFn.mockResolvedValue(RSI_DESC);
    render(<IndicatorAlertModal request={{ mode: "create", draft: draft() }} defaults={DEFAULT_ALERT_DEFAULTS} now={0} onClose={() => {}} />);
    await screen.findByDisplayValue("55.5");
    fireEvent.click(screen.getByText("Create"));
    expect(add.mock.calls[0][0].message).toBe("");
  });

  it("a message typed identical to the default text is not baked in either", async () => {
    describeFn.mockResolvedValue(RSI_DESC);
    render(<IndicatorAlertModal request={{ mode: "create", draft: draft() }} defaults={DEFAULT_ALERT_DEFAULTS} now={0} onClose={() => {}} />);
    await screen.findByDisplayValue("55.5");
    const input = document.querySelector(".al-message") as HTMLTextAreaElement; // the modal portals
    fireEvent.change(input, { target: { value: input.placeholder } });
    fireEvent.click(screen.getByText("Create"));
    expect(add.mock.calls[0][0].message).toBe("");
  });

  it("a custom typed message is kept", async () => {
    describeFn.mockResolvedValue(RSI_DESC);
    render(<IndicatorAlertModal request={{ mode: "create", draft: draft() }} defaults={DEFAULT_ALERT_DEFAULTS} now={0} onClose={() => {}} />);
    await screen.findByDisplayValue("55.5");
    fireEvent.change(document.querySelector(".al-message")!, { target: { value: "  my note " } });
    fireEvent.click(screen.getByText("Create"));
    expect(add.mock.calls[0][0].message).toBe("my note");
  });
});
