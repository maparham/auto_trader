// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { PAN_MAX_SPEED, attachPanMomentum, releaseVelocity, type PanMomentumChart } from "./panMomentum";

function setup() {
  const dom = document.createElement("div");
  document.body.appendChild(dom);
  let onScroll: (() => void) | null = null;
  const chart = {
    scrollByDistance: vi.fn((_d: number) => onScroll?.()),
    isScrollEnabled: () => true,
    subscribeAction: (_: string, cb: () => void) => {
      onScroll = cb;
    },
    unsubscribeAction: () => {
      onScroll = null;
    },
  } satisfies PanMomentumChart;
  const frames: FrameRequestCallback[] = [];
  let t = 0;
  const detach = attachPanMomentum(dom, chart, (cb) => frames.push(cb), () => {}, () => t);
  const ptr = (type: string, x: number, target: EventTarget = dom) =>
    target.dispatchEvent(new MouseEvent(type, { clientX: x, bubbles: true }) as unknown as PointerEvent);
  // A drag of `n` moves of `step` px every 10ms; `pans` makes klinecharts scroll.
  const drag = (n: number, step: number, pans = true) => {
    ptr("pointerdown", 100);
    for (let i = 1; i <= n; i++) {
      t += 10;
      ptr("pointermove", 100 + i * step);
      if (pans) onScroll?.();
    }
  };
  const flush = (max = 500) => {
    let n = 0;
    while (frames.length && n++ < max) {
      t += 16;
      frames.shift()!(t);
    }
    return n;
  };
  return { dom, chart, frames, ptr, drag, flush, detach, advance: (ms: number) => (t += ms) };
}

describe("releaseVelocity", () => {
  it("reads px/ms over the last samples and caps a flick", () => {
    expect(releaseVelocity([{ t: 0, x: 0 }, { t: 50, x: 50 }], 50)).toBeCloseTo(1);
    expect(releaseVelocity([{ t: 0, x: 0 }, { t: 10, x: 500 }], 10)).toBe(PAN_MAX_SPEED);
  });
  it("is zero when the pointer had stopped before release", () => {
    expect(releaseVelocity([{ t: 0, x: 0 }, { t: 50, x: 50 }], 200)).toBe(0);
  });
});

describe("attachPanMomentum", () => {
  it("glides in the drag direction after a fast pan and decays to a stop", () => {
    const { chart, frames, ptr, drag, flush } = setup();
    drag(8, 10);
    ptr("pointerup", 180, window);
    expect(frames.length).toBe(1);
    const frameCount = flush();
    expect(frames.length).toBe(0);
    expect(frameCount).toBeGreaterThan(10);
    const dists = chart.scrollByDistance.mock.calls.map((c) => c[0]);
    expect(dists.every((d) => d > 0)).toBe(true);
    expect(dists[dists.length - 1]).toBeLessThan(dists[0]);
  });

  it("announces each glide frame on the chart element", () => {
    const { dom, ptr, drag, flush } = setup();
    let n = 0;
    dom.addEventListener("chartkar:glide", () => n++);
    drag(8, 10);
    ptr("pointerup", 180, window);
    expect(flush()).toBeGreaterThan(0);
    expect(n).toBeGreaterThan(10);
  });

  it("does nothing for a press that never scrolled the chart", () => {
    const { frames, ptr, drag } = setup();
    drag(8, 10, false);
    ptr("pointerup", 180, window);
    expect(frames.length).toBe(0);
  });

  it("does nothing when the drag stopped before release", () => {
    const { frames, ptr, drag, advance } = setup();
    drag(8, 10);
    advance(200);
    ptr("pointerup", 180, window);
    expect(frames.length).toBe(0);
  });

  it("a new press stops the glide", () => {
    const { chart, ptr, drag, flush } = setup();
    drag(8, 10);
    ptr("pointerup", 180, window);
    ptr("pointerdown", 180);
    const calls = chart.scrollByDistance.mock.calls.length;
    flush();
    expect(chart.scrollByDistance.mock.calls.length).toBe(calls);
  });
});
