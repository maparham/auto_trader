// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import UsagePanel from "./UsagePanel";
import * as api from "./api";
import type { ClerkUser, UsageRow } from "./api";

const ROWS: UsageRow[] = [
  { userId: "user_1", stateRows: 3, stateBytes: 300, runs: 5, sweeps: 1, wfo: 0,
    alerts: 2, triggered: 7, costProfiles: 0, patternPresets: 1, lastSeen: 2000 },
  { userId: "user_2", stateRows: 1, stateBytes: 100, runs: 9, sweeps: 0, wfo: 0,
    alerts: 0, triggered: 0, costProfiles: 0, patternPresets: 0, lastSeen: 1000 },
];

const CLERK: ClerkUser[] = [
  { id: "user_1", email: "ada@example.com", firstName: null, lastName: null,
    imageUrl: null, createdAt: null, lastActiveAt: null, lastSignInAt: null,
    banned: false, locked: false },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("UsagePanel", () => {
  it("joins rows to Clerk emails and falls back to the raw id", async () => {
    vi.spyOn(api, "fetchUsage").mockResolvedValue({ users: ROWS });
    render(<UsagePanel refreshKey={0} users={CLERK} />);
    await waitFor(() => expect(screen.getByText("ada@example.com")).toBeTruthy());
    expect(screen.getByText("user_2")).toBeTruthy();
  });

  it("renders the error state", async () => {
    vi.spyOn(api, "fetchUsage").mockRejectedValue(new Error("usage blew up"));
    render(<UsagePanel refreshKey={0} users={[]} />);
    expect(await screen.findByText(/usage blew up/)).toBeTruthy();
  });

  it("sorts by a clicked column", async () => {
    vi.spyOn(api, "fetchUsage").mockResolvedValue({ users: ROWS });
    render(<UsagePanel refreshKey={0} users={[]} />);
    await waitFor(() => expect(screen.getByText("user_1")).toBeTruthy());
    await userEvent.click(screen.getByRole("columnheader", { name: /runs/i }));
    const ids = screen.getAllByTestId("usage-user").map((el) => el.textContent);
    expect(ids[0]).toContain("user_2"); // 9 runs sorts above 5
  });
});
