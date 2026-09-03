import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMemStorage } from "./testMemStorage";

// vitest runs in the 'node' env (see vite.config.ts), so provide a tiny in-memory
// localStorage before importing the module under test (see persist.test.ts precedent).
installMemStorage();

import {
  saveIndicators, loadIndicators,
  saveIndicatorConfig, loadIndicatorConfigs,
  saveAvwapAnchor, loadAvwapAnchor,
} from "./persist";
import { onLayoutChanged } from "./persist/layoutEvents";
import { mirrorIndicatorState } from "./indicatorSync";

const O = { scope: "o", epic: "US100" };
const S = { scope: "s", epic: "DE40" };

beforeEach(() => localStorage.clear());

describe("mirrorIndicatorState", () => {
  it("copies instances verbatim (same ids) and configs, replacing the sibling set", () => {
    saveIndicators(O.scope, [{ id: "EMA#a1", type: "EMA" }, { id: "RSI", type: "RSI" }]);
    saveIndicatorConfig(O.scope, "EMA#a1", { calcParams: [21] });
    saveIndicators(S.scope, [{ id: "MACD", type: "MACD" }]); // pre-existing sibling extra
    saveIndicatorConfig(S.scope, "MACD", { calcParams: [12, 26, 9] });
    const changed = mirrorIndicatorState(O, S);
    expect(loadIndicators(S.scope)).toEqual([{ id: "EMA#a1", type: "EMA" }, { id: "RSI", type: "RSI" }]);
    expect(loadIndicatorConfigs(S.scope)["EMA#a1"]).toEqual({ calcParams: [21] });
    expect(loadIndicatorConfigs(S.scope)["MACD"]).toBeUndefined(); // stale config dropped
    // MACD is in `changed` too: an id REMOVED from the set must trigger the live
    // reconcile on the sibling (syncIndicatorsFromStorage is what tears it down).
    expect(changed.sort()).toEqual(["EMA#a1", "MACD", "RSI"].sort());
  });

  it("re-keys AVWAP anchors to the sibling's epic", () => {
    saveIndicators(O.scope, [{ id: "AVWAP#x", type: "AVWAP" }]);
    saveAvwapAnchor(O.scope, O.epic, "AVWAP#x", 1700000000000);
    mirrorIndicatorState(O, S);
    expect(loadAvwapAnchor(S.scope, S.epic, "AVWAP#x")).toBe(1700000000000);
  });

  it("returns only ids whose sibling state actually changed", () => {
    saveIndicators(O.scope, [{ id: "EMA#a1", type: "EMA" }, { id: "RSI", type: "RSI" }]);
    saveIndicatorConfig(O.scope, "EMA#a1", { calcParams: [21] });
    mirrorIndicatorState(O, S); // first pass seeds everything
    saveIndicatorConfig(O.scope, "EMA#a1", { calcParams: [34] }); // origin edit
    const changed = mirrorIndicatorState(O, S);
    expect(changed).toEqual(["EMA#a1"]); // RSI untouched
  });

  it("an anchor-only change marks that id changed", () => {
    saveIndicators(O.scope, [{ id: "AVWAP#x", type: "AVWAP" }]);
    saveAvwapAnchor(O.scope, O.epic, "AVWAP#x", 1000);
    mirrorIndicatorState(O, S);
    saveAvwapAnchor(O.scope, O.epic, "AVWAP#x", 2000);
    expect(mirrorIndicatorState(O, S)).toEqual(["AVWAP#x"]);
    expect(loadAvwapAnchor(S.scope, S.epic, "AVWAP#x")).toBe(2000);
  });

  it("emits no layout events while mirroring", () => {
    saveIndicators(O.scope, [{ id: "EMA#a1", type: "EMA" }]);
    const cb = vi.fn();
    const off = onLayoutChanged(cb);
    mirrorIndicatorState(O, S);
    off();
    expect(cb).not.toHaveBeenCalled();
  });
});
