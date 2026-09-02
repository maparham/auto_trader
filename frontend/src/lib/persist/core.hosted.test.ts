// @vitest-environment jsdom
//
// Hosted mode, empty backend snapshot = a FRESH ACCOUNT: the hydrate must NOT
// seed the backend from this browser's localStorage (that would leak another
// account's workspace on a shared machine) — it clears the mirrored keys
// instead, keeping device-local ones.
import { afterEach, expect, it, vi } from "vitest";
import { installMemStorage } from "../testMemStorage";

installMemStorage();

vi.mock("../authToken", () => ({
  CLERK_ENABLED: true,
  getAuthToken: async () => null,
  hasTokenGetter: () => false,
  setTokenGetter: () => {},
}));

import { hydrateFromBackend } from "./core";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("clears mirrored keys instead of seeding when backend is empty in hosted mode", async () => {
  localStorage.setItem("auto-trader.b.capital.layouts", "[1]");
  localStorage.setItem("auto-trader.b.capital.activeLayoutId", '"x"'); // device-local: kept
  // AccountGate's stamp: never mirrored, so it must survive the wipe (and the
  // non-empty prune below) — deleting it makes EVERY reload look like an
  // account switch, wiping all device-local state each page load.
  localStorage.setItem("auto-trader.lastUserId", "user_1");
  localStorage.setItem("unrelated.key", "1");
  const puts: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT") puts.push(String(url));
    return new Response("{}", { status: 200 });
  }));
  await hydrateFromBackend();
  expect(puts).toEqual([]); // no seeding
  expect(localStorage.getItem("auto-trader.b.capital.layouts")).toBeNull();
  expect(localStorage.getItem("auto-trader.b.capital.activeLayoutId")).toBe('"x"');
  expect(localStorage.getItem("auto-trader.lastUserId")).toBe("user_1");
  expect(localStorage.getItem("unrelated.key")).toBe("1");
});

it("keeps the lastUserId stamp through a non-empty hydrate's prune", async () => {
  localStorage.setItem("auto-trader.lastUserId", "user_1");
  localStorage.setItem("auto-trader.b.capital.stale", "1"); // absent from snapshot: pruned
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ "auto-trader.b.capital.layouts": [1] }), { status: 200 }),
  ));
  await hydrateFromBackend();
  expect(localStorage.getItem("auto-trader.b.capital.stale")).toBeNull();
  expect(localStorage.getItem("auto-trader.lastUserId")).toBe("user_1");
});
