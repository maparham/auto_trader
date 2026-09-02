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
  expect(localStorage.getItem("unrelated.key")).toBe("1");
});
