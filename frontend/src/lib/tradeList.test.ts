import { describe, it, expect } from "vitest";
import {
  parseTradeList, computeTradeStop, nearestCandleTs, tradeBoxSpec,
  prepareCsvImport, finalizeCsvImport, validateMapping, pendingSymbols, type TradeField,
  applyExclusions, type FlaggedGroup, type DegenerateReason,
} from "./tradeList";

const utc = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);

describe("parseTradeList: JSON", () => {
  it("parses the closed-trades sheet shape (money/percent strings, MM/DD/YYYY)", () => {
    const text = JSON.stringify({
      service: "The Swing Trader",
      sheet: "CLOSED-2026",
      trades: [
        {
          symbol: "MA",
          side: "SHORT",
          entryDate: "08/24/2026",
          entryPrice: "$597.07",
          exitDate: "09/04/2026",
          exitPrice: "$579.40",
          pctPL: "2.96%",
          dollarPL: "$3,534.00",
        },
        {
          symbol: "LLY",
          side: "LONG",
          entryDate: "08/19/2026",
          entryPrice: "$1,292.53",
          exitDate: "08/21/2026",
          exitPrice: "$1,228.50",
          pctPL: "-4.95%",
          dollarPL: "-$6,403.00",
        },
      ],
    });
    const res = parseTradeList(text);
    expect(res.label).toBe("The Swing Trader CLOSED-2026");
    expect(res.trades).toEqual([
      {
        symbol: "MA",
        side: "SHORT",
        entryTs: utc(2026, 8, 24),
        entryPrice: 597.07,
        exitTs: utc(2026, 9, 4),
        exitPrice: 579.4,
        pctPL: 2.96,
        dollarPL: 3534,
        hasTime: false,
      },
      {
        symbol: "LLY",
        side: "LONG",
        entryTs: utc(2026, 8, 19),
        entryPrice: 1292.53,
        exitTs: utc(2026, 8, 21),
        exitPrice: 1228.5,
        pctPL: -4.95,
        dollarPL: -6403,
        hasTime: false,
      },
    ]);
  });

  it("parses a bare JSON array of trades", () => {
    const res = parseTradeList(
      JSON.stringify([
        {
          symbol: "IBIT",
          side: "long",
          entryDate: "2026-08-05",
          entryPrice: 36.45,
          exitDate: "2026-08-19",
          exitPrice: 39.03,
        },
      ]),
    );
    expect(res.label).toBeUndefined();
    expect(res.trades).toEqual([
      {
        symbol: "IBIT",
        side: "LONG",
        entryTs: utc(2026, 8, 5),
        entryPrice: 36.45,
        exitTs: utc(2026, 8, 19),
        exitPrice: 39.03,
        pctPL: undefined,
        dollarPL: undefined,
        hasTime: false,
      },
    ]);
  });

  it("skips rows missing a required field but keeps the rest", () => {
    const res = parseTradeList(
      JSON.stringify({
        trades: [
          { symbol: "MA", side: "SHORT", entryDate: "08/24/2026", entryPrice: "$1" },
          {
            symbol: "AEM",
            side: "SHORT",
            entryDate: "08/20/2026",
            entryPrice: "$216.40",
            exitDate: "08/28/2026",
            exitPrice: "$211.82",
          },
        ],
      }),
    );
    expect(res.trades.map((t) => t.symbol)).toEqual(["AEM"]);
    expect(res.skipped).toBe(1);
  });

  it("throws a clear error when no trades are recognizable", () => {
    expect(() => parseTradeList('{"foo": 1}')).toThrow(/no trades/i);
  });
});

