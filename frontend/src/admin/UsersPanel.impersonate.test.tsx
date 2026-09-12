// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installMemStorage } from "../lib/testMemStorage";

installMemStorage();

const api = vi.hoisted(() => ({
  fetchUsers: vi.fn(),
  startImpersonation: vi.fn(),
}));
vi.mock("./api", async (orig) => ({
  ...(await orig<typeof import("./api")>()),
  fetchUsers: api.fetchUsers,
  startImpersonation: api.startImpersonation,
}));

const entered = vi.hoisted(() => vi.fn());
vi.mock("../lib/impersonation", async (orig) => ({
  ...(await orig<typeof import("../lib/impersonation")>()),
  enterImpersonation: entered,
}));

import UsersPanel from "./UsersPanel";

const USER = {
  id: "user_target",
  email: "target@example.com",
  firstName: "Tara",
  lastName: "Get",
  imageUrl: null,
  createdAt: 0,
  lastActiveAt: 0,
  lastSignInAt: 0,
  banned: false,
  locked: false,
};

beforeEach(() => {
  entered.mockClear();
  api.fetchUsers.mockReset();
  api.startImpersonation.mockReset();
  api.fetchUsers.mockResolvedValue({
    configured: true,
    users: [USER],
    total: 1,
    error: null,
  });
  api.startImpersonation.mockResolvedValue({
    user: { ...USER, id: "user_confirmed", email: "confirmed@example.com" },
  });
  vi.stubGlobal("confirm", () => true);
});

afterEach(cleanup);

it("enters impersonation after the endpoint confirms the target", async () => {
  render(<UsersPanel refreshKey={0} onUsers={() => {}} />);
  const button = await screen.findByRole("button", { name: /view as/i });
  fireEvent.click(button);
  // The mock resolves with a DIFFERENT user than the clicked row, so this
  // only passes if the handler uses the endpoint's response (res.user), not
  // the row it was called with. A handler that ignored the response and
  // called enterImpersonation(user.id, user.email) would fail this.
  await waitFor(() =>
    expect(entered).toHaveBeenCalledWith("user_confirmed", "confirmed@example.com"),
  );
});

it("does nothing when the confirm is declined", async () => {
  vi.stubGlobal("confirm", () => false);
  render(<UsersPanel refreshKey={0} onUsers={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: /view as/i }));
  await waitFor(() => expect(api.startImpersonation).not.toHaveBeenCalled());
  expect(entered).not.toHaveBeenCalled();
});

it("shows the error and stays put when the endpoint rejects", async () => {
  api.startImpersonation.mockRejectedValue(new Error("no such user"));
  render(<UsersPanel refreshKey={0} onUsers={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: /view as/i }));
  expect(await screen.findByText(/no such user/)).toBeDefined();
  expect(entered).not.toHaveBeenCalled();
});
