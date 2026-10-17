// Fired on the chart's own DOM element (chart.getDom()) once per frame of a
// motion glide that keeps moving the view after the user's input has stopped
// (wheel-zoom easing, pan momentum). Listeners that treat DOM input as "the
// user moved the chart" (the view-position persist in useLiveMarketData) also
// listen for this, so they settle on where the glide ends, not where the
// input did.
export const CHART_GLIDE_EVENT = "chartkar:glide";

export function emitGlide(dom: EventTarget): void {
  dom.dispatchEvent(new Event(CHART_GLIDE_EVENT));
}