describe("parseTradeList: CSV", () => {
  it("detects CSV and maps fuzzy headers", () => {
    const csv = [
      "Ticker,Direction,Open Date,Open Price,Close Date,Close Price,P/L %,P/L $",
      "MSFT,Short,08/10/2026,$507.77,08/17/2026,$485.77,4.33%,\"$4,400.00\"",
      "STNE,Long,07/15/2026,10.63,09/03/2026,10.65,0.16%,$85.00",
    ].join("\n");
    const res = parseTradeList(csv);
    expect(res.trades).toEqual([
      {
        symbol: "MSFT",
        side: "SHORT",
        entryTs: utc(2026, 8, 10),
        entryPrice: 507.77,
        exitTs: utc(2026, 8, 17),
        exitPrice: 485.77,
        pctPL: 4.33,
        dollarPL: 4400,
        hasTime: false,
      },
      {
        symbol: "STNE",
        side: "LONG",
        entryTs: utc(2026, 7, 15),
        entryPrice: 10.63,
        exitTs: utc(2026, 9, 3),
        exitPrice: 10.65,
        pctPL: 0.16,
        dollarPL: 85,
        hasTime: false,
      },
    ]);
  });

  it("reads parenthesised money as negative", () => {
    const csv = [
      "symbol,side,entry date,entry price,exit date,exit price,dollar P/L",
      "QLD,SHORT,08/04/2026,91.36,08/19/2026,92.10,($1,915.00)".replace("($1,915.00)", '"($1,915.00)"'),
    ].join("\n");
    const res = parseTradeList(csv);
    expect(res.trades[0].dollarPL).toBe(-1915);
  });

  it("throws when required columns are missing", () => {
    expect(() => parseTradeList("a,b\n1,2")).toThrow(/column/i);
  });
});

describe("computeTradeStop", () => {
  const bars = [
    { timestamp: 1, open: 10, high: 12, low: 9.5, close: 11, volume: 0 },
    { timestamp: 2, open: 11, high: 13, low: 10.5, close: 12, volume: 0 },
    { timestamp: 3, open: 12, high: 12.5, low: 8.8, close: 12.2, volume: 0 },
  ];

  it("long: sits below the span's lowest low by 10% of the entry→exit range", () => {
    // entry 10, exit 12 → range 2, buffer 0.2; min low 8.8 → stop 8.6
    expect(computeTradeStop("LONG", 10, 12, bars)).toBeCloseTo(8.6);
  });

  it("short: sits above the span's highest high by 10% of the range", () => {
    // entry 12, exit 10 → range 2, buffer 0.2; max high 13 → stop 13.2
    expect(computeTradeStop("SHORT", 12, 10, bars)).toBeCloseTo(13.2);
  });

  it("no candles: falls back to the entry/exit extreme", () => {
    expect(computeTradeStop("LONG", 10, 12, [])).toBeCloseTo(9.8);
    expect(computeTradeStop("SHORT", 12, 10, [])).toBeCloseTo(12.2);
  });

  it("flat entry→exit still yields a non-zero buffer", () => {
    const stop = computeTradeStop("LONG", 10, 10, bars);
    expect(stop).toBeLessThan(8.8);
  });
});

describe("nearestCandleTs", () => {
  const bars = [
    { timestamp: 1000, open: 0, high: 0, low: 0, close: 0, volume: 0 },
    { timestamp: 2000, open: 0, high: 0, low: 0, close: 0, volume: 0 },
    { timestamp: 4000, open: 0, high: 0, low: 0, close: 0, volume: 0 },
  ];
  it("snaps to the nearest bar timestamp", () => {
    expect(nearestCandleTs(bars, 1900)).toBe(2000);
    expect(nearestCandleTs(bars, 2900)).toBe(2000);
    expect(nearestCandleTs(bars, 9999)).toBe(4000);
  });
  it("returns the input when there are no bars", () => {
    expect(nearestCandleTs([], 123)).toBe(123);
  });
});

