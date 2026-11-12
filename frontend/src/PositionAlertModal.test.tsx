// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { installMemStorage } from "./lib/testMemStorage";

installMemStorage();
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const add = vi.fn(async (..._a: unknown[]): Promise<string | null> => null);
const patch = vi.fn(async (..._a: unknown[]): Promise<string | null> => null);
const del = vi.fn();
const state = vi.hoisted(() => ({
  trade: { kind: "position", id: "d1", epic: "US100", stop: 18200, takeProfit: 18400, trailingStop: false } as Record<string, unknown>,
  existing: {} as Record<string, unknown>,
}));

vi.mock("./lib/trading", async (orig) => ({
  ...(await orig<typeof import("./lib/trading")>()),
  subscribeTrades: (fn: (t: unknown[]) => void) => { fn([state.trade]); return () => {}; },
}));
vi.mock("./lib/alertsApi", async (orig) => ({
  ...(await orig<typeof import("./lib/alertsApi")>()),
  addPositionAlert: (...a: unknown[]) => add(...a),
  patchPositionAlert: (...a: unknown[]) => patch(...a),
  deletePositionAlert: (...a: unknown[]) => del(...a),
  findPositionAlert: (_d: string, side: string) => state.existing[side],
}));

const { default: PositionAlertModal } = await import("./PositionAlertModal");
const req = { account: "capital-live:live", epic: "US100", dealId: "d1", precision: 1 };

afterEach(() => {
  cleanup();
  add.mockClear(); patch.mockClear(); del.mockClear();
  state.existing = {};
  state.trade = { kind: "position", id: "d1", epic: "US100", stop: 18200, takeProfit: 18400, trailingStop: false };
});

describe("PositionAlertModal", () => {
  it("creates both sides with the default multiple and the symbol precision", async () => {
    const onClose = vi.fn();
    render(<PositionAlertModal request={req} onClose={onClose} />);
    fireEvent.click(screen.getByRole("switch", { name: "Warn near TP" }));
    fireEvent.click(screen.getByRole("switch", { name: "Warn near SL" }));
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(add).toHaveBeenCalledWith({ account: "capital-live:live", epic: "US100", dealId: "d1", side: "tp", atrMult: 0.5, precision: 1 });
    expect(add).toHaveBeenCalledWith({ account: "capital-live:live", epic: "US100", dealId: "d1", side: "sl", atrMult: 0.5, precision: 1 });
  });

  it("patches a changed multiple and deletes a side switched off", async () => {
    state.existing = {
      sl: { id: "al-s", side: "sl", atrMult: 0.5 },
      tp: { id: "al-t", side: "tp", atrMult: 1 },
    };
    const onClose = vi.fn();
    render(<PositionAlertModal request={req} onClose={onClose} />);
    const mult = screen.getByLabelText("Warn near SL ATR multiple");
    fireEvent.change(mult, { target: { value: "2" } });
    fireEvent.click(screen.getByRole("switch", { name: "Warn near TP" }));
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(patch).toHaveBeenCalledWith("al-s", 2);
    expect(del).toHaveBeenCalledWith("al-t");
    expect(add).not.toHaveBeenCalled();
  });

  it("disables SL on a trailing stop and a side with no level", () => {
    state.trade = { ...state.trade, trailingStop: true, takeProfit: null };
    render(<PositionAlertModal request={req} onClose={() => {}} />);
    expect((screen.getByRole("switch", { name: "Warn near SL" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("switch", { name: "Warn near TP" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the server detail and stays open on failure", async () => {
    add.mockResolvedValueOnce("An identical alert already exists");
    const onClose = vi.fn();
    render(<PositionAlertModal request={req} onClose={onClose} />);
    fireEvent.click(screen.getByRole("switch", { name: "Warn near TP" }));
    fireEvent.click(screen.getByText("Save"));
    expect(await screen.findByText("An identical alert already exists")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});
