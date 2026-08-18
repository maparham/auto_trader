// @vitest-environment jsdom
//
// The backtest config panel is app-level: it survives entering a replay session
// and stays open beside a masked chart. Two of its controls act ON that chart,
// and both were blind to the session.
//
// Pick Range is the blindness leak. Arming it and dragging across the chart runs
// convertFromPixel on the bar under the cursor, which yields the bar's REAL
// epoch; the result lands in two datetime-local inputs. The axis beside them
// reads "Day 3 09:30" while the fields would read the true calendar date and
// time, with the session still running and resumable (and it persists through
// saveBacktestLastUsed).
//
// Run backtest is the other: see BacktestButton.replay.test.tsx for what a run
// does to a replaying chart. Here we only assert the control refuses and says
// why, which is the half a user sees.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { installMemStorage } from "./lib/testMemStorage";

installMemStorage();

vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));
vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    fetchStrategies: vi.fn().mockResolvedValue([]),
    computeStatus: vi.fn().mockResolvedValue({ remoteConfigured: false }),
    computeHostState: vi.fn().mockResolvedValue({ state: "unconfigured", detail: null }),
    getCostProfile: vi.fn().mockResolvedValue(null),
  };
});

import BacktestSettingsModal from "./BacktestSettingsModal";
import { defaultBacktestConfig } from "./lib/backtestConfig";
import { Signal } from "./lib/signals";
import { ChartController } from "./lib/chartController";

function controllerFor(replaying: boolean): ChartController {
  const c = new ChartController("cell-1", "scope-1");
  c.replaying.set(replaying);
  return c;
}

function renderModal(controller: ChartController) {
  return render(
    <BacktestSettingsModal
      initial={defaultBacktestConfig()}
      epic="TEST"
      brokerId="capital"
      resolution="MINUTE"
      controller={controller}
      chartTimezone="UTC"
      onRun={vi.fn()}
      onClose={vi.fn()}
    />,
  );
}

const pickButtons = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>(".bt-pick-range"));

afterEach(cleanup);

describe("Pick Range while the focused cell is REPLAYING", () => {
  it("is disabled on EVERY range picker in the panel", () => {
    renderModal(controllerFor(true));
    const buttons = pickButtons();
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((b) => b.disabled)).toBe(true);
  });

  it("stays enabled on a live cell", () => {
    renderModal(controllerFor(false));
    const buttons = pickButtons();
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((b) => b.disabled)).toBe(false);
  });

  it("cannot arm the chart even if the click gets through", () => {
    const controller = controllerFor(true);
    renderModal(controller);
    fireEvent.click(pickButtons()[0]);
    expect(controller.rangePickArmed.value).toBe(false);
  });

  it("explains the refusal rather than looking broken", () => {
    renderModal(controllerFor(true));
    fireEvent.focus(pickButtons()[0].parentElement!); // the shared Tooltip trigger
    expect(screen.getByRole("tooltip").textContent ?? "").toMatch(/replay/i);
  });

  it("ignores a range the chart publishes anyway", () => {
    // Belt at the consumer: a result already in flight when the session starts
    // must not reach the From/To fields.
    const controller = controllerFor(true);
    renderModal(controller);
    const dates = () =>
      Array.from(document.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]')).map(
        (i) => i.value,
      );
    expect(dates().length).toBeGreaterThan(0); // the fields are on screen to leak into
    const before = dates();
    act(() => {
      controller.rangePickResult.set({ fromMs: Date.UTC(2021, 4, 17), toMs: Date.UTC(2021, 4, 18) });
    });
    expect(dates()).toEqual(before);
    expect(dates().some((v) => v.includes("2021-05-17"))).toBe(false);
  });
});

describe("Run backtest while the focused cell is REPLAYING", () => {
  const runButton = () =>
    screen.getAllByRole("button").find((b) => /run backtest/i.test(b.textContent ?? ""));

  it("is disabled, and says why", () => {
    renderModal(controllerFor(true));
    const btn = runButton();
    expect(btn).toBeTruthy();
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.focus((btn as HTMLElement).parentElement!);
    expect(screen.getByRole("tooltip").textContent ?? "").toMatch(/replay/i);
  });

  it("stays enabled on a live cell", () => {
    renderModal(controllerFor(false));
    expect((runButton() as HTMLButtonElement).disabled).toBe(false);
  });
});

// Guard against the stub drifting from the real class.
describe("ChartController.replaying", () => {
  it("defaults to false and is observable", () => {
    const c = new ChartController("cell-2", "scope-2");
    expect(c.replaying).toBeInstanceOf(Signal);
    expect(c.replaying.value).toBe(false);
    const seen: boolean[] = [];
    c.replaying.subscribe((v) => seen.push(v));
    c.replaying.set(true);
    expect(seen).toEqual([true]);
  });
});