describe("trade list library", () => {
  const parsed = (symbol: string) => ({
    trades: [
      {
        symbol, side: "SHORT" as const,
        entryTs: 1, entryPrice: 597.07, exitTs: 2, exitPrice: 579.4,
        pctPL: 2.96, dollarPL: 3534,
      },
    ],
    label: "sheet",
    skipped: 0,
  });

  async function lib() {
    const { installMemStorage } = await import("./testMemStorage");
    installMemStorage();
    return await import("./tradeList");
  }

  it("addTradeList names the import and listTradeLists returns it, newest first", async () => {
    const L = await lib();
    const a = L.addTradeList(parsed("MA"), "first");
    const b = L.addTradeList(parsed("LLY"), "second");
    expect(a.id).not.toBe(b.id);
    const lists = L.listTradeLists();
    expect(lists.map((l) => l.name)).toEqual(["second", "first"]);
    expect(lists[0].trades[0].symbol).toBe("LLY");
    expect(lists[0].createdAt).toBeGreaterThan(0);
  });

  it("throws instead of reporting success when the write is dropped", async () => {
    const L = await lib();
    L.addTradeList(parsed("MA"), "first");
    const orig = localStorage.setItem.bind(localStorage);
    // Storage full: setItem throws, so localStorage keeps its previous value.
    localStorage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    try {
      expect(() => L.addTradeList(parsed("LLY"), "second")).toThrow(/could not be saved/i);
    } finally {
      localStorage.setItem = orig;
    }
    expect(L.listTradeLists().map((l) => l.name)).toEqual(["first"]);
  });

  it("renameTradeList changes the name in place", async () => {
    const L = await lib();
    const a = L.addTradeList(parsed("MA"), "old name");
    L.renameTradeList(a.id, "new name");
    expect(L.listTradeLists().map((l) => l.name)).toEqual(["new name"]);
  });

  it("deleteTradeList removes the list", async () => {
    const L = await lib();
    const a = L.addTradeList(parsed("MA"), "gone");
    const b = L.addTradeList(parsed("LLY"), "kept");
    L.deleteTradeList(a.id);
    expect(L.listTradeLists().map((l) => l.id)).toEqual([b.id]);
  });

  it("migrates the legacy single-slot save into a named list and drops the old key", async () => {
    const L = await lib();
    localStorage.setItem("at.tradeList.v1", JSON.stringify(parsed("MA")));
    const lists = L.listTradeLists();
    expect(lists).toHaveLength(1);
    expect(lists[0].name).toBe("sheet"); // legacy label becomes the name
    expect(lists[0].trades[0].symbol).toBe("MA");
    expect(localStorage.getItem("at.tradeList.v1")).toBeNull();
  });

  it("names an import from its file name minus the extension", async () => {
    const L = await lib();
    expect(L.nameFromFilename("smart-money-stocks-etfs-2026.json")).toBe(
      "smart-money-stocks-etfs-2026",
    );
    expect(L.nameFromFilename("trades.closed.csv")).toBe("trades.closed");
    expect(L.nameFromFilename("noext")).toBe("noext");
  });
});

describe("tradeBoxSpec", () => {
  const bar = (ts: number, low: number, high: number) => ({
    timestamp: ts, open: low, high, low, close: high, volume: 0,
  });
  const trade = {
    symbol: "MA", side: "SHORT" as const,
    entryTs: 2000, entryPrice: 12, exitTs: 4100, exitPrice: 10,
    pctPL: 2.96, dollarPL: 3534,
  };

  it("anchors entry/exit on real bars and puts the stop past the span's extreme", () => {
    const bars = [bar(1000, 9, 11), bar(2000, 10, 13), bar(3000, 9.5, 12.5), bar(4000, 9, 10.5)];
    const spec = tradeBoxSpec(trade, bars);
    // entry snaps 2000→2000, exit 4100→4000; stop = max high in [2000,4000] (13) + 0.2
    expect(spec.points).toEqual([
      { timestamp: 2000, value: 12 },
      { timestamp: 4000, value: 10 },
      { timestamp: 4000, value: 13.2 },
    ]);
    expect(spec.text).toBe("MA SHORT 2.96%");
  });

  it("works without bars (data gap): raw dates, entry/exit-extreme stop", () => {
    const spec = tradeBoxSpec({ ...trade, pctPL: undefined }, []);
    expect(spec.points).toEqual([
      { timestamp: 2000, value: 12 },
      { timestamp: 4100, value: 10 },
      { timestamp: 4100, value: 12.2 },
    ]);
    expect(spec.text).toBe("MA SHORT");
  });
});

describe("autoTfResolution", () => {
  it("keeps the timeframe when the span already holds 5+ bars", async () => {
    const { autoTfResolution } = await import("./tradeList");
    expect(autoTfResolution("DAY", 10)).toBeNull(); // 10 daily bars
    expect(autoTfResolution("HOUR", 1)).toBeNull(); // ~7 hourly bars in a day
    expect(autoTfResolution("WEEK", 30)).toBeNull(); // ~6 weekly bars
  });

  it("lowers a daily chart to 4H for a 3-day trade", async () => {
    const { autoTfResolution } = await import("./tradeList");
    expect(autoTfResolution("DAY", 3)).toBe("HOUR_4"); // 3 bars → ~6 at 4H
  });

  it("lowers a daily chart to 1H for a same-day trade", async () => {
    const { autoTfResolution } = await import("./tradeList");
    expect(autoTfResolution("DAY", 1)).toBe("HOUR"); // 4H would only give ~2 bars
  });

  it("lowers a weekly chart just far enough", async () => {
    const { autoTfResolution } = await import("./tradeList");
    expect(autoTfResolution("WEEK", 8)).toBe("DAY"); // ~1.6 weekly bars → 8 daily
  });

  it("raises to the coarsest timeframe that still holds 7+ bars", async () => {
    const { autoTfResolution } = await import("./tradeList");
    expect(autoTfResolution("MINUTE", 1)).toBe("HOUR"); // ~7 hourly bars in a day
    expect(autoTfResolution("HOUR", 60)).toBe("WEEK"); // ~12 weekly bars
    expect(autoTfResolution("HOUR", 10)).toBe("DAY"); // WEEK would be ~2 bars
  });

  it("does not raise when the next-coarser timeframe would drop below 7 bars", async () => {
    const { autoTfResolution } = await import("./tradeList");
    // 3 trading days at 4H = ~6 bars: fine as-is (≥5), and DAY would be 3 bars
    expect(autoTfResolution("HOUR_4", 3)).toBeNull();
  });

  it("leaves unknown/derived resolutions alone", async () => {
    const { autoTfResolution } = await import("./tradeList");
    expect(autoTfResolution("MINUTE_3", 1)).toBeNull();
  });
});

