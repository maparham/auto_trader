// @vitest-environment jsdom
//
// The webview side of the shell handoff: consume ?__clerk_ticket exactly once
// (it is single-use, so Clerk's own card must never also see it), fall back to
// the normal card on failure, and offer the browser handoff button only when
// running inside the shell.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const { signInCreate, setActive } = vi.hoisted(() => ({
  signInCreate: vi.fn(),
  setActive: vi.fn(),
}));

vi.mock("@clerk/clerk-react", () => ({
  SignIn: () => <div data-testid="clerk-card" />,
  useSignIn: () => ({
    isLoaded: true,
    signIn: { create: signInCreate },
    setActive,
  }),
}));

import ShellTicketSignIn from "./ShellTicketSignIn";

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  signInCreate.mockReset();
  setActive.mockReset();
  delete (window as unknown as Record<string, unknown>).__TAURI__;
  vi.unstubAllGlobals();
});

const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36";

function androidApp(invoke: (...a: unknown[]) => Promise<unknown>) {
  vi.stubGlobal("navigator", { ...navigator, userAgent: ANDROID_UA });
  (window as unknown as Record<string, unknown>).__TAURI__ = { core: { invoke } };
}

it("consumes a ticket, activates the session, and strips the param", async () => {
  window.history.replaceState(null, "", "/?__clerk_ticket=sit_abc");
  signInCreate.mockResolvedValue({ status: "complete", createdSessionId: "sess_1" });
  const { queryByTestId, getByText } = render(<ShellTicketSignIn />);
  getByText("Signing you in...");
  expect(queryByTestId("clerk-card")).toBeNull();
  await waitFor(() => expect(setActive).toHaveBeenCalledWith({ session: "sess_1" }));
  expect(signInCreate).toHaveBeenCalledWith({ strategy: "ticket", ticket: "sit_abc" });
  expect(window.location.search).not.toContain("__clerk_ticket");
});

it("falls back to the Clerk card when the ticket is rejected", async () => {
  window.history.replaceState(null, "", "/?__clerk_ticket=sit_bad");
  signInCreate.mockRejectedValue(new Error("expired"));
  const { findByTestId } = render(<ShellTicketSignIn />);
  await findByTestId("clerk-card");
  expect(setActive).not.toHaveBeenCalled();
  expect(window.location.search).not.toContain("__clerk_ticket");
});

it("shows the browser button only inside the shell, and it invokes browser_sign_in", async () => {
  const invoke = vi.fn(async () => 49213);
  const { queryByText, unmount } = render(<ShellTicketSignIn />);
  expect(queryByText("Sign in with your browser")).toBeNull();
  unmount();
  (window as unknown as Record<string, unknown>).__TAURI__ = { core: { invoke } };
  const { getByText } = render(<ShellTicketSignIn />);
  fireEvent.click(getByText("Sign in with your browser"));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("browser_sign_in", undefined));
});

it("reports a failed browser_sign_in next to the button", async () => {
  (window as unknown as Record<string, unknown>).__TAURI__ = {
    core: { invoke: vi.fn(async () => Promise.reject(new Error("bind"))) },
  };
  const { getByText, findByText } = render(<ShellTicketSignIn />);
  fireEvent.click(getByText("Sign in with your browser"));
  await findByText(/Could not start browser sign-in/);
});

it("Android: hides the Clerk card and treats a true reply as success", async () => {
  const invoke = vi.fn(async () => true);
  androidApp(invoke);
  const { queryByTestId, getByText, queryByText } = render(<ShellTicketSignIn />);
  expect(queryByTestId("clerk-card")).toBeNull();
  fireEvent.click(getByText("Sign in with your browser"));
  await waitFor(() => expect(invoke).toHaveBeenCalled());
  expect(queryByText(/Could not start browser sign-in/)).toBeNull();
  vi.unstubAllGlobals();
});

it("Android: shows the expired message from ?auth_error=expired and strips it", () => {
  androidApp(vi.fn(async () => true));
  window.history.replaceState(null, "", "/?auth_error=expired");
  const { getByText } = render(<ShellTicketSignIn />);
  getByText("Sign-in expired, try again.");
  expect(window.location.search).not.toContain("auth_error");
  vi.unstubAllGlobals();
});

it("desktop shell keeps the Clerk card", () => {
  (window as unknown as Record<string, unknown>).__TAURI__ = { core: { invoke: vi.fn(async () => 1) } };
  const { getByTestId } = render(<ShellTicketSignIn />);
  getByTestId("clerk-card");
});
