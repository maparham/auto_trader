// @vitest-environment jsdom
//
// The bridge is the only place Clerk's hook world meets the plain-module
// clients: mounting it must register a working token getter, and unmounting
// must deregister (otherwise a signed-out app would keep minting headers).
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { getAuthToken, setTokenGetter } from "../lib/authToken";
import { setUnauthorizedHandler, apiFetch } from "../lib/http";
import ClerkTokenBridge from "./ClerkTokenBridge";

const { signOut, getToken } = vi.hoisted(() => ({
  signOut: vi.fn(),
  getToken: vi.fn(async () => "clerk-tok"),
}));

vi.mock("@clerk/clerk-react", () => ({
  useAuth: () => ({ getToken }),
  useClerk: () => ({ signOut }),
}));

afterEach(() => {
  cleanup();
  setTokenGetter(null);
  setUnauthorizedHandler(null);
  vi.unstubAllGlobals();
});

it("registers Clerk's getToken while mounted, deregisters on unmount", async () => {
  const { unmount } = render(<ClerkTokenBridge />);
  expect(await getAuthToken()).toBe("clerk-tok");
  unmount();
  expect(await getAuthToken()).toBeNull();
});

it("registers signOut as the unauthorized handler while mounted", async () => {
  const { unmount } = render(<ClerkTokenBridge />);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
  await apiFetch("http://x/api/y");
  expect(signOut).toHaveBeenCalled();
  unmount();
  signOut.mockClear();
  await apiFetch("http://x/api/y");
  expect(signOut).not.toHaveBeenCalled();
});

it("mints a fresh token when the tab becomes visible or the network returns", () => {
  const { unmount } = render(<ClerkTokenBridge />);
  getToken.mockClear();
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("online"));
  expect(getToken).toHaveBeenCalledTimes(2);
  expect(getToken).toHaveBeenCalledWith({ skipCache: true });
  unmount();
  getToken.mockClear();
  window.dispatchEvent(new Event("online"));
  expect(getToken).not.toHaveBeenCalled();
});
