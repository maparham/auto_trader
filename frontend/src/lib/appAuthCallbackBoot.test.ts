import { expect, it } from "vitest";
import { shouldBootAppAuthCallback } from "./appAuthCallbackBoot";

it("matches the callback path with or without a trailing slash", () => {
  expect(shouldBootAppAuthCallback("/app-auth/callback")).toBe(true);
  expect(shouldBootAppAuthCallback("/app-auth/callback/")).toBe(true);
  expect(shouldBootAppAuthCallback("/")).toBe(false);
  expect(shouldBootAppAuthCallback("/app-auth")).toBe(false);
});
