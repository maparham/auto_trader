// @vitest-environment jsdom
//
// While impersonating, the backend refuses every write (the gate is read-only).
// Mirroring anyway would 403 on every autosave and spam errors, so the mirror
// is never enabled for the duration.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installMemStorage } from "../testMemStorage";

installMemStorage();

import { setImpersonatedUserId } from "../impersonation";
import { hydrateFromBackend, save } from "./core";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  setImpersonatedUserId(null);
  vi.unstubAllGlobals();
});

function stubFetch(): RequestInit[] {
  const calls: RequestInit[] = [];
  vi.stubGlobal("fetch", (_u: unknown, init: RequestInit = {}) => {
    calls.push(init);
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
  });
  return calls;
}

it("does not mirror writes while impersonating", async () => {
  setImpersonatedUserId("user_target");
  const calls = stubFetch();
  await hydrateFromBackend();
  calls.length = 0;
  save("auto-trader.b.capital.layouts", [1]);
  expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
});

it("mirrors writes normally when not impersonating", async () => {
  const calls = stubFetch();
  await hydrateFromBackend();
  calls.length = 0;
  save("auto-trader.b.capital.layouts", [1]);
  expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
});
