// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

// vi.mock factories are hoisted ABOVE const declarations: a plain
// `const add = vi.fn(...)` referenced inside the factory would throw (TDZ).
// vi.hoisted runs before that hoisting and is the documented escape hatch.
// `describeFn` (not `describe`) to avoid shadowing vitest's own `describe`.
const { add, patch, loadAll, describeFn, addMove, patchMove, loadMoves, adminFlag } = vi.hoisted(() => ({
  addMove: vi.fn((_r: unknown) => Promise.resolve(null as string | null)),
  patchMove: vi.fn((_id: string, _p: Record<string, unknown>) => Promise.resolve(null as string | null)),
  loadMoves: vi.fn(() => [] as import("./lib/alertsApi").MoveRule[]),
  adminFlag: { value: false },
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
  addMoveRule: addMove,
  patchMoveRule: patchMove,
  loadMoveRules: loadMoves,
}));
vi.mock("./lib/trading", async (orig) => ({
  ...(await orig<typeof import("./lib/trading")>()),
  isAdminAccount: () => adminFlag.value,
  getTradesAccount: () => "capital-demo:demo",
  subscribeTrades: (fn: (t: unknown[]) => void) => {
    fn([{
      kind: "position", id: "d1", epic: "US100", side: "buy", quantity: 2, priceLevel: 100, stop: null,
      takeProfit: null, upnl: null, openedAt: null, expiresAt: null, leverage: null, margin: null,
    }]);
    return () => {};
  },
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
  addMove.mockReset();
  addMove.mockResolvedValue(null);
  patchMove.mockReset();
  patchMove.mockResolvedValue(null);
  loadMoves.mockReset();
  loadMoves.mockReturnValue([]);
  adminFlag.value = false;
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

  it("an event output explains the closed bar, not the broker", async () => {
    describeFn.mockResolvedValue(RSI_DESC);
    render(<IndicatorAlertModal request={{ mode: "create", draft: draft() }} defaults={DEFAULT_ALERT_DEFAULTS} now={0} onClose={() => {}} />);
    fireEvent.change(await screen.findByLabelText("Line"), { target: { value: "bullDiv" } });
    fireEvent.mouseEnter(screen.getByLabelText("About Evaluate"));
    expect(await screen.findByText("Events fire on a closed bar")).toBeTruthy();
    expect(screen.queryByText("This broker sends quotes only")).toBeNull();
  });

  it("a quote-only broker on a volume line explains the broker", async () => {
    describeFn.mockResolvedValue({ ...MA_DESC, needsVolume: true });
    const d = draft({ instance: { type: "MA", calcParams: [20], extendData: { maType: "vwma" } }, quoteOnly: true });
    render(<IndicatorAlertModal request={{ mode: "create", draft: d }} defaults={DEFAULT_ALERT_DEFAULTS} now={0} onClose={() => {}} />);
    await screen.findByLabelText("Compare");
    fireEvent.mouseEnter(screen.getByLabelText("About Evaluate"));
    expect(await screen.findByText("This broker sends quotes only")).toBeTruthy();
  });

  it("a stored intrabar alert falls back to bar close once describe blocks intrabar", async () => {
    loadAll.mockReturnValue([existingAlert({
      params: { ...existingAlert().params, output: "bullDiv", evalOn: "intrabar" },
    })]);
    describeFn.mockResolvedValue(RSI_DESC);
    render(<IndicatorAlertModal request={{ mode: "edit", id: "al-1" }} defaults={DEFAULT_ALERT_DEFAULTS} now={0} onClose={() => {}} />);
    await screen.findByText("happens");
    // The fallback is an effect that runs after the described pane renders:
    // wait for it rather than racing it (it lost on loaded CI runners).
    await waitFor(() => expect((screen.getByLabelText("On bar close") as HTMLInputElement).checked).toBe(true));
    expect((screen.getByLabelText("As it happens") as HTMLInputElement).checked).toBe(false);
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
      instance: draft().instance, output: "value", timeframe: "HOUR", target: "value", value: 55.5, evalOn: "intrabar",
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

describe("IndicatorAlertModal move rules", () => {
  const props = { defaults: DEFAULT_ALERT_DEFAULTS, now: 0, onClose: () => {} };

  it("hides the Then picker for a non-admin", async () => {
    describeFn.mockResolvedValue(RSI_DESC);
    render(<IndicatorAlertModal request={{ mode: "create", draft: draft() }} {...props} />);
    await screen.findByDisplayValue("55.5");
    expect(screen.queryByLabelText("Then")).toBeNull();
  });

  it("Move SL saves through addMoveRule as an indicator trigger", async () => {
    adminFlag.value = true;
    describeFn.mockResolvedValue(RSI_DESC);
    const onClose = vi.fn();
    render(<IndicatorAlertModal request={{ mode: "create", draft: draft() }} {...props} onClose={onClose} />);
    await screen.findByDisplayValue("55.5");
    fireEvent.change(screen.getByLabelText("Then"), { target: { value: "sl" } });
    expect(screen.queryByLabelText("Trigger")).toBeNull();
    fireEvent.click(screen.getByText("Create"));
    await waitFor(() => expect(addMove).toHaveBeenCalledTimes(1));
    expect(add).not.toHaveBeenCalled();
    expect(addMove.mock.calls[0][0]).toMatchObject({
      triggerKind: "indicator", epic: "US100", broker: "b",
      action: { field: "sl", dealId: "d1", account: "capital-demo:demo", target: { type: "breakeven", offset: 0 } },
      params: { output: "value", condition: "crossing", value: 55.5 },
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("a move rule opens in edit mode and saves through patchMoveRule", async () => {
    describeFn.mockResolvedValue(RSI_DESC);
    loadMoves.mockReturnValue([{
      id: "mv-1", broker: "b", epic: "US100", triggerKind: "indicator", precision: 2,
      params: {
        type: "RSI", config: {}, output: "value", timeframe: "HOUR", target: "value", value: 70,
        evalOn: "close", condition: "greater", trigger: "once", link: null,
      },
      action: { account: "capital-demo:demo", dealId: "d1", field: "sl", target: { type: "breakeven", offset: 1 } },
      notify: { toast: true, browser: false, sound: false, push: true, telegram: true },
    }]);
    render(<IndicatorAlertModal request={{ mode: "edit", id: "mv-1" }} {...props} />);
    expect((await screen.findByLabelText("Then") as HTMLSelectElement).value).toBe("sl");
    fireEvent.change(screen.getByLabelText("Move offset"), { target: { value: "2" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(patchMove).toHaveBeenCalledTimes(1));
    expect(patch).not.toHaveBeenCalled();
    const [id, body] = patchMove.mock.calls[0] as [string, { target: unknown; params: Record<string, unknown> }];
    expect(id).toBe("mv-1");
    expect(body.target).toEqual({ type: "breakeven", offset: 2 });
    expect(body.params).toMatchObject({ output: "value", value: 70, condition: "greater" });
  });
});