describe("auto TF toggle persistence", () => {
  it("defaults on, persists an off switch", async () => {
    const { installMemStorage } = await import("./testMemStorage");
    installMemStorage();
    const { loadAutoTf, saveAutoTf } = await import("./tradeList");
    expect(loadAutoTf()).toBe(true);
    saveAutoTf(false);
    expect(loadAutoTf()).toBe(false);
    saveAutoTf(true);
    expect(loadAutoTf()).toBe(true);
  });

  it("same-tab mode defaults on and persists an off switch", async () => {
    const { installMemStorage } = await import("./testMemStorage");
    installMemStorage();
    const { loadSameTab, saveSameTab } = await import("./tradeList");
    expect(loadSameTab()).toBe(true);
    saveSameTab(false);
    expect(loadSameTab()).toBe(false);
  });
});

describe("timestamps with time of day", () => {
  it("marks date-only rows hasTime=false (timeframe stays daily for them)", () => {
    const res = parseTradeList(
      JSON.stringify([
        {
          symbol: "MA", side: "SHORT",
          entryDate: "08/24/2026", entryPrice: 597.07,
          exitDate: "09/04/2026", exitPrice: 579.4,
        },
      ]),
    );
    expect(res.trades[0].hasTime).toBe(false);
    expect(res.trades[0].entryTs).toBe(Date.UTC(2026, 7, 24));
  });

  it("parses naive datetimes in the given timezone (DST-correct)", () => {
    const res = parseTradeList(
      JSON.stringify([
        {
          symbol: "MA", side: "SHORT",
          entryDate: "08/10/2026 09:45", entryPrice: 1,
          exitDate: "2026-12-10 09:45", exitPrice: 2,
        },
      ]),
      { timezone: "America/New_York" },
    );
    // Aug 10 = EDT (UTC-4); Dec 10 = EST (UTC-5)
    expect(res.trades[0].entryTs).toBe(Date.UTC(2026, 7, 10, 13, 45));
    expect(res.trades[0].exitTs).toBe(Date.UTC(2026, 11, 10, 14, 45));
    expect(res.trades[0].hasTime).toBe(true);
  });

  it("naive datetimes default to UTC when no timezone is given", () => {
    const res = parseTradeList(
      JSON.stringify([
        {
          symbol: "MA", side: "LONG",
          entryDate: "2026-08-10 14:30", entryPrice: 1,
          exitDate: "2026-08-11 15:00:30", exitPrice: 2,
        },
      ]),
    );
    expect(res.trades[0].entryTs).toBe(Date.UTC(2026, 7, 10, 14, 30));
    expect(res.trades[0].exitTs).toBe(Date.UTC(2026, 7, 11, 15, 0, 30));
  });

  it("an encoded zone (Z or offset) wins over the dropdown timezone", () => {
    const res = parseTradeList(
      JSON.stringify([
        {
          symbol: "MA", side: "LONG",
          entryDate: "2026-08-10T14:30:00Z", entryPrice: 1,
          exitDate: "2026-08-10T14:30:00+03:30", exitPrice: 2,
        },
      ]),
      { timezone: "America/New_York" },
    );
    expect(res.trades[0].entryTs).toBe(Date.UTC(2026, 7, 10, 14, 30));
    expect(res.trades[0].exitTs).toBe(Date.UTC(2026, 7, 10, 11, 0));
    expect(res.trades[0].hasTime).toBe(true);
  });

  it("a timed trade keeps its exact anchors (no daily-bar snapping)", () => {
    const bars = [
      { timestamp: 1000, open: 1, high: 3, low: 1, close: 2, volume: 0 },
      { timestamp: 2000, open: 1, high: 4, low: 1, close: 2, volume: 0 },
    ];
    const spec = tradeBoxSpec(
      {
        symbol: "MA", side: "LONG" as const, hasTime: true,
        entryTs: 1490, entryPrice: 1.5, exitTs: 1510, exitPrice: 2.5,
      },
      bars,
    );
    expect(spec.points[0].timestamp).toBe(1490);
    expect(spec.points[1].timestamp).toBe(1510);
  });
});

