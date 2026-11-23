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

const action = { account: "capital-live:live", dealId: "d1", field: "sl", direction: "BUY", target: { type: "breakeven", offset: 0 } };
const row = {
  id: "al-m1", broker: "capital-live:live", epic: "US100", kind: "price_level",
  params: { level: 18300, condition: "crossing_up", trigger: "once" }, action,
  message: "", expires_at: null, notify: { toast: true, browser: false, sound: false, push: true, telegram: true },
  precision: 1, active: 1, created_at: 1, updated_at: 1,
};

function res(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function serve(alerts: unknown[], entries: unknown[] = []) {
  fetchMock.mockImplementation(async (u: string) =>
    u.includes("/triggered") ? res(200, { entries, seen: 0 }) : res(200, { alerts }));
}

beforeEach(() => { fetchMock.mockReset(); });

describe("move rules client", () => {
  it("hydrate keeps move rules out of the price alert cache", async () => {
    serve([row]);
    await api.hydrateAlerts();
    expect(api.loadAlerts("US100", "capital-live:live")).toEqual([]);
    expect(api.loadMoveRules()).toHaveLength(1);
    expect(api.loadMoveRules({ account: "capital-live:live", dealId: "d1" })[0]).toMatchObject({
      id: "al-m1", triggerKind: "price_level", epic: "US100", action,
    });
    expect(api.loadMoveRules({ account: "other" })).toEqual([]);
  });

  it("findMoveRule finds by deal and field", async () => {
    serve([row]);
    await api.hydrateAlerts();
    expect(api.findMoveRule("d1", "sl")?.id).toBe("al-m1");
    expect(api.findMoveRule("d1", "tp")).toBeUndefined();
    expect(api.findMoveRule("d9", "sl")).toBeUndefined();
  });

  it("fired bells skip move rules", async () => {
    serve([], [{ time: 5, alert_id: "al-m1", broker: "capital-live:live", epic: "US100", kind: "move",
      price: 1, level: 18300, condition: "crossing_up", message: "", alert: { ...row, headline: "h" } }]);
    await api.hydrateAlerts();
    expect(api.firedPriceAlerts("US100", "capital-live:live")).toEqual([]);
  });

  it("history label for a move is its headline", () => {
    expect(api.triggeredLabel({ kind: "move", headline: "SL moved" } as never, 2)).toBe("SL moved");
    expect(api.triggeredLabel({ kind: "move" } as never, 2)).toBe("Move rule");
  });

  it("addMoveRule forces trigger once", async () => {
    fetchMock.mockResolvedValue(res(200, { ...row, id: "al-m2" }));
    const r = await api.addMoveRule({
      id: "al-m2", broker: "capital-live:live", epic: "US100", triggerKind: "price_level",
      params: { level: 18300, condition: "crossing_up", trigger: "every" },
      action: action as never, precision: 1,
    });
    expect(r).toBeNull();
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ id: "al-m2", kind: "price_level", params: { trigger: "once", level: 18300 }, action, precision: 1 });
    expect(api.findMoveRule("d1", "sl")?.id).toBe("al-m2");
  });

  it("a failed add returns the detail and caches nothing", async () => {
    fetchMock.mockResolvedValue(res(409, { detail: "move_rule_exists" }));
    const r = await api.addMoveRule({
      id: "al-m3", broker: "b", epic: "E", triggerKind: "price_level", params: {}, action: { ...action, dealId: "dx" } as never, precision: 1,
    });
    expect(r).toBe("move_rule_exists");
    expect(api.findMoveRule("dx", "sl")).toBeUndefined();
  });

  it("patchMoveRule sends only the action target", async () => {
    serve([row]);
    await api.hydrateAlerts();
    const target = { type: "price", value: 18250 };
    fetchMock.mockResolvedValue(res(200, { ...row, action: { ...action, target } }));
    expect(await api.patchMoveRule("al-m1", { target: target as never })).toBeNull();
    const [u, init] = fetchMock.mock.calls.at(-1)!;
    expect(String(u)).toContain("/api/alerts/al-m1");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ action: { target } });
    expect(api.findMoveRule("d1", "sl")?.action.target).toEqual(target);
  });

  it("deleteMoveRule removes it, and restores it on a server failure", async () => {
    serve([row]);
    await api.hydrateAlerts();
    fetchMock.mockResolvedValue(res(200, {}));
    expect(await api.deleteMoveRule("al-m1")).toBeNull();
    expect(api.findMoveRule("d1", "sl")).toBeUndefined();

    serve([row]);
    await api.hydrateAlerts();
    fetchMock.mockImplementation(async (_u: string, init?: RequestInit) =>
      init?.method === "DELETE" ? res(500, { detail: "boom" }) : res(200, { alerts: [row], entries: [], seen: 0 }));
    expect(await api.deleteMoveRule("al-m1")).toBe("boom");
    expect(api.findMoveRule("d1", "sl")?.id).toBe("al-m1");
  });
});
