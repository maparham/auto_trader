// @vitest-environment jsdom
//
// On a shared browser, user B signing in after user A must not inherit A's
// device-local state (activeLayoutId/scratch/autosave survive the hosted
// hydrate by design). The gate wipes ALL auto-trader.* keys when the Clerk
// user id differs from the one stamped on this browser — before children
// (and the persist hydrate they trigger) ever mount.
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { installMemStorage } from "../lib/testMemStorage";

// jsdom in this vitest configuration does not provide a working Storage API
// implementation. Use the shared MemStorage mock, consistent with other
// component tests that need localStorage (BacktestButton, HistoryControls, etc).
installMemStorage();

const clerk = vi.hoisted(() => ({ userId: "user_a" }));
vi.mock("@clerk/clerk-react", () => ({
  useUser: () => ({ isLoaded: true, user: { id: clerk.userId } }),
}));

import AccountGate from "./AccountGate";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const seed = () => {
  localStorage.setItem("auto-trader.b.capital.layouts", "[1]");
  localStorage.setItem("auto-trader.b.capital.activeLayoutId", '"x"'); // device-local
  localStorage.setItem("unrelated.key", "1");
};

it("same user: renders children, keys intact", () => {
  seed();
  localStorage.setItem("auto-trader.lastUserId", "user_a");
  render(<AccountGate><div data-testid="app" /></AccountGate>);
  expect(screen.getByTestId("app")).toBeDefined();
  expect(localStorage.getItem("auto-trader.b.capital.activeLayoutId")).toBe('"x"');
});

it("different user: wipes every auto-trader.* key (device-local included) and stamps the new id", () => {
  seed();
  localStorage.setItem("auto-trader.lastUserId", "user_b");
  render(<AccountGate><div data-testid="app" /></AccountGate>);
  expect(screen.getByTestId("app")).toBeDefined();
  expect(localStorage.getItem("auto-trader.b.capital.layouts")).toBeNull();
  expect(localStorage.getItem("auto-trader.b.capital.activeLayoutId")).toBeNull();
  expect(localStorage.getItem("unrelated.key")).toBe("1");
  expect(localStorage.getItem("auto-trader.lastUserId")).toBe("user_a");
});

it("first sign-in on this browser (no stamp): wipes and stamps", () => {
  seed();
  render(<AccountGate><div data-testid="app" /></AccountGate>);
  expect(localStorage.getItem("auto-trader.b.capital.layouts")).toBeNull();
  expect(localStorage.getItem("auto-trader.lastUserId")).toBe("user_a");
});
