// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { add, addMove, patchMove, loadMoves, adminFlag } = vi.hoisted(() => ({
  addMove: vi.fn((_r: unknown) => Promise.resolve(null as string | null)),
  patchMove: vi.fn((_id: string, _p: Record<string, unknown>) => Promise.resolve(null as string | null)),
  loadMoves: vi.fn(() => [] as import("./lib/alertsApi").MoveRule[]),
  adminFlag: { value: false },
  add: vi.fn((_a: import("./lib/alertsApi").LineAlert) => Promise.resolve(true)),
}));
vi.mock("./lib/alertsApi", async (orig) => ({
  ...(await orig<typeof import("./lib/alertsApi")>()),
  addLineAlert: add,
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
      kind: "position", id: "d1", epic: "US100", side: "sell", quantity: 1, priceLevel: 50, stop: null,
      takeProfit: null, upnl: null, openedAt: null, expiresAt: null, leverage: null, margin: null,
    }]);
    return () => {};
  },
}));

import LineAlertModal from "./LineAlertModal";
import { DEFAULT_ALERT_DEFAULTS } from "./theme";

const draft = {
  epic: "US100", broker: "b", precision: 2, timeframe: "HOUR",
  line: { slope: 0.5, tRef: 9, pRef: 13, t1: 2, p1: 10, t2: 6, p2: 12 },
  link: { scope: "s", instanceId: "TRENDLINES", lineKey: "2:6" },
};

afterEach(cleanup);
beforeEach(() => {
  add.mockReset();
  add.mockResolvedValue(true);
  addMove.mockReset();
  addMove.mockResolvedValue(null);
  patchMove.mockReset();
  patchMove.mockResolvedValue(null);
  loadMoves.mockReset();
  loadMoves.mockReturnValue([]);
  adminFlag.value = false;
});

describe("LineAlertModal", () => {
  it("creates a line alert with the frozen geometry", async () => {
    const onClose = vi.fn();
    render(<LineAlertModal request={{ mode: "create", draft }} defaults={DEFAULT_ALERT_DEFAULTS}
      now={0} onClose={onClose} />);
    expect(screen.getByText("Trendline (1H)")).toBeTruthy();
    fireEvent.click(screen.getByText("Create"));
    await Promise.resolve();
    expect(add).toHaveBeenCalledTimes(1);
    const a = add.mock.calls[0][0];
    expect(a.kind).toBe("line");
    expect(a.params).toMatchObject({
      timeframe: "HOUR", evalOn: "intrabar", tRef: 9, pRef: 13, slope: 0.5,
      anchors: { t1: 2, p1: 10, t2: 6, p2: 12 }, link: draft.link,
    });
    await Promise.resolve();
    expect(onClose).toHaveBeenCalled();
  });

  it("an edit whose alert is gone closes itself", () => {
    const onClose = vi.fn();
    render(<LineAlertModal request={{ mode: "edit", id: "nope" }} defaults={DEFAULT_ALERT_DEFAULTS}
      now={0} onClose={onClose} />);
    expect(onClose).toHaveBeenCalled();
  });
});

describe("LineAlertModal move rules", () => {
  it("a Trendlines move preselect saves through addMoveRule as a line trigger", async () => {
    adminFlag.value = true;
    render(<LineAlertModal request={{ mode: "create", draft, move: { field: "tp" } }}
      defaults={DEFAULT_ALERT_DEFAULTS} now={0} onClose={() => {}} />);
    expect((screen.getByLabelText("Then") as HTMLSelectElement).value).toBe("tp");
    await waitFor(() => expect((screen.getByLabelText("Position") as HTMLSelectElement).value).toBe("d1"));
    fireEvent.click(screen.getByText("Create"));
    await waitFor(() => expect(addMove).toHaveBeenCalledTimes(1));
    expect(add).not.toHaveBeenCalled();
    expect(addMove.mock.calls[0][0]).toMatchObject({
      triggerKind: "line", epic: "US100",
      action: { field: "tp", dealId: "d1", account: "capital-demo:demo" },
      params: { tRef: 9, pRef: 13, slope: 0.5, anchors: { t1: 2, p1: 10, t2: 6, p2: 12 } },
    });
  });

  it("a line move rule opens in edit mode and saves through patchMoveRule", async () => {
    loadMoves.mockReturnValue([{
      id: "mv-2", broker: "b", epic: "US100", triggerKind: "line", precision: 2,
      params: { timeframe: "HOUR", evalOn: "close", condition: "crossing_up", trigger: "once", tRef: 9, pRef: 13, slope: 0.5,
        anchors: { t1: 2, p1: 10, t2: 6, p2: 12 }, link: null },
      action: { account: "capital-demo:demo", dealId: "d1", field: "tp", target: { type: "price", value: 40 } },
      notify: { toast: true, browser: false, sound: false, push: true, telegram: true },
    }]);
    render(<LineAlertModal request={{ mode: "edit", id: "mv-2" }} defaults={DEFAULT_ALERT_DEFAULTS}
      now={0} onClose={() => {}} />);
    expect((screen.getByLabelText("Then") as HTMLSelectElement).value).toBe("tp");
    fireEvent.change(screen.getByLabelText("Move price"), { target: { value: "41" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(patchMove).toHaveBeenCalledTimes(1));
    expect(patchMove.mock.calls[0][1]).toMatchObject({ target: { type: "price", value: 41 }, params: { evalOn: "close" } });
  });
});
