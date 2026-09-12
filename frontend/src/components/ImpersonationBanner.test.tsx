// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { installMemStorage } from "../lib/testMemStorage";

installMemStorage();

import { setImpersonatedUserId } from "../lib/impersonation";
import ImpersonationBanner from "./ImpersonationBanner";

const assign = vi.fn();

beforeEach(() => {
  sessionStorage.clear();
  assign.mockClear();
  vi.stubGlobal("location", { assign, href: "/" });
});

afterEach(() => {
  cleanup();
  setImpersonatedUserId(null);
});

it("renders nothing when not impersonating", () => {
  const { container } = render(<ImpersonationBanner />);
  expect(container.firstChild).toBeNull();
});

it("names the impersonated user and says it is read-only", () => {
  setImpersonatedUserId("user_target");
  sessionStorage.setItem("auto-trader.impersonateEmail", "target@example.com");
  render(<ImpersonationBanner />);
  expect(screen.getByText(/target@example.com/)).toBeDefined();
  expect(screen.getByText(/read-only/i)).toBeDefined();
});

it("falls back to the user id when no email is stored", () => {
  setImpersonatedUserId("user_target");
  render(<ImpersonationBanner />);
  expect(screen.getByText(/user_target/)).toBeDefined();
});

it("exits on click", () => {
  setImpersonatedUserId("user_target");
  render(<ImpersonationBanner />);
  fireEvent.click(screen.getByRole("button", { name: /exit/i }));
  expect(assign).toHaveBeenCalledWith("/admin");
});
