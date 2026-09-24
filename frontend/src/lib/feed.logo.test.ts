import { describe, it, expect } from "vitest";
import { installMemStorage } from "./testMemStorage";
installMemStorage();

import { logoCandidates } from "./feed";

const BASE = "https://static.capital.com/instrument-icons/instrument-logos";

describe("logoCandidates", () => {
  it("tries the slug, then the upper- and lower-case logos/ paths for a Capital share", () => {
    expect(logoCandidates("INTC", "SHARES")).toEqual([
      `${BASE}/intc.svg`,
      `${BASE}/logos/INTC.svg`,
      `${BASE}/logos/intc.svg`,
    ]);
  });

  it("treats yfinance stock/etf/fund rows as shares", () => {
    for (const type of ["stock", "etf", "fund"]) {
      expect(logoCandidates("IWM", type)).toContain(`${BASE}/logos/IWM.svg`);
    }
  });

  it("tries every path for a typeless placeholder symbol", () => {
    expect(logoCandidates("MU", undefined)).toEqual([
      `${BASE}/mu.svg`,
      `${BASE}/logos/MU.svg`,
      `${BASE}/logos/mu.svg`,
    ]);
    expect(logoCandidates("MU", null)).toHaveLength(3);
  });

  it("keeps a single slug URL for non-stock types", () => {
    expect(logoCandidates("EURUSD", "CURRENCIES")).toEqual([`${BASE}/eur-usd.svg`]);
  });
});
