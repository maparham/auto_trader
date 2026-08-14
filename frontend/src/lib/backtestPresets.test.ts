import { describe, it, expect, beforeEach } from "vitest";
import { installMemStorage } from "./testMemStorage";
installMemStorage();

import {
  loadPresets, putPreset, renamePreset, deletePreset, newPreset,
  serializePresets, parsePresets, type BacktestPreset,
} from "./backtestPresets";
import { defaultBacktestConfig } from "./backtestConfig";

const ORIGIN = { symbol: "TEST", timeframe: "MINUTE" };
const make = (name: string): BacktestPreset =>
  newPreset(name, defaultBacktestConfig(), ORIGIN, 1000);

beforeEach(() => localStorage.clear());

describe("backtestPresets storage", () => {
  it("round-trips a saved preset", () => {
    putPreset(make("Momentum"));
    const all = loadPresets();
    expect(Object.keys(all)).toEqual(["Momentum"]);
    expect(all.Momentum.origin).toEqual(ORIGIN);
    expect(all.Momentum.createdAt).toBe(1000);
  });

  // Preset names are user text and become record KEYS. A plain assignment on
  // `__proto__` writes the prototype instead of a property, so the preset
  // vanishes while every caller reports success — now reachable from an imported
  // file, not just from typing it into the name field.
  it("stores a preset named __proto__ as an ordinary key", () => {
    putPreset(make("__proto__"));
    expect(Object.keys(loadPresets())).toEqual(["__proto__"]);
    expect(loadPresets()["__proto__"].name).toBe("__proto__");
  });

  it("renames onto __proto__ without losing the preset", () => {
    putPreset(make("Old"));
    renamePreset("Old", "__proto__");
    expect(Object.keys(loadPresets())).toEqual(["__proto__"]);
  });

  it("renames without losing metadata", () => {
    const p = { ...make("Old"), lastRun: { at: 5, symbol: "TEST", timeframe: "MINUTE", netPnl: 10, trades: 3, winRate: 0.5, maxDd: 2 } };
    putPreset(p);
    renamePreset("Old", "New");
    const all = loadPresets();
    expect(Object.keys(all)).toEqual(["New"]);
    expect(all.New.name).toBe("New");
    expect(all.New.lastRun?.netPnl).toBe(10);
  });

  it("deletes", () => {
    putPreset(make("Gone"));
    deletePreset("Gone");
    expect(loadPresets()).toEqual({});
  });

  // Overwrite-on-collision is deliberate: this layer is a keyed store, and the
  // "that name is taken" decision belongs to the UI that prompts for the name.
  it("overwrites on a name collision, for both put and rename", () => {
    putPreset({ ...make("Keep"), createdAt: 1 });
    putPreset({ ...make("Keep"), createdAt: 2 });
    expect(loadPresets().Keep.createdAt).toBe(2);

    putPreset({ ...make("Other"), createdAt: 3 });
    renamePreset("Other", "Keep");
    const all = loadPresets();
    expect(Object.keys(all)).toEqual(["Keep"]);
    expect(all.Keep.createdAt).toBe(3);
  });

  // The record key is the identity; a stored `name` that disagrees with it (an
  // interrupted rename, a hand-edited file) is re-stamped from the key on read.
  it("re-stamps name from the record key when the two disagree", () => {
    localStorage.setItem(
      "auto-trader.backtestPresets.v3",
      JSON.stringify({ A: { ...make("B"), name: "B" } }),
    );
    expect(loadPresets().A.name).toBe("A");
  });

  it("ignores the abandoned v2 key", () => {
    localStorage.setItem(
      "auto-trader.backtestPresets.v2",
      JSON.stringify({ Legacy: defaultBacktestConfig() }),
    );
    expect(loadPresets()).toEqual({});
  });
});

