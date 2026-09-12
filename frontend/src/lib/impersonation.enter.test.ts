// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { installMemStorage } from "./testMemStorage";

installMemStorage();

import {
  enterImpersonation,
  exitImpersonation,
  impersonatedEmail,
  impersonatedUserId,
} from "./impersonation";

const reload = vi.fn();

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  reload.mockClear();
  vi.stubGlobal("location", { assign: reload, href: "/" });
  localStorage.setItem("auto-trader.b.capital.layouts", "[1]");
  localStorage.setItem("auto-trader.lastUserId", "user_admin");
  localStorage.setItem("unrelated.key", "1");
});

it("entering wipes the workspace, stores the target, and reloads to /", () => {
  enterImpersonation("user_target", "target@example.com");
  expect(localStorage.getItem("auto-trader.b.capital.layouts")).toBeNull();
  expect(localStorage.getItem("unrelated.key")).toBe("1");
  expect(impersonatedUserId()).toBe("user_target");
  expect(impersonatedEmail()).toBe("target@example.com");
  expect(reload).toHaveBeenCalledWith("/");
});

it("exiting wipes the workspace, clears the target, and reloads to /admin", () => {
  enterImpersonation("user_target", "target@example.com");
  localStorage.setItem("auto-trader.b.capital.layouts", "[2]");
  reload.mockClear();
  exitImpersonation();
  expect(localStorage.getItem("auto-trader.b.capital.layouts")).toBeNull();
  expect(impersonatedUserId()).toBeNull();
  expect(impersonatedEmail()).toBeNull();
  expect(reload).toHaveBeenCalledWith("/admin");
});
