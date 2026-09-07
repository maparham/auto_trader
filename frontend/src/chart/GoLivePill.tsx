// "Back to live" pill: shown only while the newest bar is off-screen, so a long
// pan back through history always has a one-click way home.
//
// A separate component ON PURPOSE: its label ("12h back") changes on nearly
// every frame of a pan, and when this state lived in ChartCore each change
// committed the whole cell tree — every legend, every pill — for a one-word
// label. Owning the subscription + state here keeps a pan's re-renders scoped
// to this button.
import { useEffect, useState, type RefObject } from "react";
import type { Chart } from "klinecharts";
import Tooltip from "../components/Tooltip";
import { goLivePillStyle, readLiveEdge, type GoLivePillPos } from "../lib/liveEdge";

interface Props {
  getChart: () => Chart | null;
  /** A detached view is pinned to a jump target with no live edge to return
   * to; the DetachedPill owns the one honest way back. */
  detached: boolean;
  pos: GoLivePillPos;
  /** Last-price line y (priceLine placement rides it), null with no data. */
  priceY: number | null;
  containerRef: RefObject<HTMLDivElement | null>;
  onGoLive: () => void;
}

export default function GoLivePill({ getChart, detached, pos, priceY, containerRef, onGoLive }: Props) {
  const [edge, setEdge] = useState<{
    label: string;
    right: number;
    bottom: number;
    height: number;
  } | null>(null);

  // onVisibleRangeChange (not onScroll/onZoom) is the subscription that
  // matters: klinecharts fires it from the range recompute itself, so
  // PROGRAMMATIC moves — the jump, a quick-range pick, a TF switch — update
  // the pill too, where a scroll action would leave it stale showing.
  useEffect(() => {
    // ChartCore creates the chart in ITS OWN mount effect, and React runs
    // child effects before parent effects — so getChart() is still null when
    // this runs on first mount. Retry until it exists (in practice the very
    // first timeout: the parent effect runs in the same commit).
    let chart: Chart | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (!chart) return;
      const label = readLiveEdge(chart);
      const right = (chart.getSize("candle_pane", "yAxis")?.width ?? 0) + 10;
      const bottom = (chart.getSize("x_axis_pane", "root")?.height ?? 0) + 10;
      // Cell height only matters for priceLine mode's clamp; snapshotting it
      // here (any resize re-lays-out the chart and refires this) keeps the
      // render free of ref reads.
      const height = containerRef.current?.clientHeight ?? 0;
      // Same object identity while nothing moved: onVisibleRangeChange fires on
      // every frame of a drag, and a fresh object each time would re-render on
      // every frame of the gesture.
      setEdge((prev) =>
        label == null
          ? null
          : prev &&
              prev.label === label &&
              prev.right === right &&
              prev.bottom === bottom &&
              prev.height === height
            ? prev
            : { label, right, bottom, height },
      );
    };
    const attach = () => {
      chart = getChart();
      if (!chart) {
        retry = setTimeout(attach, 50);
        return;
      }
      refresh();
      chart.subscribeAction("onVisibleRangeChange", refresh);
    };
    attach();
    return () => {
      if (retry != null) clearTimeout(retry);
      chart?.unsubscribeAction("onVisibleRangeChange", refresh);
    };
    // getChart is a stable accessor (same idiom as ChartLegend's).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!edge || detached) return null;
  return (
    <Tooltip content="Jump to the latest bar" placement="left">
      <button
        type="button"
        className="chart-golive"
        data-testid="chart-golive"
        // Placement is a global setting (lib/liveEdge.goLivePillStyle). The
        // priceLine mode rides priceTag.y, which the redraw loop refreshes
        // on every tick — so the pill follows the line without its own
        // subscription.
        style={goLivePillStyle(pos, {
          right: edge.right,
          bottom: edge.bottom,
          priceY,
          height: edge.height,
        })}
        onClick={onGoLive}
      >
        <span className="chart-golive-label">{edge.label}</span>
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
             strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m5 4 9 8-9 8z" /><line x1="19" y1="4" x2="19" y2="20" />
        </svg>
      </button>
    </Tooltip>
  );
}
