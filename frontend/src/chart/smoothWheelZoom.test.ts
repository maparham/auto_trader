// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  BAR_SPACE_MAX,
  attachSmoothWheelZoom,
  easeStep,
  wheelZoomFactor,
  type SmoothZoomChart,
} from "./smoothWheelZoom";

function fakeChart(bar = 8, zoomEnabled = true) {
  const state = { bar };
  const chart: SmoothZoomChart = {
    getBarSpace: () => ({ bar: state.bar }),
    zoomAtCoordinate: vi.fn((scale: number) => {
      const next = state.bar * scale;
      if (next >= 1 && next <= BAR_SPACE_MAX) state.bar = next;
    }),
    isZoomEnabled: () => zoomEnabled,
    getSize: (paneId?: string) =>
      paneId === "candle_pane" ? { width: 900, height: 500 } : { width: 950, height: 30 },
  };
  return { chart, state };
}

function setup(bar = 8, zoomEnabled = true) {
  const dom = document.createElement("div");
  dom.getBoundingClientRect = () => ({ left: 0, top: 0, width: 950, height: 600 }) as DOMRect;
  const { chart, state } = fakeChart(bar, zoomEnabled);
  const frames: FrameRequestCallback[] = [];
  let t = 0;
  const detach = attachSmoothWheelZoom(
    dom,
    () => chart,
    (cb) => frames.push(cb),
    () => {},
    () => t,
  );
  const flush = (n = 200) => {
    for (let i = 0; i < n && frames.length; i++) {
      t += 16;
      frames.shift()!(t);
    }
  };
  const wheel = (init: WheelEventInit) => {
    const e = new WheelEvent("wheel", { cancelable: true, bubbles: true, clientX: 400, clientY: 200, ...init });
    dom.dispatchEvent(e);
    return e;
  };
  return { dom, chart, state, frames, flush, wheel, detach };
}

describe("wheelZoomFactor", () => {
  it("is symmetric: in then out returns to the start", () => {
    expect(wheelZoomFactor(100, 0, 600) * wheelZoomFactor(-100, 0, 600)).toBeCloseTo(1);
  });
  it("zooms out on positive deltaY and scales line mode up", () => {
    expect(wheelZoomFactor(100, 0, 600)).toBeLessThan(1);
    expect(wheelZoomFactor(1, 1, 600)).toBeLessThan(wheelZoomFactor(1, 0, 600));
  });
});

describe("easeStep", () => {
  it("moves part way toward the target", () => {
    const v = easeStep(10, 20, 16);
    expect(v).toBeGreaterThan(10);
    expect(v).toBeLessThan(20);
  });
});

describe("attachSmoothWheelZoom", () => {
  it("glides over several frames to the target bar space", () => {
    const { state, frames, flush, wheel } = setup();
    const e = wheel({ deltaY: -100 });
    expect(e.defaultPrevented).toBe(true);
    expect(state.bar).toBe(8);
    flush(1);
    const first = state.bar;
    expect(first).toBeGreaterThan(8);
    expect(first).toBeLessThan(8 / wheelZoomFactor(100, 0, 600));
    flush();
    expect(frames.length).toBe(0);
    expect(state.bar).toBeCloseTo(8 * wheelZoomFactor(-100, 0, 600));
  });

  it("accumulates events onto the pending target", () => {
    const { state, flush, wheel } = setup();
    wheel({ deltaY: -100 });
    wheel({ deltaY: -100 });
    flush();
    expect(state.bar).toBeCloseTo(8 * wheelZoomFactor(-200, 0, 600));
  });

  it("clamps to the bar-space limit and terminates", () => {
    const { state, frames, flush, wheel } = setup(45);
    wheel({ deltaY: -5000 });
    flush();
    expect(frames.length).toBe(0);
    expect(state.bar).toBe(BAR_SPACE_MAX);
  });

  it("leaves axis strips, horizontal wheels and disabled zoom to klinecharts", () => {
    const { frames, wheel } = setup();
    expect(wheel({ deltaY: -100, clientX: 920 }).defaultPrevented).toBe(false); // price axis
    expect(wheel({ deltaY: -100, clientY: 590 }).defaultPrevented).toBe(false); // time axis
    expect(wheel({ deltaX: 50, deltaY: 10 }).defaultPrevented).toBe(false);
    expect(frames.length).toBe(0);
    const off = setup(8, false);
    expect(off.wheel({ deltaY: -100 }).defaultPrevented).toBe(false);
  });

  it("stands down when another zoom moves the chart mid-glide", () => {
    const { state, frames, flush, wheel } = setup();
    wheel({ deltaY: -300 });
    flush(2);
    state.bar = 20; // e.g. the time-axis double-click reset
    flush();
    expect(frames.length).toBe(0);
    expect(state.bar).toBe(20);
  });

  it("announces each glide frame on the chart element", () => {
    const { dom, flush, wheel } = setup();
    let n = 0;
    dom.addEventListener("chartkar:glide", () => n++);
    wheel({ deltaY: -100 });
    flush();
    expect(n).toBeGreaterThan(3);
  });

  it("stops intercepting after detach", () => {
    const { wheel, detach } = setup();
    detach();
    expect(wheel({ deltaY: -100 }).defaultPrevented).toBe(false);
  });
});
