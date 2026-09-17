import type { IndicatorTemplate, Indicator, KLineData } from "klinecharts";
import { describe, expect, it, vi } from "vitest";

import { hiddenAware } from "./hiddenCalc";

type Tmpl = Omit<IndicatorTemplate, "name">;
const tmplOf = (t: object): Tmpl => t as Tmpl;
const indOf = (i: object): Indicator => i as Indicator;
const bars = [{ timestamp: 1 }, { timestamp: 2 }] as KLineData[];

describe("hiddenAware", () => {
  it("does not call the template's calc while the indicator is hidden", () => {
    const calc = vi.fn(() => [{ v: 1 }]);
    const prior = [{ v: 0 }];
    const out = hiddenAware(tmplOf({ calc })).calc!(
      bars,
      indOf({ visible: false, result: prior }),
    );
    expect(calc).not.toHaveBeenCalled();
    // The PRIOR rows by identity: calcImp assigns the return value to
    // indicator.result, so this leaves the result untouched rather than wiping it.
    expect(out).toBe(prior);
  });

  it("computes as normal when visible, and when the flag is absent", () => {
    const calc = vi.fn(() => [{ v: 1 }]);
    const tmpl = hiddenAware(tmplOf({ calc }));
    tmpl.calc!(bars, indOf({ visible: true, result: [] }));
    tmpl.calc!(bars, indOf({ result: [] })); // pre-flag/bare instance
    expect(calc).toHaveBeenCalledTimes(2);
  });

  it("passes the rest of the template through untouched", () => {
    const figures: never[] = [];
    const calc = (): never[] => [];
    const wrapped = hiddenAware(tmplOf({ figures, series: "price", calc }));
    expect(wrapped.figures).toBe(figures);
    expect(wrapped.series).toBe("price");
    expect(wrapped.calc).not.toBe(calc);
  });
});