describe("collective2-style CSV headers", () => {
  it("maps prices from the price columns, not quantities, and P/L from Trade P/L, not drawdown", () => {
    const csv = [
      '"Open Time ET","Side","Qty Open","Symbol","Descrip","Avg Price Open","Qty Closed","Closed Time ET","Avg Price Closed","DD as %","DD $","DD Time ET","DD Quant","DD Worst Price","Trade P/L","Trade ID"',
      '"2026-04-29 09:30:26","LONG","35","RDDT","REDDIT INC","146.0000","35","2026-08-28 09:30:19","152.2500","-0.34","-377.22","2026-07-31 00:00:00","35","135.2220","218.30","155830957"',
    ].join("\n");
    const res = parseTradeList(csv, { timezone: "America/New_York" });
    expect(res.trades).toHaveLength(1);
    const t = res.trades[0];
    expect(t.symbol).toBe("RDDT");
    expect(t.side).toBe("LONG");
    expect(t.entryPrice).toBe(146); // Avg Price Open — NOT Qty Open (35)
    expect(t.exitPrice).toBe(152.25); // Avg Price Closed — NOT Qty Closed
    expect(t.dollarPL).toBe(218.3); // Trade P/L — NOT DD $ (-377.22)
    expect(t.qty).toBe(35); // Qty Open (Qty Closed stays ignored)
    expect(t.ddPct).toBe(-0.34); // DD as % is drawdown, not P/L
    expect(t.worstPrice).toBe(135.222); // DD Worst Price (recorded MAE)
    // no P/L% column in the file: derived from $P/L over the entry notional
    expect(t.pctPL).toBeCloseTo((100 * 218.3) / (35 * 146), 4);
    // 09:30 ET (EDT, UTC-4) → 13:30 UTC, seconds kept
    expect(t.entryTs).toBe(Date.UTC(2026, 3, 29, 13, 30, 26));
    expect(t.hasTime).toBe(true);
  });
});

describe("two-stage CSV import (mapping review)", () => {
  const csv = [
    "Ticker,Side,Entry Date,Entry Price,Exit Date,Exit Price,Qty,Profit $",
    "MSFT,LONG,2026-08-10,500,2026-08-12,510,10,100",
    "AAPL,SHORT,2026-08-11,230,2026-08-13,225,5,25",
  ].join("\n");

  it("prepareCsvImport exposes headers, guessed mapping and per-column samples", () => {
    const p = prepareCsvImport(csv);
    expect(p.headers).toEqual([
      "Ticker", "Side", "Entry Date", "Entry Price", "Exit Date", "Exit Price", "Qty", "Profit $",
    ]);
    expect(p.guesses).toEqual([
      "symbol", "side", "entryDate", "entryPrice", "exitDate", "exitPrice", "qty", "dollarPL",
    ]);
    expect(p.samples[0]).toEqual(["MSFT", "AAPL"]);
    expect(p.samples[6]).toEqual(["10", "5"]);
  });

  it("prepareCsvImport rejects a headerless sheet", () => {
    expect(() => prepareCsvImport("Ticker,Side")).toThrow(/header row and at least one/);
  });

  it("finalizeCsvImport uses the corrected mapping, not the guess", () => {
    const wrong = [
      "Symbol,Side,Open Date,Open,Close Date,Close,Qty,P/L",
      "MSFT,LONG,2026-08-10,500,2026-08-12,510,10,100",
    ].join("\n");
    const p = prepareCsvImport(wrong);
    // Pretend the guess put entryPrice on Qty; the user fixes it.
    const mapping: Array<TradeField | null> = [
      "symbol", "side", "entryDate", "entryPrice", "exitDate", "exitPrice", null, "dollarPL",
    ];
    const res = finalizeCsvImport(p, mapping);
    expect(res.trades).toHaveLength(1);
    expect(res.trades[0].entryPrice).toBe(500);
    expect(res.trades[0].dollarPL).toBe(100);
  });

  it("finalizeCsvImport interprets naive stamps in the given timezone", () => {
    const timed = [
      "Ticker,Side,Entry Date,Entry Price,Exit Date,Exit Price",
      "MSFT,LONG,2026-08-10 09:30,500,2026-08-12 16:00,510",
    ].join("\n");
    const p = prepareCsvImport(timed);
    const res = finalizeCsvImport(p, p.guesses, { timezone: "America/New_York" });
    expect(res.trades[0].entryTs).toBe(Date.UTC(2026, 7, 10, 13, 30)); // 09:30 EDT
  });

  it("validateMapping flags missing required fields by their labels", () => {
    const err = validateMapping(["symbol", "side", null, null, null, null]);
    expect(err).toMatch(/Entry date/);
    expect(err).toMatch(/Exit price/);
  });

  it("validateMapping flags a field assigned to two columns", () => {
    const err = validateMapping([
      "symbol", "side", "entryDate", "entryPrice", "exitDate", "exitPrice", "entryPrice",
    ]);
    expect(err).toMatch(/Entry price/);
    expect(err).toMatch(/twice|more than once|multiple/i);
  });

  it("a complete unique mapping validates clean", () => {
    expect(validateMapping([
      "symbol", "side", "entryDate", "entryPrice", "exitDate", "exitPrice", null, "dollarPL",
    ])).toBeNull();
  });
});

