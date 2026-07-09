import { beforeEach, describe, expect, it } from "vitest";
import { installMemStorage } from "./testMemStorage";
import {
  saveIndicators,
  saveIndicatorConfig,
  saveDrawings,
  saveAvwapAnchor,
  loadIndicators,
  loadIndicatorConfigs,
  loadDrawings,
  loadAvwapAnchor,
  loadSnapshotMeta,
} from "./persist";
import {
  captureSnapshot,
  writeSnapshotToScope,
  defaultSnapshotName,
  makeChartThumbnail,
} from "./snapshots";
import type { Chart } from "klinecharts";

const SCOPE = "tab.A";
const EPIC = "US100";
const SYMBOL = { epic: EPIC, name: "US 100", status: "TRADEABLE" };
const PERIOD = { resolution: "MINUTE_15", label: "15m" };
const RANGE = { from: 1_000, to: 2_000 };

beforeEach(() => {
  installMemStorage();
});

describe("captureSnapshot", () => {
  it("assembles blobs from the persisted scope stores", () => {
    saveIndicators(SCOPE, [
      { id: "EMA", type: "EMA" },
      { id: "AVWAP", type: "AVWAP" },
    ]);
    saveIndicatorConfig(SCOPE, "EMA", { calcParams: [9] });
    saveDrawings(SCOPE, EPIC, [
      { name: "segment", points: [{ timestamp: 1, value: 2 }] },
    ]);
    saveAvwapAnchor(SCOPE, EPIC, "AVWAP", 1234);

    const s = captureSnapshot({ scope: SCOPE, symbol: SYMBOL, period: PERIOD, range: RANGE });

    expect(s.epic).toBe(EPIC);
    expect(s.range).toEqual(RANGE);
    expect(s.indicators).toEqual([
      { id: "EMA", type: "EMA" },
      { id: "AVWAP", type: "AVWAP" },
    ]);
    expect(s.indicatorConfigs.EMA).toEqual({ calcParams: [9] });
    expect(s.drawings).toHaveLength(1);
    expect(s.avwapAnchors).toEqual({ AVWAP: 1234 });
    expect(s.takenAt).toBeGreaterThan(0);
    expect(s.id).toMatch(/^snap-/);
    expect(s.name).toBe(defaultSnapshotName(SYMBOL, PERIOD, s.takenAt));
  });

  it("excludes unplaced (zero-anchor) AVWAPs from avwapAnchors", () => {
    saveIndicators(SCOPE, [{ id: "AVWAP", type: "AVWAP" }]);
    const s = captureSnapshot({ scope: SCOPE, symbol: SYMBOL, period: PERIOD, range: RANGE });
    expect(s.avwapAnchors).toEqual({});
  });
});

describe("writeSnapshotToScope", () => {
  it("writes all blobs into the target scope and sets snapshotMeta with pendingRange", () => {
    saveIndicators(SCOPE, [{ id: "AVWAP", type: "AVWAP" }, { id: "RSI", type: "RSI" }]);
    saveIndicatorConfig(SCOPE, "RSI", { calcParams: [14] });
    saveDrawings(SCOPE, EPIC, [{ name: "segment", points: [{ timestamp: 1, value: 2 }] }]);
    saveAvwapAnchor(SCOPE, EPIC, "AVWAP", 999);
    const s = captureSnapshot({ scope: SCOPE, symbol: SYMBOL, period: PERIOD, range: RANGE });

    const target = "tab.NEW";
    writeSnapshotToScope(s, target);

    expect(loadIndicators(target)).toEqual(s.indicators);
    expect(loadIndicatorConfigs(target).RSI).toEqual({ calcParams: [14] });
    expect(loadDrawings(target, EPIC)).toEqual(s.drawings);
    expect(loadAvwapAnchor(target, EPIC, "AVWAP")).toBe(999);
    const meta = loadSnapshotMeta(target);
    expect(meta).toMatchObject({
      snapshotId: s.id,
      name: s.name,
      takenAt: s.takenAt,
      pendingRange: RANGE,
    });
  });
});

describe("makeChartThumbnail", () => {
  it("resolves undefined when the chart export throws", async () => {
    const chart = {
      getConvertPictureUrl: () => {
        throw new Error("no canvas");
      },
    } as unknown as Chart;
    await expect(makeChartThumbnail(chart)).resolves.toBeUndefined();
  });
});
