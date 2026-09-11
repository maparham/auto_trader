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
});

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
