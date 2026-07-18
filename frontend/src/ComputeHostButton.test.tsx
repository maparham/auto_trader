// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

const mockComputeHostState = vi.fn();
const mockStartComputeHost = vi.fn();
const mockStopComputeHost = vi.fn();

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    computeHostState: (...a: unknown[]) => mockComputeHostState(...a),
    startComputeHost: (...a: unknown[]) => mockStartComputeHost(...a),
    stopComputeHost: (...a: unknown[]) => mockStopComputeHost(...a),
  };
});

import ComputeHostButton from "./ComputeHostButton";
import {
  computeHostStateSignal,
  computeHostJobsSignal,
  sweepStateSignal,
  confirmRequest,
} from "./lib/signals";

// Drive the component through its own poll: the mocked computeHostState() return
// value is what the poll writes into the signal, so seed it per test.
function seed(state: string, activeJobs = 0) {
  mockComputeHostState.mockResolvedValue({ state, detail: null, activeJobs });
}

beforeEach(() => {
  computeHostStateSignal.set("unknown");
  computeHostJobsSignal.set(0);
  sweepStateSignal.set(null);
  confirmRequest.set(null);
  mockComputeHostState.mockReset();
  mockStartComputeHost.mockReset();
  mockStopComputeHost.mockReset();
  seed("unconfigured");
});

afterEach(() => cleanup());

describe("ComputeHostButton", () => {
  it("renders nothing when unconfigured", async () => {
    render(<ComputeHostButton />);
    await waitFor(() => expect(mockComputeHostState).toHaveBeenCalled());
    expect(screen.queryByText(/compute host/i)).toBeNull();
    expect(screen.queryByText(/host off/i)).toBeNull();
  });

  it("shows 'Host off' + Start when stopped, and Start calls startComputeHost", async () => {
    seed("stopped");
    mockStartComputeHost.mockResolvedValue({ state: "booting" });
    render(<ComputeHostButton />);
    const start = await screen.findByRole("button", { name: "Start" });
    expect(screen.getByText("Host off")).toBeTruthy();
    fireEvent.click(start);
    expect(mockStartComputeHost).toHaveBeenCalledOnce();
  });

  it("shows the loud ON pill + Stop when ready", async () => {
    seed("ready");
    render(<ComputeHostButton />);
    expect(await screen.findByText("Compute host ON")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  it("Stop asks for confirmation, then calls stopComputeHost on confirm", async () => {
    seed("ready");
    mockStopComputeHost.mockResolvedValue({ state: "stopped" });
    render(<ComputeHostButton />);
    const stop = await screen.findByRole("button", { name: "Stop" });
    fireEvent.click(stop);
    expect(mockStopComputeHost).not.toHaveBeenCalled();
    const req = confirmRequest.value;
    expect(req).toBeTruthy();
    expect(req!.message).toMatch(/stop the compute host/i);
    req!.onConfirm();
    await waitFor(() => expect(mockStopComputeHost).toHaveBeenCalledOnce());
  });

  it("warns that a running sweep will be cancelled", async () => {
    seed("ready");
    sweepStateSignal.set({ rows: [], done: 1, total: 4, running: true });
    render(<ComputeHostButton />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
    expect(confirmRequest.value!.message).toMatch(/cancel that run/i);
  });

  it("spinner while booting, no clickable button", async () => {
    seed("booting");
    render(<ComputeHostButton />);
    expect(await screen.findByText(/starting/i)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
