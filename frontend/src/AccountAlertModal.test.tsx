// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { installMemStorage } from "./lib/testMemStorage";

installMemStorage();
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const add = vi.fn(async () => true);
const patch = vi.fn(async () => true);
vi.mock("./lib/alertsApi", async (orig) => ({
  ...(await orig<typeof import("./lib/alertsApi")>()),
  fetchAccountMetrics: async () => ({ account: "capital-live:live", monitored: true, unmonitoredReason: null,
    metrics: { marginLevel: 177.2, equity: 4210, currency: "EUR", openPnl: -90, openPnlPct: -2.1, available: 3010 } }),
  addAccountAlert: (...a: unknown[]) => add(...a),
  patchAccountAlert: (...a: unknown[]) => patch(...a),
  findAccountAlert: (id: string) => id === "al-e" ? {
    kind: "account", id: "al-e", account: "capital-live:live", metric: "drawdown", baseline: "sinceCreated",
    tiers: [{ level: 5, label: "warn" }], message: "", expiresAt: null, precision: 2,
    notify: { toast: true, browser: true, sound: true, push: true, telegram: true },
  } : undefined,
}));

const { default: AccountAlertModal } = await import("./AccountAlertModal");

afterEach(() => {
  cleanup();
  add.mockClear();
  patch.mockClear();
});

describe("AccountAlertModal", () => {
  it("creates a margin-level alert with the default tiers and shows the server value", async () => {
    render(<AccountAlertModal request={{ mode: "create", account: "capital-live:live", metric: "marginLevel" }} now={0} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/now 177\.2%/)).toBeTruthy());
    expect((screen.getByLabelText("Tier 1 level") as HTMLInputElement).value).toBe("150");
    expect((screen.getByLabelText("Tier 3 level") as HTMLInputElement).value).toBe("100");
    fireEvent.click(screen.getByText("Create"));
    await waitFor(() => expect(add).toHaveBeenCalled());
    const a = add.mock.calls[0][0] as { metric: string; tiers: { level: number; label: string }[]; account: string };
    expect(a.account).toBe("capital-live:live");
    expect(a.tiers.map((t) => t.level)).toEqual([150, 120, 100]);
  });

  it("refuses unordered tiers before sending", async () => {
    render(<AccountAlertModal request={{ mode: "create", account: "capital-live:live", metric: "marginLevel" }} now={0} onClose={() => {}} />);
    await screen.findByText(/now 177\.2%/);
    fireEvent.change(screen.getByLabelText("Tier 2 level"), { target: { value: "160" } });
    expect((screen.getByText("Create") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/must fall from one tier to the next/)).toBeTruthy();
  });

  it("adds a tier one step past the last one and keeps Create enabled", async () => {
    render(<AccountAlertModal request={{ mode: "create", account: "capital-live:live", metric: "marginLevel" }} now={0} onClose={() => {}} />);
    await screen.findByText(/now 177\.2%/);
    fireEvent.click(screen.getByLabelText("Remove tier 3"));
    fireEvent.click(screen.getByText("Add tier"));
    expect((screen.getByLabelText("Tier 3 level") as HTMLInputElement).value).toBe("110");
    expect((screen.getByLabelText("Tier 3 label") as HTMLSelectElement).value).toBe("critical");
    expect((screen.getByText("Create") as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows the drawdown starting point instead of a value on create", async () => {
    render(<AccountAlertModal request={{ mode: "create", account: "capital-live:live", metric: "drawdown" }} now={0} onClose={() => {}} />);
    expect(await screen.findByText("starts at 0% on the next check")).toBeTruthy();
    expect(screen.queryByText(/^now /)).toBeNull();
  });

  it("edits a drawdown alert and sends the baseline", async () => {
    render(<AccountAlertModal request={{ mode: "edit", id: "al-e" }} now={0} onClose={() => {}} />);
    await screen.findByText(/Drawdown/);
    fireEvent.click(screen.getByLabelText("Since midnight"));
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("al-e", expect.objectContaining({ baseline: "daily" })));
  });
});
