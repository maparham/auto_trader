// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { installMemStorage } from "../lib/testMemStorage";
import AdminApp from "./AdminApp";
import * as api from "./api";

// jsdom in this vitest configuration has no working Storage API; the shared
// mock is what the other component tests use.
installMemStorage();

function stubPanels() {
  vi.spyOn(api, "fetchUsers").mockResolvedValue({
    configured: true,
    users: [
      {
        id: "user_1",
        email: "boss@example.com",
        firstName: "Ada",
        lastName: null,
        imageUrl: null,
        createdAt: 1700000000000,
        lastActiveAt: 1800000000000,
        lastSignInAt: null,
        banned: false,
        locked: false,
      },
    ],
    total: 1,
    error: null,
  });
  vi.spyOn(api, "fetchHealth").mockResolvedValue({
    process: { uptimeSeconds: 12, pid: 7, hostedMode: true },
    idleSeconds: 3,
    feeds: [],
    alerts: { armed: 0, feeds: 0 },
    brokers: { registered: ["dukascopy"], restricted: ["capital"], default: "dukascopy" },
    databases: [{ name: "app_state", path: "app_state.db", exists: true, bytes: 10 }],
    disk: { path: ".", totalBytes: 100, freeBytes: 50 },
    snapshot: { enabled: true, frontendUrl: null },
  });
  vi.spyOn(api, "fetchUsage").mockResolvedValue({ users: [] });
  vi.spyOn(api, "fetchLogs").mockResolvedValue({ records: [], capacity: 500 });
}

describe("AdminApp", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    // vitest runs without globals, so RTL's auto-cleanup is not wired up.
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("renders the denial state when whoami is 403", async () => {
    vi.spyOn(api, "fetchWhoami").mockRejectedValue(
      new api.AdminHttpError(403, "admin access required"),
    );
    render(<AdminApp />);
    expect(await screen.findByText(/do not have admin access/i)).toBeTruthy();
  });

  it("renders the panels for an admin", async () => {
    vi.spyOn(api, "fetchWhoami").mockResolvedValue({
      userId: "user_1",
      email: "boss@example.com",
      isAdmin: true,
      hostedMode: true,
    });
    stubPanels();
    render(<AdminApp />);
    await waitFor(() => expect(screen.getAllByText(/boss@example.com/).length).toBeGreaterThan(0));
    expect(screen.getByRole("heading", { name: /users/i })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /health/i })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /usage/i })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /logs/i })).toBeTruthy();
  });

  it("stamps the app's theme on the document", async () => {
    // The console renders outside <App>; without this it would show index.css's
    // dark default while the app itself is in light mode.
    localStorage.setItem("auto-trader.settings", JSON.stringify({ theme: "light" }));
    vi.spyOn(api, "fetchWhoami").mockResolvedValue({
      userId: "u", email: null, isAdmin: true, hostedMode: true,
    });
    stubPanels();
    render(<AdminApp />);
    await waitFor(() =>
      expect(document.documentElement.dataset.theme).toBe("light"),
    );
    localStorage.clear();
  });

  it("shows a load error without blanking the page", async () => {
    vi.spyOn(api, "fetchWhoami").mockResolvedValue({
      userId: "user_1",
      email: null,
      isAdmin: true,
      hostedMode: false,
    });
    stubPanels();
    vi.spyOn(api, "fetchUsers").mockRejectedValue(new Error("network down"));
    render(<AdminApp />);
    expect(await screen.findByText(/network down/i)).toBeTruthy();
    expect(screen.getByRole("heading", { name: /health/i })).toBeTruthy();
  });
});