describe("symbol mapping", () => {
  it("pendingSymbols lists distinct uppercased symbols from the mapped column", () => {
    const p = prepareCsvImport([
      "Ticker,Side,Entry Date,Entry Price,Exit Date,Exit Price",
      "msft,LONG,2026-08-10,500,2026-08-12,510",
      "MSFT,SHORT,2026-08-11,505,2026-08-13,500",
      "aapl,LONG,2026-08-11,230,2026-08-13,225",
    ].join("\n"));
    expect(pendingSymbols(p, p.guesses)).toEqual(["MSFT", "AAPL"]);
  });

  it("pendingSymbols is empty when no column maps to symbol", () => {
    const p = prepareCsvImport([
      "Ticker,Side,Entry Date,Entry Price,Exit Date,Exit Price",
      "MSFT,LONG,2026-08-10,500,2026-08-12,510",
    ].join("\n"));
    const noSym = p.guesses.map((f) => (f === "symbol" ? null : f));
    expect(pendingSymbols(p, noSym)).toEqual([]);
  });
});

describe("qty / drawdown columns and derived % P/L", () => {
  const C2_HEADER = '"Open Time ET","Side","Qty Open","Symbol","Descrip","Avg Price Open","Qty Closed","Closed Time ET","Avg Price Closed","DD as %","DD $","DD Time ET","DD Quant","DD Worst Price","Trade P/L","Trade ID"';

  it("guesses qty from Qty Open only, and the DD trio maps % and worst price", () => {
    const p = prepareCsvImport(C2_HEADER + "\n" + '"x"'.repeat(1));
    expect(p.guesses).toEqual([
      "entryDate", "side", "qty", "symbol", null, "entryPrice",
      null, "exitDate", "exitPrice", "ddPct", null, null, null,
      "worstPrice", "dollarPL", null,
    ]);
  });

  it("an explicit % P/L column wins over the derived value", () => {
    const res = parseTradeList(JSON.stringify([{
      symbol: "MA", side: "LONG",
      entryDate: "08/10/2026", entryPrice: 100,
      exitDate: "08/12/2026", exitPrice: 110,
      qty: 10, dollarPL: 100, pctPL: 55,
    }]));
    expect(res.trades[0].pctPL).toBe(55);
  });

  it("derives % P/L only when qty, $ P/L and entry price are all present", () => {
    const res = parseTradeList(JSON.stringify([
      {
        symbol: "MA", side: "LONG",
        entryDate: "08/10/2026", entryPrice: 100,
        exitDate: "08/12/2026", exitPrice: 110,
        qty: 10, dollarPL: -50,
      },
      {
        symbol: "V", side: "LONG",
        entryDate: "08/10/2026", entryPrice: 100,
        exitDate: "08/12/2026", exitPrice: 110,
        dollarPL: -50,
      },
    ]));
    expect(res.trades[0].pctPL).toBe(-5); // -50 over 10×100
    expect(res.trades[1].pctPL).toBeUndefined(); // no qty: no notional
  });

  it("a recorded worst price places the stop instead of the bar scan", () => {
    const bars = [
      { timestamp: 1000, open: 100, high: 120, low: 80, close: 110, volume: 0 },
      { timestamp: 2000, open: 110, high: 125, low: 85, close: 110, volume: 0 },
    ];
    const long = tradeBoxSpec(
      {
        symbol: "MA", side: "LONG" as const,
        entryTs: 1000, entryPrice: 100, exitTs: 2000, exitPrice: 110,
        worstPrice: 95,
      },
      bars,
    );
    expect(long.points[2].value).toBe(94); // 95 − 10% of the 10-range, NOT low 80
    const short = tradeBoxSpec(
      {
        symbol: "MA", side: "SHORT" as const,
        entryTs: 1000, entryPrice: 110, exitTs: 2000, exitPrice: 100,
        worstPrice: 115,
      },
      bars,
    );
    expect(short.points[2].value).toBe(116); // 115 + buffer, NOT high 125
  });
});

