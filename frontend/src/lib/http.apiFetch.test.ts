// apiFetch: plain fetch when no token getter is registered (local dev), bearer
// header injection when one is, and the 401 → unauthorized-handler hook.
import { afterEach, expect, it, vi } from "vitest";
import { installMemStorage } from "./testMemStorage";

installMemStorage();

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

it("attaches the impersonation header when impersonating", async () => {
  const { setImpersonatedUserId } = await import("./impersonation");
  setImpersonatedUserId("user_target");
  const calls: RequestInit[] = [];
  vi.stubGlobal("fetch", (_u: unknown, init: RequestInit) => {
    calls.push(init);
    return Promise.resolve(new Response("{}"));
  });
  await apiFetch("/api/alerts");
  expect(new Headers(calls[0]?.headers).get("X-Impersonate-User")).toBe(
    "user_target",
  );
  setImpersonatedUserId(null);
});

it("omits the impersonation header when not impersonating", async () => {
  const calls: RequestInit[] = [];
  vi.stubGlobal("fetch", (_u: unknown, init: RequestInit) => {
    calls.push(init);
    return Promise.resolve(new Response("{}"));
  });
  await apiFetch("/api/alerts");
  expect(new Headers(calls[0]?.headers).get("X-Impersonate-User")).toBeNull();
});

it("attaches both the bearer token and the impersonation header on the hosted path", async () => {
  // The two tests above only exercise the !hasTokenGetter() fast path.
  // Production always has a token getter registered, so the header must
  // also be attached on the token branch, alongside Authorization.
  const { setImpersonatedUserId } = await import("./impersonation");
  setImpersonatedUserId("user_target");
  const spy = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("{}", { status: 200 }),
  );
  vi.stubGlobal("fetch", spy);
  setTokenGetter(async () => "tok-123");
  await apiFetch("http://x/api/y");
  const init = spy.mock.calls[0][1];
  const headers = new Headers(init?.headers);
  expect(headers.get("Authorization")).toBe("Bearer tok-123");
  expect(headers.get("X-Impersonate-User")).toBe("user_target");
  setImpersonatedUserId(null);
});

it("attaches the impersonation header on the 401 retry with a fresh token", async () => {
  const { setImpersonatedUserId } = await import("./impersonation");
  setImpersonatedUserId("user_target");
  const calls: RequestInit[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_u: unknown, init: RequestInit) => {
      calls.push(init);
      return Promise.resolve(new Response("{}", { status: 401 }));
    }),
  );
  setTokenGetter((opts?: { fresh?: boolean }) =>
    Promise.resolve(opts?.fresh ? "tok-fresh" : "tok-123"),
  );
  await apiFetch("http://x/api/y");
  expect(calls).toHaveLength(2);
  const retryHeaders = new Headers(calls[1]?.headers);
  expect(retryHeaders.get("Authorization")).toBe("Bearer tok-fresh");
  expect(retryHeaders.get("X-Impersonate-User")).toBe("user_target");
  setImpersonatedUserId(null);
});
