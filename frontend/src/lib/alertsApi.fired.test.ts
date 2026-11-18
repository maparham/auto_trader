// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { installMemStorage } from "./testMemStorage";

installMemStorage();

vi.mock("./notify", () => ({ toast: vi.fn() }));

import {
  hydrateAlerts,
  firedPriceAlerts,
  firedIndicatorAlerts,
  firedLineAlerts,
  hideFiredAlert,
  deleteStoredAlert,
  rearmAlert,
} from "./alertsApi";
import { PREFIX } from "./workspaceKeys";

const B = "cap";
const HIDDEN_KEY = `${PREFIX}.alerts.hiddenFired`;

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: () => Promise.resolve(body) } as Response;
}

function row(o: Record<string, unknown> = {}) {
  return {
    id: "al-1", broker: B, epic: "US100", kind: "price_level",
    params: { level: 100, condition: "crossing", trigger: "once" },
    message: "", expires_at: null, notify: {}, precision: 2, active: 1,
    created_at: 1, updated_at: 1, ...o,
  };
}

function entry(alert: Record<string, unknown> | null, time = 10) {
  const a = alert ?? {};
  return {
    time, alert_id: (a.id as string) ?? "al-1", broker: (a.broker as string) ?? B,
    epic: (a.epic as string) ?? "US100", kind: (a.kind as string) ?? "price_level",
    price: 100, level: 100, condition: "crossing", message: "", precision: 2, alert,
  };
}

async function hydrate(entries: unknown[], live: unknown[] = []) {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) =>
    Promise.resolve(String(input).includes("/api/alerts/triggered")
      ? jsonResponse({ entries, seen: 0 })
      : jsonResponse({ alerts: live }))));
  await hydrateAlerts();
}

beforeEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("fired alerts from history", () => {
  it("price fired once shows", async () => {
    await hydrate([entry(row(), 42)]);
    const f = firedPriceAlerts("US100", B);
    expect(f).toHaveLength(1);
    expect(f[0].level).toBe(100);
    expect(f[0].firedAt).toBe(42);
  });

  it("every trigger excluded", async () => {
    await hydrate([entry(row({ params: { level: 100, condition: "crossing", trigger: "every" } }))]);
    expect(firedPriceAlerts("US100", B)).toEqual([]);
  });

  it("account and position excluded", async () => {
    await hydrate([
      entry(row({ kind: "account", params: { trigger: "once" } })),
      entry(row({ id: "al-2", kind: "position", params: { trigger: "once" } })),
    ]);
    expect(firedPriceAlerts("US100", B)).toEqual([]);
    expect(firedIndicatorAlerts("US100", B)).toEqual([]);
    expect(firedLineAlerts("US100", B)).toEqual([]);
  });

  it("other epic and broker excluded", async () => {
    await hydrate([entry(row({ epic: "DE40" })), entry(row({ id: "al-2", broker: "other" }))]);
    expect(firedPriceAlerts("US100", B)).toEqual([]);
  });

  it("newest entry per id", async () => {
    await hydrate([entry(row({ params: { level: 200, condition: "crossing", trigger: "once" } }), 20), entry(row(), 10)]);
    const f = firedPriceAlerts("US100", B);
    expect(f).toHaveLength(1);
    expect(f[0].firedAt).toBe(20);
    expect(f[0].level).toBe(200);
  });

  it("live id hides fired", async () => {
    await hydrate([entry(row())], [row()]);
    expect(firedPriceAlerts("US100", B)).toEqual([]);
  });

  it("entry without alert", async () => {
    await hydrate([entry(null)]);
    expect(() => firedPriceAlerts("US100", B)).not.toThrow();
    expect(firedPriceAlerts("US100", B)).toEqual([]);
  });

  it("hidden id excluded", async () => {
    await hydrate([entry(row())]);
    hideFiredAlert("al-1");
    expect(firedPriceAlerts("US100", B)).toEqual([]);
    expect(Object.keys(JSON.parse(localStorage.getItem(HIDDEN_KEY)!))).toEqual(["al-1"]);
  });

  it("hidden set is pruned to ids still in history", async () => {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify({ gone: 5, "al-1": 5 }));
    await hydrate([entry(row())]);
    expect(Object.keys(JSON.parse(localStorage.getItem(HIDDEN_KEY)!))).toEqual(["al-1"]);
  });

  it("a fire after hide shows again", async () => {
    await hydrate([entry(row(), 10)]);
    hideFiredAlert("al-1");
    await hydrate([entry(row(), Date.now() + 60_000), entry(row(), 10)]);
    expect(firedPriceAlerts("US100", B)).toHaveLength(1);
  });

  it("deleting a re-armed alert does not bring back its gray bell", async () => {
    await hydrate([entry(row(), 10)], [row()]);
    expect(firedPriceAlerts("US100", B)).toEqual([]);
    deleteStoredAlert("US100", "al-1", B);
    expect(firedPriceAlerts("US100", B)).toEqual([]);
  });

  it("line and indicator map through their row mappers", async () => {
    const anchors = { t1: 1, p1: 1, t2: 2, p2: 2 };
    await hydrate([
      entry(row({ id: "al-l", kind: "line", params: { timeframe: "HOUR", evalOn: "close", tRef: 1, pRef: 1, slope: 0, anchors, link: null, condition: "crossing", trigger: "once" } })),
      entry(row({ id: "al-i", kind: "indicator", params: { type: "EMA", config: {}, output: "ema", timeframe: "HOUR", target: "price", value: null, evalOn: "close", link: null, condition: "crossing", trigger: "once" } })),
    ]);
    expect(firedLineAlerts("US100", B)[0].params.anchors).toEqual(anchors);
    expect(firedIndicatorAlerts("US100", B)[0].params.output).toBe("ema");
  });
});

describe("rearmAlert", () => {
  it("returns server detail on 422", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse({ detail: "expired: gone" }, false, 422))));
    expect(await rearmAlert("al-1")).toBe("its expiry has passed");
  });

  it("sends origin=CLIENT_ID and returns null on success", async () => {
    const f = vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(String(input).includes("/rearm")
        ? jsonResponse(row())
        : String(input).includes("triggered") ? jsonResponse({ entries: [], seen: 0 }) : jsonResponse({ alerts: [] })));
    vi.stubGlobal("fetch", f);
    expect(await rearmAlert("al-1")).toBeNull();
    const call = f.mock.calls.find((c) => String(c[0]).includes("/rearm"))!;
    expect(String(call[0])).toMatch(/\/api\/alerts\/al-1\/rearm\?origin=/);
    expect((call[1] as RequestInit).method).toBe("POST");
  });
});