// --- degenerate rows ---------------------------------------------------------
// The review stage's filter: rows that parse but describe an impossible or
// redundant trade are flagged by reason, so the import can exclude them as a
// group. Flagging never drops a row on its own — applyExclusions does that.

const row = (over: Record<string, string>) => ({
  symbol: "MA", side: "SHORT",
  entryDate: "08/24/2026", entryPrice: "$100",
  exitDate: "09/04/2026", exitPrice: "$90",
  ...over,
});
const sheet = (...trades: Array<Record<string, string>>) =>
  JSON.stringify({ trades });
const group = (res: { flagged: FlaggedGroup[] }, reason: DegenerateReason) =>
  res.flagged.find((g) => g.reason === reason);

describe("degenerate rows: flagging", () => {
  it("flags a trade whose exit date precedes its entry date", () => {
    const res = parseTradeList(sheet(
      row({}),
      row({ symbol: "AXP", entryDate: "08/29/2025", exitDate: "02/13/2025" }),
    ));
    expect(res.trades).toHaveLength(2); // flagging alone keeps every row
    expect(group(res, "reversed")?.indices).toEqual([1]);
  });

  it("flags a repeat of an identical row, keeping the first occurrence", () => {
    const dup = { symbol: "HD", entryPrice: "$104.15", exitPrice: "$100.95" };
    const res = parseTradeList(sheet(row(dup), row({}), row(dup)));
    expect(group(res, "duplicate")?.indices).toEqual([2]);
  });

  it("flags a non-positive price on either leg", () => {
    const res = parseTradeList(sheet(
      row({}),
      row({ symbol: "RSX", exitPrice: "$0.00" }),
      row({ symbol: "ZZZ", entryPrice: "$0" }),
    ));
    expect(group(res, "nonPositivePrice")?.indices).toEqual([1, 2]);
  });

  it("labels a flagged row with its symbol, side and dates", () => {
    const res = parseTradeList(sheet(
      row({ symbol: "AXP", entryDate: "08/29/2025", exitDate: "02/13/2025" }),
    ));
    expect(group(res, "reversed")?.labels).toEqual(["AXP SHORT 2025-08-29 → 2025-02-13"]);
  });

  it("reports no groups for a clean sheet", () => {
    expect(parseTradeList(sheet(row({}), row({ symbol: "LLY" }))).flagged).toEqual([]);
  });

  it("flags unparseable rows as a group with no indices into trades", () => {
    const res = parseTradeList(sheet(
      row({}),
      { symbol: "Tax Selling", side: "To Offset", entryDate: "Huge 2020",
        entryPrice: "Profits", exitDate: "Tax Bill", exitPrice: "And Reduce" },
    ));
    expect(res.trades).toHaveLength(1);
    const g = group(res, "unparseable");
    expect(g?.indices).toEqual([]);
    expect(g?.labels).toEqual(["Tax Selling / To Offset / Huge 2020 / Profits"]);
  });
});

