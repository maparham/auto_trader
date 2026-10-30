// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { installMemStorage } from "./testMemStorage";

installMemStorage();

const fetchMock = vi.fn();
vi.mock("./http", async (orig) => ({
  ...(await orig<typeof import("./http")>()),
  apiFetch: (...a: unknown[]) => fetchMock(...a),
  apiFetchPatient: (...a: unknown[]) => fetchMock(...a),
}));

const api = await import("./alertsApi");

const row = {
  id: "al-a1", broker: "capital-live:live", epic: "", kind: "account",
  params: { metric: "marginLevel", tiers: [{ level: 150, label: "warn" }] },
  message: "", expires_at: null, notify: { toast: true, browser: true, sound: true, push: true, telegram: true },
  precision: 2, active: 1, created_at: 1, updated_at: 1,
  current: 177.2, firedTiers: [], monitored: true, unmonitoredReason: null,
};

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

beforeEach(() => { fetchMock.mockReset(); });

describe("account alerts client", () => {
  it("hydrates account rows into their own cache, not the price cache", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/triggered") ? ok({ entries: [], seen: 0 }) : ok({ alerts: [row] }));
    await api.hydrateAlerts();
    expect(api.loadAccountAlerts()).toHaveLength(1);
    expect(api.loadAccountAlerts("capital-live:live")[0]).toMatchObject({ metric: "marginLevel", current: 177.2, monitored: true });
    expect(api.loadAlerts("", "capital-live:live")).toEqual([]);
  });

  it("isAccountMonitorable and labels", () => {
    expect(api.isAccountMonitorable("capital-live:live")).toBe(true);
    expect(api.isAccountMonitorable("capital:paper")).toBe(false);
    expect(api.isAccountMonitorable("mt5:live")).toBe(false);
    expect(api.accountLabel("ig-demo:demo")).toBe("IG demo");
    expect(api.fmtMetric("marginLevel", 118.4, "EUR")).toBe("118.4%");
    expect(api.fmtMetric("equity", 4210, "EUR")).toBe("4,210 EUR");
  });

  it("addAccountAlert posts the wire shape and keeps the server row", async () => {
    // A distinct id from the hydrate test's "al-a1": accountCache is module-level
    // and this test file doesn't re-hydrate between tests, so reusing that id
    // would hit addAccountAlert's own idempotent guard (already-cached -> no POST).
    const row2 = { ...row, id: "al-a2" };
    fetchMock.mockResolvedValue(ok(row2));
    const okk = await api.addAccountAlert({
      kind: "account", id: "al-a2", account: "capital-live:live", metric: "marginLevel",
      tiers: [{ level: 150, label: "warn" }], message: "", expiresAt: null, precision: 2,
      notify: { toast: true, browser: true, sound: true, push: true, telegram: true },
    });
    expect(okk).toBe(true);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ kind: "account", broker: "capital-live:live", epic: "", params: { metric: "marginLevel" } });
    expect(api.findAccountAlert("al-a2")?.current).toBe(177.2);
  });

  it("a fired account payload lands in history with its headline and no epic nav", () => {
    const seen: unknown[] = [];
    api.setOnAlertFired((p) => seen.push(p));
    api.applyAlertEvent("__alerts__:fired", {
      id: "al-a1", broker: "capital-live:live", epic: "", kind: "account", price: 118.4, level: 120,
      condition: "below", message: "", precision: 2, notify: {}, headline: "MARGIN LEVEL 118.4% < 120% (danger) · Capital live",
    });
    expect(api.loadTriggered()[0]).toMatchObject({ kind: "account", headline: expect.stringContaining("MARGIN LEVEL") });
    expect(seen).toHaveLength(1);
  });

  it("a fired account payload with its metric rebuilds the History headline from the figures", () => {
    api.applyAlertEvent("__alerts__:fired", {
      id: "al-a1", broker: "capital-live:live", epic: "", kind: "account", price: 118.4, level: 120,
      condition: "below", message: "", precision: 2, notify: {}, metric: "marginLevel", tierLabel: "danger",
      currency: "EUR", headline: "MARGIN LEVEL 118.4% < 120% (danger) · Capital live · equity 4,210 EUR",
    });
    expect(api.loadTriggered()[0].headline).toBe("Margin level 118.4% < 120% (danger)");
  });

  it("a hydrated account history row gets the same headline, with the live alert's currency", async () => {
    const eqRow = {
      ...row, id: "al-e9", params: { metric: "equity", tiers: [{ level: 5000, label: "warn" }] },
      current: 4210, currency: "EUR",
    };
    const entries = [
      { time: 2, alert_id: "al-e9", broker: "capital:demo", epic: "", kind: "account", price: 4210, level: 5000,
        condition: "below", message: "", precision: 2,
        alert: { params: { metric: "equity", tiers: [{ level: 5000, label: "warn" }] } } },
      { time: 1, alert_id: "al-gone", broker: "capital-live:live", epic: "", kind: "account", price: 7.25, level: 5,
        condition: "above", message: "", precision: 2,
        alert: { params: { metric: "drawdown", baseline: "daily", tiers: [{ level: 5, label: "warn" }] } } },
    ];
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/triggered") ? ok({ entries, seen: 0 }) : ok({ alerts: [eqRow] }));
    await api.hydrateAlerts();
    const [eq, dd] = api.loadTriggered();
    expect(eq).toMatchObject({ kind: "account", headline: "Equity 4,210 EUR < 5,000 EUR (warn)" });
    expect(api.triggeredLabel(eq, 2)).toBe("Equity 4,210 EUR < 5,000 EUR (warn)");
    // The alert is gone: no currency to borrow, the text still reads.
    expect(dd.headline).toBe("Drawdown 7.3% > 5% (warn)");
  });

  it("a monitor event reaches the monitor hook", () => {
    const seen: unknown[] = [];
    api.setOnAccountMonitor((p) => seen.push(p));
    expect(api.applyAlertEvent("__alerts__:monitor", { broker: "capital-live:live", status: "unmonitored", reason: "x", headline: "h" })).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it("a hydrate that overlaps an in-flight account add keeps the new alert", async () => {
    // The server has no account rows until the POST lands, so a hydrate that
    // runs during the POST sees an empty list and must not overwrite the cache.
    const row3 = { ...row, id: "al-a3" };
    const serverRows: unknown[] = [];
    let finishPost!: () => void;
    fetchMock.mockImplementation((u: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Promise<Response>((resolve) => {
          finishPost = () => { serverRows.push(row3); resolve(ok(row3)); };
        });
      }
      return Promise.resolve(u.includes("/triggered") ? ok({ entries: [], seen: 0 }) : ok({ alerts: serverRows }));
    });
    const added = api.addAccountAlert({
      kind: "account", id: "al-a3", account: "capital-live:live", metric: "marginLevel",
      tiers: [{ level: 150, label: "warn" }], message: "", expiresAt: null, precision: 2,
      notify: { toast: true, browser: true, sound: true, push: true, telegram: true },
    });
    await api.hydrateAlerts();
    expect(api.findAccountAlert("al-a3")).toBeDefined();
    finishPost();
    expect(await added).toBe(true);
    await vi.waitFor(() => expect(api.findAccountAlert("al-a3")).toBeDefined());
  });
});
