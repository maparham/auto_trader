// Which pointer gestures over the price-axis column are a MANUAL y-scale.
//
// klinecharts owns the scaling itself; this module owns the app's mirror of it,
// so the toolbar "A" (the autoScale signal) tracks the axis's real mode. When
// the mirror misses a gesture the chart silently sticks at a hand-set vertical
// scale (candles squeezed into a band) while "A" still claims auto — with no
// cue that a double-click on the axis is the way out.

/** Candle-pane geometry the gesture tests need, in viewport pixels. */
export interface PriceAxisGeometry {
  /** Left edge of the chart container (getBoundingClientRect().left). */
  left: number;
  /** Width of the candle pane's main (candles) area — the axis starts after it. */
  mainWidth: number;
}

/** Wheel fields the scale test reads (a real WheelEvent satisfies this). */
export interface WheelDelta {
  clientX: number;
  deltaX: number;
  deltaY: number;
}

/**
 * True when `clientX` falls in the price-axis strip right of the candle pane's
 * main area. A zero mainWidth means the chart has not been laid out yet, which
 * would otherwise make the whole cell read as "axis".
 */
export function isOverPriceAxis(clientX: number, { left, mainWidth }: PriceAxisGeometry): boolean {
  if (!mainWidth) return false;
  return clientX - left > mainWidth;
}

/**
 * True when a wheel event will scale the price axis (not scroll/zoom time).
 *
 * Mirrors klinecharts' own dispatch (EventHandlerImp._mouseWheelHandler ->
 * Event.mouseWheelVertEvent): a wheel whose vertical delta dominates and is
 * non-zero, landing on the y-axis widget, runs _zoomYAxis -> AxisImp.setRange,
 * which clears the axis auto-calc flag. |deltaX| > |deltaY| instead scrolls
 * time and leaves the axis in auto mode, so a trackpad's sideways drift over
 * the axis must not count.
 */
export function isPriceAxisScaleWheel(e: WheelDelta, geom: PriceAxisGeometry): boolean {
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return false;
  if (e.deltaY === 0) return false;
  return isOverPriceAxis(e.clientX, geom);
}
