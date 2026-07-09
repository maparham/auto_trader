import { beforeEach, describe, expect, it } from "vitest";
import { installMemStorage } from "../testMemStorage";
import {
  loadSnapshot,
  loadSnapshotIndex,
  saveSnapshot,
  deleteSnapshot,
  loadSnapshotMeta,
  saveSnapshotMeta,
  deleteSnapshotMeta,
  type ChartSnapshot,
} from "./snapshots";
import { purgeScope } from "./core";

function makeSnap(id: string): ChartSnapshot {
  return {
    id,
    name: `Snap ${id}`,
    epic: "US100",
    symbol: { epic: "US100", name: "US 100", status: "TRADEABLE" },
    period: { resolution: "MINUTE_15", label: "15m" },
    takenAt: 1_700_000_000_000,
    range: { from: 1_699_990_000_000, to: 1_700_000_000_000 },
    indicators: [{ id: "EMA", type: "EMA" }],
    indicatorConfigs: { EMA: { calcParams: [9] } },
    drawings: [{ name: "segment", points: [{ timestamp: 1, value: 2 }] }],
    avwapAnchors: {},
  };
}

beforeEach(() => {
  installMemStorage();
});

describe("snapshot persistence", () => {
  it("round-trips a snapshot and maintains the index newest-first", () => {
    expect(loadSnapshotIndex()).toEqual([]);
    saveSnapshot(makeSnap("a"));
    saveSnapshot(makeSnap("b"));
    expect(loadSnapshotIndex()).toEqual(["b", "a"]);
    expect(loadSnapshot("a")?.name).toBe("Snap a");
    expect(loadSnapshot("missing")).toBeNull();
  });

  it("re-saving an existing id updates in place without duplicating the index entry", () => {
    saveSnapshot(makeSnap("a"));
    saveSnapshot({ ...makeSnap("a"), name: "Renamed" });
    expect(loadSnapshotIndex()).toEqual(["a"]);
    expect(loadSnapshot("a")?.name).toBe("Renamed");
  });

  it("deleteSnapshot removes the record and its index entry", () => {
    saveSnapshot(makeSnap("a"));
    saveSnapshot(makeSnap("b"));
    deleteSnapshot("a");
    expect(loadSnapshotIndex()).toEqual(["b"]);
    expect(loadSnapshot("a")).toBeNull();
  });

  it("snapshotMeta round-trips per scope and is purged with the scope", () => {
    const scope = "tab.T1";
    expect(loadSnapshotMeta(scope)).toBeNull();
    saveSnapshotMeta(scope, {
      snapshotId: "a",
      name: "Snap a",
      takenAt: 5,
      pendingRange: { from: 1, to: 5 },
    });
    expect(loadSnapshotMeta(scope)?.pendingRange).toEqual({ from: 1, to: 5 });
    deleteSnapshotMeta(scope);
    expect(loadSnapshotMeta(scope)).toBeNull();
    saveSnapshotMeta(scope, { snapshotId: "a", name: "Snap a", takenAt: 5 });
    purgeScope(scope);
    expect(loadSnapshotMeta(scope)).toBeNull();
  });
});
