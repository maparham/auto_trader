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
  id: "al-p1", broker: "capital-live:live", epic: "US100", kind: "position",
  params: { dealId: "d1", side: "sl", atrMult: 0.5 },
  message: "", expires_at: null, notify: { toast: true, browser: true, sound: true, push: true, telegram: true },
  precision: 1, active: 1, created_at: 1, updated_at: 1,
  level: 18210, distanceAtr: 0.8, fired: false, trailing: false,
};

function res(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

beforeEach(() => { fetchMock.mockReset(); });

describe("position alerts client", () => {
  it("hydrates position rows into their own cache, not the price cache", async () => {
    fetchMock.mockImplementation(async (u: string) =>
      u.includes("/triggered") ? res(200, { entries: [], seen: 0 }) : res(200, { alerts: [row] }));
    await api.hydrateAlerts();
    expect(api.loadPositionAlerts()).toHaveLength(1);
    expect(api.loadPositionAlerts("capital-live:live")[0]).toMatchObject({
      kind: "position", account: "capital-live:live", epic: "US100", dealId: "d1", side: "sl",
      atrMult: 0.5, level: 18210, distanceAtr: 0.8, fired: false, trailing: false,
    });
    expect(api.loadPositionAlerts("other:demo")).toEqual([]);
    expect(api.findPositionAlert("d1", "sl")?.id).toBe("al-p1");
    expect(api.findPositionAlert("d1", "tp")).toBeUndefined();
    expect(api.loadAlerts("US100", "capital-live:live")).toEqual([]);
    expect(api.loadAccountAlerts()).toEqual([]);
  });

  it("addPositionAlert posts the wire shape and returns null", async () => {
    fetchMock.mockResolvedValue(res(200, { ...row, id: "al-p2", params: { dealId: "d2", side: "tp", atrMult: 1 } }));
    const r = await api.addPositionAlert({
      id: "al-p2", account: "capital-live:live", epic: "US100", dealId: "d2", side: "tp", atrMult: 1, precision: 1,
    });
    expect(r).toBeNull();
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({
      id: "al-p2", kind: "position", broker: "capital-live:live", epic: "US100", precision: 1,
      params: { dealId: "d2", side: "tp", atrMult: 1 },
    });
    expect(api.findPositionAlert("d2", "tp")?.atrMult).toBe(1);
  });

  it("a 422 returns its detail and leaves no cached row", async () => {
    fetchMock.mockResolvedValue(res(422, { detail: "trailing_stop" }));
    const r = await api.addPositionAlert({
      id: "al-p3", account: "capital-live:live", epic: "US100", dealId: "d3", side: "sl", atrMult: 0.5, precision: 1,
    });
    expect(r).toBe("trailing_stop");
    expect(api.findPositionAlert("d3", "sl")).toBeUndefined();
  });

  it("patchPositionAlert sends params and returns null; a failure returns the detail", async () => {
    fetchMock.mockResolvedValueOnce(res(200, { ...row, params: { dealId: "d1", side: "sl", atrMult: 2 } }));
    expect(await api.patchPositionAlert("al-p1", 2)).toBeNull();
    const [u, init] = fetchMock.mock.calls[0];
    expect(String(u)).toContain("/api/alerts/al-p1");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ params: { dealId: "d1", side: "sl", atrMult: 2 } });
    expect(api.findPositionAlert("d1", "sl")?.atrMult).toBe(2);
    fetchMock.mockResolvedValueOnce(res(409, { detail: "An identical alert already exists" }));
    expect(await api.patchPositionAlert("al-p1", 3)).toBe("An identical alert already exists");
  });

  it("deletePositionAlert drops the row and sends DELETE", () => {
    fetchMock.mockResolvedValue(res(200, {}));
    api.deletePositionAlert("al-p1");
    expect(api.findPositionAlert("d1", "sl")).toBeUndefined();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "DELETE" });
  });
});

describe("triggeredLabel for position firings", () => {
  it("prints the headline, like an account firing", () => {
    const t = { time: 1, epic: "US100", condition: "below", level: 1, price: 1, message: "", kind: "position",
      headline: "US100 long · near SL · 12.4 pts (0.38 ATR) away · SL 18210.0" } as never;
    expect(api.triggeredLabel(t, 1)).toBe("US100 long · near SL · 12.4 pts (0.38 ATR) away · SL 18210.0");
  });
});