describe("degenerate rows: applyExclusions", () => {
  const mixed = () => parseTradeList(sheet(
    row({}),                                                       // 0 clean
    row({ symbol: "AXP", entryDate: "08/29/2025", exitDate: "02/13/2025" }), // 1 reversed
    row({ symbol: "RSX", exitPrice: "$0.00" }),                    // 2 zero price
    { symbol: "Tax Selling", side: "To Offset" },                  // unparseable
  ));

  it("drops the rows of every excluded reason", () => {
    const res = applyExclusions(mixed(), new Set<DegenerateReason>(["reversed"]));
    expect(res.trades.map((t) => t.symbol)).toEqual(["MA", "RSX"]);
  });

  it("keeps a flagged row whose reason was not excluded", () => {
    const res = applyExclusions(mixed(), new Set<DegenerateReason>([]));
    expect(res.trades.map((t) => t.symbol)).toEqual(["MA", "AXP", "RSX"]);
  });

  it("records what it excluded, counting unparseable rows too", () => {
    const res = applyExclusions(
      mixed(),
      new Set<DegenerateReason>(["reversed", "unparseable"]),
    );
    expect(res.excluded).toEqual([
      { reason: "unparseable", count: 1 },
      { reason: "reversed", count: 1 },
    ]);
  });

  it("counts a row once when two excluded reasons both name it", () => {
    const both = parseTradeList(sheet(
      row({}),
      row({ symbol: "ZZZ", entryDate: "08/29/2025", exitDate: "02/13/2025", exitPrice: "$0" }),
    ));
    const res = applyExclusions(
      both,
      new Set<DegenerateReason>(["reversed", "nonPositivePrice"]),
    );
    expect(res.trades.map((t) => t.symbol)).toEqual(["MA"]);
  });

  it("leaves nothing flagged on the list it returns", () => {
    expect(applyExclusions(mixed(), new Set<DegenerateReason>(["reversed"])).flagged).toEqual([]);
  });
});

describe("review fixes: degenerate box geometry and span scan", () => {
  const day = (n: number) => n * 86_400_000;
  const dailyBar = (ts: number, lo: number, hi: number) =>
    ({ timestamp: ts, open: lo, high: hi, low: lo, close: hi, volume: 0 });

  it("a same-day date-only trade still gets two distinct anchor timestamps", () => {
    const bars = [dailyBar(day(1), 10, 12), dailyBar(day(2), 10, 12), dailyBar(day(3), 10, 12)];
    const spec = tradeBoxSpec(
      {
        symbol: "MA", side: "LONG", hasTime: false,
        entryTs: day(2), entryPrice: 10, exitTs: day(2), exitPrice: 11,
      },
      bars,
    );
    expect(spec.points[0].timestamp).toBe(day(2));
    expect(spec.points[1].timestamp).toBe(day(3)); // next bar, not the same one
  });

  it("snapped to the LAST bar, the entry backs up a bar instead", () => {
    const bars = [dailyBar(day(1), 10, 12), dailyBar(day(2), 10, 12)];
    const spec = tradeBoxSpec(
      {
        symbol: "MA", side: "LONG", hasTime: false,
        entryTs: day(2), entryPrice: 10, exitTs: day(2), exitPrice: 11,
      },
      bars,
    );
    expect(spec.points[0].timestamp).toBe(day(1));
    expect(spec.points[1].timestamp).toBe(day(2));
  });

  it("with no bars at all, the exit is pushed one day out", () => {
    const spec = tradeBoxSpec(
      {
        symbol: "MA", side: "LONG", hasTime: false,
        entryTs: day(2), entryPrice: 10, exitTs: day(2), exitPrice: 11,
      },
      [],
    );
    expect(spec.points[1].timestamp).toBe(day(3));
  });

  it("the stop scan includes the entry day's daily bar for timed trades", () => {
    // Daily bars are stamped at UTC midnight — BEFORE a timed entry the same
    // day. The entry-day extreme must still shape the stop.
    const bars = [dailyBar(day(10), 90, 101), dailyBar(day(11), 95, 108)];
    const spec = tradeBoxSpec(
      {
        symbol: "MA", side: "LONG", hasTime: true,
        entryTs: day(10) + 13.5 * 3_600_000, entryPrice: 100,
        exitTs: day(11) + 15 * 3_600_000, exitPrice: 105,
      },
      bars,
    );
    expect(spec.points[2].value).toBe(90 - 0.1 * 5); // entry-day low, buffered
  });

  it("captions round a derived percent to 2 decimals", () => {
    const spec = tradeBoxSpec(
      {
        symbol: "MA", side: "LONG",
        entryTs: day(1), entryPrice: 100, exitTs: day(2), exitPrice: 105,
        pctPL: 6.237142857142857,
      },
      [],
    );
    expect(spec.text).toBe("MA LONG 6.24%");
  });
});
