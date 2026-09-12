// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { installMemStorage } from "./testMemStorage";

installMemStorage();

import {
  impersonatedUserId,
  isImpersonating,
  setImpersonatedUserId,
  withImpersonation,
} from "./impersonation";

beforeEach(() => {
  sessionStorage.clear();
});

it("reports nothing when the flag is unset", () => {
  expect(impersonatedUserId()).toBeNull();
  expect(isImpersonating()).toBe(false);
});

it("round-trips the target through sessionStorage", () => {
  setImpersonatedUserId("user_target");
  expect(impersonatedUserId()).toBe("user_target");
  expect(isImpersonating()).toBe(true);
});

it("clears the target on null", () => {
  setImpersonatedUserId("user_target");
  setImpersonatedUserId(null);
  expect(impersonatedUserId()).toBeNull();
});

it("treats a blank stored value as not impersonating", () => {
  sessionStorage.setItem("auto-trader.impersonateUserId", "   ");
  expect(isImpersonating()).toBe(false);
});

it("appends the param with ? when the url has no query", () => {
  setImpersonatedUserId("user_target");
  expect(withImpersonation("ws://x/ws/state")).toBe(
    "ws://x/ws/state?impersonate=user_target",
  );
});

it("appends the param with & when the url already has a query", () => {
  setImpersonatedUserId("user_target");
  expect(withImpersonation("ws://x/ws/candles?epic=US100")).toBe(
    "ws://x/ws/candles?epic=US100&impersonate=user_target",
  );
});

it("leaves the url alone when not impersonating", () => {
  expect(withImpersonation("ws://x/ws/state")).toBe("ws://x/ws/state");
});

it("encodes the target", () => {
  setImpersonatedUserId("user a/b");
  expect(withImpersonation("ws://x/ws/state")).toBe(
    "ws://x/ws/state?impersonate=user%20a%2Fb",
  );
});
