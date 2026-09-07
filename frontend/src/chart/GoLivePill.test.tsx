// @vitest-environment jsdom
// The "back to live" pill owns its own chart subscription + state so that a pan
// (whose every frame changes the "12h back" label) re-renders THIS tiny
// component, not the whole ChartCore cell tree with every legend under it.
import { describe, it, expect, vi, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";

afterEach(cleanup);

const { default: GoLivePill } = await import("./GoLivePill");

const MIN = 60_000;

function makeChart(opts: { behindMs: number }) {
  const subs = new Map<string, () => void>();
  // 10 one-minute bars; the visible right edge sits `behindMs` before the
  // newest bar (0 = at the live edge, where readLiveEdge returns null).
  const data = Array.from({ length: 10 }, (_, i) => ({ timestamp: i * MIN }));
  const state = { behindMs: opts.behindMs };
  return {
    state,
    fire: (name: string) => subs.get(name)?.(),
    chart: {
      getDataList: () => data,
      getVisibleRange: () => {
        const behindBars = Math.round(state.behindMs / MIN);
        const realTo = data.length - behindBars;
        return { from: 0, to: realTo, realFrom: 0, realTo };
      },
      getSize: (paneId: string) =>
        paneId === "candle_pane" ? { width: 60 } : { height: 20 },
      subscribeAction: (name: string, cb: () => void) => subs.set(name, cb),
      unsubscribeAction: (name: string) => subs.delete(name),
    } as unknown as import("klinecharts").Chart,
  };
}

function renderPill(h: ReturnType<typeof makeChart>, extra?: { detached?: boolean }) {
  const onGoLive = vi.fn();
  let parentRenders = 0;
  let bump: () => void = () => {};
  function Parent() {
    const [, setN] = useState(0);
    bump = () => setN((n) => n + 1);
    parentRenders++;
    return (
      <GoLivePill
        getChart={() => h.chart}
        detached={extra?.detached ?? false}
        pos="topRight"
        priceY={null}
        containerRef={{ current: null }}
        onGoLive={onGoLive}
      />
    );
  }
  const view = render(<Parent />);
  return { view, onGoLive, renders: () => parentRenders, bump };
}

describe("GoLivePill", () => {
  it("is hidden at the live edge and appears with the gap label after panning back", () => {
    const h = makeChart({ behindMs: 0 });
    renderPill(h);
    expect(screen.queryByTestId("chart-golive")).toBeNull();

    h.state.behindMs = 5 * MIN;
    act(() => h.fire("onVisibleRangeChange"));
    expect(screen.getByTestId("chart-golive").textContent).toContain("5m back");
  });

  it("updates its label without re-rendering the parent", () => {
    const h = makeChart({ behindMs: 3 * MIN });
    const { renders } = renderPill(h);
    const before = renders();
    h.state.behindMs = 7 * MIN;
    act(() => h.fire("onVisibleRangeChange"));
    expect(screen.getByTestId("chart-golive").textContent).toContain("7m back");
    expect(renders()).toBe(before);
  });

  it("renders nothing while detached, even with a gap", () => {
    const h = makeChart({ behindMs: 5 * MIN });
    renderPill(h, { detached: true });
    act(() => h.fire("onVisibleRangeChange"));
    expect(screen.queryByTestId("chart-golive")).toBeNull();
  });

  it("clicking the pill calls onGoLive", () => {
    const h = makeChart({ behindMs: 5 * MIN });
    const { onGoLive } = renderPill(h);
    act(() => h.fire("onVisibleRangeChange"));
    fireEvent.click(screen.getByTestId("chart-golive"));
    expect(onGoLive).toHaveBeenCalledTimes(1);
  });

  it("subscribes even when the chart is created after mount (parent-effect timing)", () => {
    // ChartCore creates the chart in ITS OWN effect, and React runs child
    // effects first — so at this component's mount getChart() returns null.
    // The subscription must attach once the chart exists.
    vi.useFakeTimers();
    try {
      const h = makeChart({ behindMs: 5 * MIN });
      let ready = false;
      const onGoLive = vi.fn();
      render(
        <GoLivePill
          getChart={() => (ready ? h.chart : null)}
          detached={false}
          pos="topRight"
          priceY={null}
          containerRef={{ current: null }}
          onGoLive={onGoLive}
        />,
      );
      ready = true;
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.getByTestId("chart-golive").textContent).toContain("5m back");
      h.state.behindMs = 7 * MIN;
      act(() => h.fire("onVisibleRangeChange"));
      expect(screen.getByTestId("chart-golive").textContent).toContain("7m back");
    } finally {
      vi.useRealTimers();
    }
  });

  it("survives a parent re-render without dropping the pill", () => {
    const h = makeChart({ behindMs: 5 * MIN });
    const { bump } = renderPill(h);
    act(() => h.fire("onVisibleRangeChange"));
    act(() => bump());
    expect(screen.getByTestId("chart-golive").textContent).toContain("5m back");
  });
});
