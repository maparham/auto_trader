import { describe, it, expect, beforeEach, vi } from "vitest";
import { installMemStorage } from "./testMemStorage";
installMemStorage();

import { bareInstrument, resolveInstrument } from "./feed";

// The catalogue cache is module-level and keyed by broker, so each test uses
// its own broker id.
let n = 0;
const freshBroker = () => `resolve-broker-${n++}`;

const MARKETS = [
  { epic: "MU", name: "Micron Technology", status: "TRADEABLE", type: "SHARES", pricePrecision: 2 },
  { epic: "EURUSD", name: "EUR/USD", status: "TRADEABLE", type: "CURRENCIES" },
];

function serve(body: unknown, ok = true) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok, json: () => Promise.resolve(body) }));
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveInstrument", () => {
  it("returns the catalogue row for a known epic", async () => {
    serve(MARKETS);
    expect(await resolveInstrument("MU", freshBroker(), 4)).toEqual(MARKETS[0]);
  });

  it("keeps the precision guess when the row has none", async () => {
    serve(MARKETS);
    expect(await resolveInstrument("EURUSD", freshBroker(), 5)).toEqual({ ...MARKETS[1], pricePrecision: 5 });
  });

  it("falls back to a bare instrument for an epic the catalogue lacks", async () => {
    serve(MARKETS);
    expect(await resolveInstrument("VWAV", freshBroker(), 3)).toEqual(bareInstrument("VWAV", 3));
  });

  it("falls back to a bare instrument when the catalogue is slower than the wait", async () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    expect(await resolveInstrument("MU", freshBroker(), 2, 10)).toEqual(bareInstrument("MU", 2));
  });

  it("falls back to a bare instrument when the catalogue fetch fails", async () => {
    serve({}, false);
    expect(await resolveInstrument("MU", freshBroker())).toEqual(bareInstrument("MU", 2));
  });
});
