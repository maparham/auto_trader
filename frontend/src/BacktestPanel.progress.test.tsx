// @vitest-environment jsdom
// The empty state's running line: with live progress in hand it names the
// phase, percentage and ETA; without it, the static "Backtest running…" text.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { installMemStorage } from "./lib/testMemStorage";

// jsdom's localStorage isn't wired up in this project's vitest config (see
// BacktestSettingsModal.test.tsx); persist must load against a stand-in.
installMemStorage();

import {
  backtestProgressSignal,
  backtestRunningSignal,
  backtestResultSignal,
} from "./lib/signals";
import BacktestPanel from "./BacktestPanel";

describe("BacktestPanel progress line", () => {
  afterEach(() => {
    cleanup();
    backtestRunningSignal.set(false);
    backtestProgressSignal.set(null);
    backtestResultSignal.set(null);
  });

  it("shows download progress while running", () => {
    backtestRunningSignal.set(true);
    backtestProgressSignal.set({
      phase: "download", label: "dukascopy/US100/MINUTE_5/bid", pct: 21, etaS: 186,
    });
    render(<BacktestPanel />);
    expect(screen.getByText(/Downloading dukascopy\/US100\/MINUTE_5\/bid \(21%, ~3m left\)/)).toBeTruthy();
  });

  it("shows simulate progress", () => {
    backtestRunningSignal.set(true);
    backtestProgressSignal.set({ phase: "simulate", label: "Simulating", pct: 64, etaS: null });
    render(<BacktestPanel />);
    expect(screen.getByText(/Simulating \(64%\)/)).toBeTruthy();
  });

  it("renders the poller's per-pass label as-is (extra engine passes)", () => {
    backtestRunningSignal.set(true);
    backtestProgressSignal.set({ phase: "simulate", label: "Running cost sensitivity", pct: 40, etaS: null });
    render(<BacktestPanel />);
    expect(screen.getByText(/Running cost sensitivity \(40%\)/)).toBeTruthy();
  });

  it("falls back to the static line without progress info", () => {
    backtestRunningSignal.set(true);
    render(<BacktestPanel />);
    expect(screen.getByText("Backtest running…")).toBeTruthy();
  });
});