describe("backtestPresets serialization", () => {
  it("round-trips through export and import", () => {
    const p = make("Momentum");
    const { presets, rejected } = parsePresets(serializePresets([p]));
    expect(rejected).toBe(0);
    expect(presets).toHaveLength(1);
    expect(presets[0].name).toBe("Momentum");
    // The pair is only useful if it is lossless: assert the whole envelope, not
    // one field, or a dropped origin/updatedAt would still read as green.
    expect(presets[0]).toEqual(p);
  });

  it("keeps lastRun through the round trip", () => {
    const p = { ...make("Momentum"), lastRun: { at: 5, symbol: "TEST", timeframe: "MINUTE", netPnl: -3, trades: 1, winRate: 0, maxDd: 4 } };
    const { presets } = parsePresets(serializePresets([p]));
    expect(presets[0].lastRun?.netPnl).toBe(-3);
    expect(presets[0]).toEqual(p);
  });

  it("round-trips codedParams through export and import", () => {
    const p = { ...make("Tuned"), codedParams: { bb_dev: 1.5, gated: true, mode: "fast" } };
    const { presets, rejected } = parsePresets(serializePresets([p]));
    expect(rejected).toBe(0);
    expect(presets[0].codedParams).toEqual({ bb_dev: 1.5, gated: true, mode: "fast" });
  });

  it("cleans malformed codedParams instead of dropping the preset", () => {
    const good = { ...make("A"), codedParams: { ok: 1, bad: { nested: true }, alsoOk: "x" } };
    const arr = { ...make("B"), codedParams: [1, 2] };
    const json = serializePresets([good, arr] as never);
    const { presets, rejected } = parsePresets(json);
    expect(rejected).toBe(0);
    expect(presets[0].codedParams).toEqual({ ok: 1, alsoOk: "x" });
    expect(presets[1].codedParams).toBeUndefined();
  });

  it("counts entries it cannot use instead of throwing", () => {
    const good = make("Good");
    const json = JSON.stringify({ version: 3, presets: [good, { name: "Bad" }, 42] });
    const { presets, rejected } = parsePresets(json);
    expect(presets.map((p) => p.name)).toEqual(["Good"]);
    expect(rejected).toBe(2);
  });

  it("reports malformed JSON as fully rejected", () => {
    const { presets, rejected } = parsePresets("not json at all");
    expect(presets).toEqual([]);
    expect(rejected).toBe(1);
  });

  // Valid JSON that simply isn't an export file: the third rejection branch.
  // It must count as one rejection rather than an empty success or a throw.
  it("rejects a file with no presets array", () => {
    expect(() => parsePresets(JSON.stringify({ version: 3 }))).not.toThrow();
    expect(parsePresets(JSON.stringify({ version: 3 }))).toEqual({ presets: [], rejected: 1 });
  });

  it("rejects a bare array", () => {
    expect(() => parsePresets("[]")).not.toThrow();
    expect(parsePresets("[]")).toEqual({ presets: [], rejected: 1 });
  });

  // A hand-edited file reaches the library table's formatters and sort
  // comparators directly. Metadata is stripped rather than counted as a
  // rejection: the cfg is the thing of value, and losing a whole strategy over
  // a cosmetic field would be the worse failure.
  it("strips malformed origin/lastRun instead of dropping the preset", () => {
    const json = JSON.stringify({
      version: 3,
      presets: [{ ...make("Momentum"), origin: 42, lastRun: "banana" }],
    });
    const { presets, rejected } = parsePresets(json);
    expect(rejected).toBe(0);
    expect(presets[0].name).toBe("Momentum");
    expect(presets[0].origin).toBeUndefined();
    expect(presets[0].lastRun).toBeUndefined();
  });

  // The cfg is the one field with no usable remainder — unlike the metadata it
  // cannot be stripped and still leave a preset worth keeping. The panel derefs
  // `cfg.range.mode` and each rule group's `rules` unguarded, so a structurally
  // wrong cfg is a crash waiting for the first non-test importer.
  const withCfg = (cfg: unknown) =>
    parsePresets(JSON.stringify({ version: 3, presets: [{ ...make("X"), cfg }] }));

  it("accepts a well-formed cfg untouched", () => {
    const { presets, rejected } = withCfg(defaultBacktestConfig());
    expect(rejected).toBe(0);
    expect(presets[0].cfg).toEqual(defaultBacktestConfig());
  });

  const cfgWithout = (key: keyof ReturnType<typeof defaultBacktestConfig>) => {
    const cfg: Record<string, unknown> = { ...defaultBacktestConfig() };
    delete cfg[key];
    return cfg;
  };

  it("rejects a cfg with no range", () => {
    expect(withCfg(cfgWithout("range"))).toEqual({ presets: [], rejected: 1 });
  });

  it("rejects an empty cfg", () => {
    expect(withCfg({})).toEqual({ presets: [], rejected: 1 });
  });

  it("rejects a cfg that is an array", () => {
    expect(withCfg([])).toEqual({ presets: [], rejected: 1 });
  });

  it("rejects a cfg missing one of the four rule groups", () => {
    expect(withCfg(cfgWithout("shortExit"))).toEqual({ presets: [], rejected: 1 });
  });

  it("rejects a rule group whose rules are not a list", () => {
    const cfg = { ...defaultBacktestConfig(), longEntry: { combine: "all", rules: "none" } };
    expect(withCfg(cfg)).toEqual({ presets: [], rejected: 1 });
  });

  // Absent costs must still import: normalizeBacktestConfig fills them, and a
  // preset exported before costs existed legitimately lacks them. Rejecting
  // those would break the format's own backward compatibility.
  it("accepts a cfg with no costs and lets normalization fill them", () => {
    const { presets, rejected } = withCfg(cfgWithout("costs"));
    expect(rejected).toBe(0);
    expect(presets[0].cfg.costs).toEqual(defaultBacktestConfig().costs);
  });

  it("drops a lastRun that is only partly numeric", () => {
    const lastRun = { at: 5, symbol: "TEST", timeframe: "MINUTE", netPnl: "lots", trades: 1, winRate: 0, maxDd: 4 };
    const json = JSON.stringify({ version: 3, presets: [{ ...make("Momentum"), lastRun }] });
    const { presets, rejected } = parsePresets(json);
    expect(rejected).toBe(0);
    expect(presets[0].lastRun).toBeUndefined();
  });
});

