// apiFetch: plain fetch when no token getter is registered (local dev), bearer
// header injection when one is, and the 401 → unauthorized-handler hook.
import { afterEach, expect, it, vi } from "vitest";
import { apiFetch, setUnauthorizedHandler } from "./http";
import { setTokenGetter } from "./authToken";

afterEach(() => {
  setTokenGetter(null);
  setUnauthorizedHandler(null);
  vi.unstubAllGlobals();
});

it("passes through untouched when no token getter is registered", async () => {
  const spy = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", spy);
  await apiFetch("http://x/api/y", { method: "POST" });
  expect(spy).toHaveBeenCalledWith("http://x/api/y", { method: "POST" });
});

it("attaches the bearer header when a token is available", async () => {
  const spy = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", spy);
  setTokenGetter(async () => "tok-123");
  await apiFetch("http://x/api/y");
  const init = spy.mock.calls[0][1] as RequestInit;
  expect(new Headers(init.headers).get("Authorization")).toBe("Bearer tok-123");
});

it("preserves caller-supplied headers alongside the bearer header", async () => {
  const spy = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", spy);
  setTokenGetter(async () => "tok-123");
  await apiFetch("http://x/api/y", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const init = spy.mock.calls[0][1] as RequestInit;
  const headers = new Headers(init.headers);
  expect(headers.get("Content-Type")).toBe("application/json");
  expect(headers.get("Authorization")).toBe("Bearer tok-123");
  expect(init.method).toBe("POST");
});

it("fires the unauthorized handler on 401 in token mode", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
  setTokenGetter(async () => "tok-123");
  const onAuthFail = vi.fn();
  setUnauthorizedHandler(onAuthFail);
  const res = await apiFetch("http://x/api/y");
  expect(res.status).toBe(401);
  expect(onAuthFail).toHaveBeenCalledOnce();
});

it("does NOT fire the unauthorized handler without a token (local dev)", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
  const onAuthFail = vi.fn();
  setUnauthorizedHandler(onAuthFail);
  await apiFetch("http://x/api/y");
  expect(onAuthFail).not.toHaveBeenCalled();
});
