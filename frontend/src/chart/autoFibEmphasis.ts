// Auto Fib's hover and selection glow. It paints its own lines, so there are
// no curve handles to show: the current fib glows instead ("select" while the
// instance is selected, "hover" while the mouse is on one of its lines or its
// legend row). The draw reads extendData.emphasis; this is the one writer.
import type { Chart } from "klinecharts";
import { overrideExtend } from "../lib/overrideExtend";
import { indTypeOf } from "../lib/indicators/shared";

type Emphasis = "select" | "hover";

/** What each chart's Auto Fibs were last told, so only changes are written. */
const CURRENT = new WeakMap<object, Map<string, Emphasis>>();

/** `selected` is the selected indicator's name; `hovered` lists the names
 * under the mouse (chart line, legend row). Anything that is not a candle-
 * pane AUTO_FIB is ignored, so callers can pass whatever is selected. */
export function emphasizeAutoFibs(
  chart: Chart,
  selected: string | null | undefined,
  hovered: ReadonlyArray<string | null | undefined>,
): void {
  const isFib = (name: string) => {
    const ind = chart.getIndicators({ paneId: "candle_pane", name })[0];
    return !!ind && indTypeOf(ind) === "AUTO_FIB";
  };
  const next = new Map<string, Emphasis>();
  for (const name of hovered) if (name && isFib(name)) next.set(name, "hover");
  if (selected && isFib(selected)) next.set(selected, "select");
  const cur = CURRENT.get(chart) ?? new Map<string, Emphasis>();
  // null, not undefined: klinecharts' merge skips undefined.
  for (const name of cur.keys())
    if (!next.has(name)) overrideExtend(chart, "candle_pane", name, { emphasis: null });
  for (const [name, e] of next)
    if (cur.get(name) !== e) overrideExtend(chart, "candle_pane", name, { emphasis: e });
  CURRENT.set(chart, next);
}