describe("preset codedCfg", () => {
  const codedCfg = () => ({
    params: { bb_dev: 1.5, gated: true },
    longExit: { combine: "AND", rules: [{ expr: "ATR1.to14 > 1", enabled: true }] },
    shortExit: { combine: "OR", rules: [] },
    longRisk: { sl: { mode: "atr", value: 2 } },
    riskSynced: false,
  });

  it("round-trips a full coded-store snapshot through put/load and export/import", () => {
    putPreset({ ...make("Coded"), codedCfg: codedCfg() });
    expect(loadPresets().Coded.codedCfg).toEqual(codedCfg());
    const { presets, rejected } = parsePresets(serializePresets([loadPresets().Coded]));
    expect(rejected).toBe(0);
    expect(presets[0].codedCfg).toEqual(codedCfg());
  });

  it("drops a codedCfg whose exit groups are malformed, keeping the preset", () => {
    const file = JSON.parse(serializePresets([make("A")]));
    file.presets[0].codedCfg = { ...codedCfg(), longExit: { combine: "AND", rules: "none" } };
    const { presets, rejected } = parsePresets(JSON.stringify(file));
    expect(rejected).toBe(0);
    expect(presets[0].name).toBe("A");
    expect(presets[0].codedCfg).toBeUndefined();
  });

  it("drops junk rule entries inside an imported exit group", () => {
    const file = JSON.parse(serializePresets([make("A")]));
    file.presets[0].codedCfg = {
      ...codedCfg(),
      longExit: { combine: "AND", rules: [{ expr: "x > 0" }, { expr: 42 }, null] },
    };
    const { presets } = parsePresets(JSON.stringify(file));
    expect(presets[0].codedCfg?.longExit.rules).toEqual([{ expr: "x > 0" }]);
  });

  it("drops a non-object codedCfg, keeping the preset", () => {
    const file = JSON.parse(serializePresets([make("A")]));
    file.presets[0].codedCfg = "banana";
    const { presets, rejected } = parsePresets(JSON.stringify(file));
    expect(rejected).toBe(0);
    expect(presets[0].codedCfg).toBeUndefined();
  });
});

describe("preset exprInstances", () => {
  const SLOPE = {
    type: "SLOPE",
    calcParams: [9, 21],
    extendData: { maType: "sma", units: "pctPerHour", mtf: { timeframe: "HOUR" } },
    visible: false,
    styles: { lines: [{ color: "#f00", size: 2 }] },
  };

  it("round-trips exprInstances through put/load and export/import", () => {
    putPreset({ ...make("Refs"), exprInstances: { "SLOPE#a1": SLOPE } });
    expect(loadPresets().Refs.exprInstances).toEqual({ "SLOPE#a1": SLOPE });
    const { presets, rejected } = parsePresets(serializePresets([loadPresets().Refs]));
    expect(rejected).toBe(0);
    expect(presets[0].exprInstances).toEqual({ "SLOPE#a1": SLOPE });
  });

  it("sanitises imported exprInstances instead of trusting them", () => {
    const file = JSON.parse(serializePresets([make("A")]));
    file.presets[0].exprInstances = {
      "SLOPE#a1": {
        type: "SLOPE",
        calcParams: [9, "junk"],
        extendData: { maType: "ema", barHours: 1.5 },
        styles: "nope",
        bogus: true,
      },
      noType: { calcParams: [4] },
      junk: 42,
    };
    const { presets, rejected } = parsePresets(JSON.stringify(file));
    expect(rejected).toBe(0);
    expect(presets[0].exprInstances).toEqual({
      "SLOPE#a1": { type: "SLOPE", calcParams: [9], extendData: { maType: "ema" } },
    });
  });

  it("drops a non-object exprInstances field, keeping the preset", () => {
    const file = JSON.parse(serializePresets([make("A")]));
    file.presets[0].exprInstances = [1, 2];
    const { presets, rejected } = parsePresets(JSON.stringify(file));
    expect(rejected).toBe(0);
    expect(presets[0].name).toBe("A");
    expect(presets[0].exprInstances).toBeUndefined();
  });

  it("collapses an empty exprInstances map to absent", () => {
    const file = JSON.parse(serializePresets([make("A")]));
    file.presets[0].exprInstances = {};
    const { presets } = parsePresets(JSON.stringify(file));
    expect(presets[0].exprInstances).toBeUndefined();
  });
});

describe("preset notes", () => {
  it("round-trips a note through put/load and export/import", () => {
    putPreset({ ...make("Doc"), note: "WFO tuned\nsecond line" });
    expect(loadPresets().Doc.note).toBe("WFO tuned\nsecond line");
    const { presets, rejected } = parsePresets(serializePresets([loadPresets().Doc]));
    expect(rejected).toBe(0);
    expect(presets[0].note).toBe("WFO tuned\nsecond line");
  });

  it("drops a malformed or blank imported note, keeping the preset", () => {
    const file = JSON.parse(serializePresets([make("A"), make("B")]));
    file.presets[0].note = 42;
    file.presets[1].note = "   ";
    const { presets, rejected } = parsePresets(JSON.stringify(file));
    expect(rejected).toBe(0);
    expect(presets.map((p) => p.note)).toEqual([undefined, undefined]);
  });
});
