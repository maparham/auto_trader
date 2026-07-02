# Market Info Popover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the raw key/value `InstrumentDetailsModal` with a curated, Capital-style **anchored popover** (day-range bar, local trading hours, formatted trading info, collapsed raw "All details" section).

**Architecture:** Frontend-only. Data is unchanged (`fetchMarketDetail` → `{instrument, dealingRules, snapshot}`, one fetch on open). Pure formatters live in `frontend/src/lib/marketInfoFormat.ts` (vitest-tested, timezone passed in explicitly). A new `MarketInfoPopover.tsx` renders curated sections + the old generic renderer under a collapsed "All details"; it opens anchored at the legend's ⓘ button and dismisses on outside click / Esc (same pattern as `ContextMenu.tsx`).

**Tech Stack:** React 18 + TypeScript, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-03-market-info-popover-design.md`

## Global Constraints

- Frontend only — no backend or API changes.
- Light-first styling, white card, 1px border, **no box shadows**, content-sized (app UX conventions).
- No legacy shims: `InstrumentDetailsModal.tsx` is deleted, not kept as a wrapper.
- Every curated row/block renders only when its source fields exist — no "—", no `NaN`.
- Commit directly to `main` (1-person team convention).
- Run commands from `frontend/` (`npm run test:unit`, `npx playwright test`).

---

### Task 1: Formatters module (`marketInfoFormat.ts`)

**Files:**
- Create: `frontend/src/lib/marketInfoFormat.ts`
- Test: `frontend/src/lib/marketInfoFormat.test.ts`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces (used by Task 2's component):
  - `interface HoursRow { days: string; hours: string }`
  - `localOpeningHours(oh: Record<string, unknown>, offsetMinutes: number): HoursRow[]`
  - `fundingText(rate: unknown): string | null` — `-0.01096` → `"-0.011%"`
  - `swapTimeText(tsMs: unknown, offsetMinutes: number): string | null` — ms epoch → local `"HH:MM"`
  - `marginText(factor: unknown, unit: unknown): string | null` — `10, "PERCENTAGE"` → `"10.00%"`
  - `leverageText(factor: unknown, unit: unknown): string | null` — `10, "PERCENTAGE"` → `"10:1"`
  - `spreadText(bid: unknown, offer: unknown, decimals: unknown): string | null` — `68.425, 68.457, 3` → `"0.032"`
  - `priceText(v: unknown, decimals: unknown): string | null` — `66.998, 3` → `"66.998"`
  - `rangePosition(low: unknown, high: unknown, price: unknown): number | null` — percent 0–100, clamped
  - `offsetMinutes` everywhere means minutes EAST of UTC, i.e. `-new Date().getTimezoneOffset()`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/marketInfoFormat.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  fundingText,
  leverageText,
  localOpeningHours,
  marginText,
  priceText,
  rangePosition,
  spreadText,
  swapTimeText,
} from "./marketInfoFormat";

// Real OIL_CRUDE opening hours from Capital (zone UTC).
const OIL_HOURS = {
  mon: ["00:00 - 21:00", "22:00 - 00:00"],
  tue: ["00:00 - 21:00", "22:00 - 00:00"],
  wed: ["00:00 - 21:00", "22:00 - 00:00"],
  thu: ["00:00 - 21:00", "22:00 - 00:00"],
  fri: ["00:00 - 17:00"],
  sat: [],
  sun: ["22:00 - 00:00"],
  zone: "UTC",
};

describe("localOpeningHours", () => {
  it("UTC viewer (offset 0): windows pass through, identical days grouped", () => {
    expect(localOpeningHours(OIL_HOURS, 0)).toEqual([
      { days: "Mon – Thu", hours: "00:00 – 21:00, 22:00 – 00:00" },
      { days: "Fri", hours: "00:00 – 17:00" },
      { days: "Sat", hours: "closed" },
      { days: "Sun", hours: "22:00 – 00:00" },
    ]);
  });

  it("UTC+2 viewer: cross-midnight windows merge into the next day (Capital's own rendering)", () => {
    // Sun 22:00–24:00 UTC becomes Mon 00:00–02:00 local and fuses with
    // Mon 02:00–23:00 → "Mon 00:00 – 23:00". Same chain Tue–Fri.
    expect(localOpeningHours(OIL_HOURS, 120)).toEqual([
      { days: "Mon – Thu", hours: "00:00 – 23:00" },
      { days: "Fri", hours: "00:00 – 19:00" },
      { days: "Sat – Sun", hours: "closed" },
    ]);
  });

  it("negative offset (UTC-5): windows split backwards across midnight and wrap into Sunday", () => {
    expect(localOpeningHours(OIL_HOURS, -300)).toEqual([
      { days: "Mon – Thu", hours: "00:00 – 16:00, 17:00 – 00:00" },
      { days: "Fri", hours: "00:00 – 12:00" },
      { days: "Sat", hours: "closed" },
      { days: "Sun", hours: "17:00 – 19:00, 19:00 – 00:00" },
    ]);
  });

  it("returns [] when there are no windows at all", () => {
    expect(localOpeningHours({ zone: "UTC" }, 0)).toEqual([]);
    expect(localOpeningHours({ mon: [], zone: "UTC" }, 0)).toEqual([]);
  });

  it("ignores malformed windows", () => {
    expect(
      localOpeningHours({ mon: ["garbage", "09:00 - 17:00"], zone: "UTC" }, 0),
    ).toEqual([
      { days: "Mon", hours: "09:00 – 17:00" },
      { days: "Tue – Sun", hours: "closed" },
    ]);
  });
});

describe("fundingText", () => {
  it("formats the broker's percent value to 3 decimals", () => {
    expect(fundingText(-0.01096)).toBe("-0.011%");
    expect(fundingText(0.5)).toBe("0.500%");
  });
  it("rejects non-numbers", () => {
    expect(fundingText(undefined)).toBeNull();
    expect(fundingText("x")).toBeNull();
  });
});

describe("swapTimeText", () => {
  // 1783026000000 ms = 2026-07-02 21:00:00 UTC.
  it("renders the charge time in local HH:MM", () => {
    expect(swapTimeText(1783026000000, 0)).toBe("21:00");
    expect(swapTimeText(1783026000000, 120)).toBe("23:00");
    expect(swapTimeText(1783026000000, -300)).toBe("16:00");
  });
  it("wraps past midnight", () => {
    expect(swapTimeText(1783026000000, 240)).toBe("01:00");
  });
  it("rejects non-numbers", () => {
    expect(swapTimeText(null, 0)).toBeNull();
  });
});

describe("marginText / leverageText", () => {
  it("formats percentage margin and derives leverage", () => {
    expect(marginText(10, "PERCENTAGE")).toBe("10.00%");
    expect(leverageText(10, "PERCENTAGE")).toBe("10:1");
    expect(leverageText(5, "PERCENTAGE")).toBe("20:1");
    expect(leverageText(100, "PERCENTAGE")).toBe("1:1");
    expect(leverageText(3, "PERCENTAGE")).toBe("33:1");
    expect(leverageText(66.7, "PERCENTAGE")).toBe("1.5:1");
  });
  it("non-percentage units: margin shown verbatim, no leverage", () => {
    expect(marginText(500, "ABSOLUTE")).toBe("500 ABSOLUTE");
    expect(leverageText(500, "ABSOLUTE")).toBeNull();
  });
  it("rejects missing values", () => {
    expect(marginText(undefined, "PERCENTAGE")).toBeNull();
    expect(leverageText(0, "PERCENTAGE")).toBeNull();
  });
});

describe("spreadText / priceText / rangePosition", () => {
  it("spread = |offer − bid| at instrument precision", () => {
    expect(spreadText(68.425, 68.457, 3)).toBe("0.032");
    expect(spreadText(1.0851, 1.0853, 4)).toBe("0.0002");
  });
  it("spread falls back to 2 decimals on a bogus precision", () => {
    expect(spreadText(10, 10.5, "x")).toBe("0.50");
  });
  it("priceText renders at precision", () => {
    expect(priceText(66.998, 3)).toBe("66.998");
    expect(priceText(66.998, "x")).toBe("67.00");
    expect(priceText("n/a", 3)).toBeNull();
  });
  it("rangePosition maps price into 0–100 and clamps", () => {
    expect(rangePosition(66.998, 68.758, 68.425)).toBeCloseTo(81.08, 1);
    expect(rangePosition(10, 20, 25)).toBe(100);
    expect(rangePosition(10, 20, 5)).toBe(0);
    expect(rangePosition(20, 10, 15)).toBeNull(); // inverted range
    expect(rangePosition(10, 10, 10)).toBeNull(); // zero-width range
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/marketInfoFormat.test.ts`
Expected: FAIL — cannot resolve `./marketInfoFormat`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/lib/marketInfoFormat.ts`:

```ts
// Pure formatters for the market-info popover's curated sections.
//
// Everything timezone-dependent takes an explicit offsetMinutes (minutes EAST
// of UTC — pass `-new Date().getTimezoneOffset()` from the UI) so the functions
// stay deterministic under test regardless of the machine's zone.

const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const DAY_LABEL = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const DAY_MIN = 1440;
const WEEK_MIN = 7 * DAY_MIN;

export interface HoursRow {
  days: string; // "Mon – Thu" / "Fri"
  hours: string; // "00:00 – 23:00, 22:00 – 00:00" or "closed"
}

function hhmm(mins: number): string {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Broker openingHours dict → local-time rows, consecutive identical days
 * grouped. The broker sends per-day windows in ITS zone (UTC for Capital);
 * shifting can push a window across midnight into the neighbor day, where it
 * fuses with that day's windows — exactly how Capital's own app renders it. */
export function localOpeningHours(
  oh: Record<string, unknown>,
  offsetMinutes: number,
): HoursRow[] {
  // 1. Parse to absolute week-minute intervals (Mon 00:00 = 0).
  const intervals: Array<[number, number]> = [];
  DAY_KEYS.forEach((k, day) => {
    const wins = Array.isArray(oh[k]) ? (oh[k] as unknown[]) : [];
    for (const w of wins) {
      if (typeof w !== "string") continue;
      const parts = w.split("-");
      if (parts.length !== 2) continue;
      const a = parseHHMM(parts[0]);
      const b = parseHHMM(parts[1]);
      if (a == null || b == null) continue;
      const start = day * DAY_MIN + a;
      const end = day * DAY_MIN + (b === 0 ? DAY_MIN : b); // "– 00:00" = end of day
      if (end > start) intervals.push([start, end]);
    }
  });
  if (!intervals.length) return [];

  // 2. Shift into local time; wrap around the week edges.
  const shifted: Array<[number, number]> = [];
  for (const [s0, e0] of intervals) {
    let s = s0 + offsetMinutes;
    let e = e0 + offsetMinutes;
    if (s < 0) {
      s += WEEK_MIN;
      e += WEEK_MIN;
    }
    if (e <= WEEK_MIN) shifted.push([s, e]);
    else {
      shifted.push([s, WEEK_MIN]);
      shifted.push([0, e - WEEK_MIN]);
    }
  }

  // 3. Merge overlapping/contiguous intervals (fuses cross-midnight chains).
  shifted.sort((x, y) => x[0] - y[0]);
  const merged: Array<[number, number]> = [];
  for (const iv of shifted) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }

  // 4. Split back into per-day window strings ("hh:mm – hh:mm", 24:00 → 00:00).
  const perDay: string[][] = DAY_KEYS.map(() => []);
  for (const [s, e] of merged) {
    for (let day = Math.floor(s / DAY_MIN); day * DAY_MIN < e && day < 7; day++) {
      const ds = Math.max(s, day * DAY_MIN) - day * DAY_MIN;
      const de = Math.min(e, (day + 1) * DAY_MIN) - day * DAY_MIN;
      if (de > ds) perDay[day].push(`${hhmm(ds)} – ${hhmm(de === DAY_MIN ? 0 : de)}`);
    }
  }

  // 5. Group consecutive days with identical window lists.
  const rows: HoursRow[] = [];
  let i = 0;
  while (i < 7) {
    let j = i;
    while (j + 1 < 7 && perDay[j + 1].join("|") === perDay[i].join("|")) j++;
    rows.push({
      days: i === j ? DAY_LABEL[i] : `${DAY_LABEL[i]} – ${DAY_LABEL[j]}`,
      hours: perDay[i].length ? perDay[i].join(", ") : "closed",
    });
    i = j + 1;
  }
  return rows;
}

/** Overnight-funding rate: the broker's value is already in percent
 * (-0.01096 → "-0.011%"). */
export function fundingText(rate: unknown): string | null {
  if (typeof rate !== "number" || !Number.isFinite(rate)) return null;
  return `${rate.toFixed(3)}%`;
}

/** Swap-charge timestamp (ms epoch) → local wall-clock "HH:MM". */
export function swapTimeText(tsMs: unknown, offsetMinutes: number): string | null {
  if (typeof tsMs !== "number" || !Number.isFinite(tsMs)) return null;
  const mins = ((Math.floor(tsMs / 60000) + offsetMinutes) % DAY_MIN + DAY_MIN) % DAY_MIN;
  return hhmm(mins);
}

/** marginFactor + unit → "10.00%" for PERCENTAGE, verbatim otherwise. */
export function marginText(factor: unknown, unit: unknown): string | null {
  if (typeof factor !== "number" || !Number.isFinite(factor)) return null;
  if (unit === "PERCENTAGE") return `${factor.toFixed(2)}%`;
  return unit == null || unit === "" ? String(factor) : `${factor} ${String(unit)}`;
}

/** Leverage derived from a percentage margin: 10% → "10:1". Whole numbers from
 * 10:1 up, one decimal below. Null for non-percentage units. */
export function leverageText(factor: unknown, unit: unknown): string | null {
  if (unit !== "PERCENTAGE" || typeof factor !== "number" || !(factor > 0)) return null;
  const ratio = 100 / factor;
  const txt = ratio >= 10 ? String(Math.round(ratio)) : String(Math.round(ratio * 10) / 10);
  return `${txt}:1`;
}

/** Spread = |offer − bid| rendered at the instrument's decimal places. */
export function spreadText(bid: unknown, offer: unknown, decimals: unknown): string | null {
  if (typeof bid !== "number" || typeof offer !== "number") return null;
  return Math.abs(offer - bid).toFixed(safeDecimals(decimals));
}

/** A price at the instrument's decimal places. */
export function priceText(v: unknown, decimals: unknown): string | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v.toFixed(safeDecimals(decimals));
}

/** Position of `price` inside [low, high] as 0–100 (clamped); null when the
 * range is missing or degenerate. */
export function rangePosition(low: unknown, high: unknown, price: unknown): number | null {
  if (typeof low !== "number" || typeof high !== "number" || typeof price !== "number") {
    return null;
  }
  if (!(high > low)) return null;
  return Math.min(100, Math.max(0, ((price - low) / (high - low)) * 100));
}

function safeDecimals(d: unknown): number {
  return typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 8 ? d : 2;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/marketInfoFormat.test.ts`
Expected: PASS (all tests). If the UTC-5 grouping expectation disagrees with the implementation, debug the math by hand before touching either side — the test values above were derived from the interval algebra, but verify: Mon 00:00–21:00 UTC −300 = Sun 19:00–Mon 16:00; Mon 22:00–24:00 UTC −300 = Mon 17:00–19:00; Sun 22:00–24:00 UTC −300 = Sun 17:00–19:00.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/marketInfoFormat.ts frontend/src/lib/marketInfoFormat.test.ts
git commit -m "feat(market-info): pure formatters for the curated popover (local hours, funding, leverage, spread)"
```

---

### Task 2: `MarketInfoPopover` component, wiring, CSS + Playwright e2e

**Files:**
- Create: `frontend/src/MarketInfoPopover.tsx`
- Create: `frontend/e2e/market-info.spec.ts`
- Delete: `frontend/src/InstrumentDetailsModal.tsx`
- Modify: `frontend/src/ChartLegend.tsx` (the `onOpenDetails` prop: `112`, `181`, `316`)
- Modify: `frontend/src/ChartCore.tsx` (import line 44; `detailsOpen` state; render at `4453-4460`; legend prop at `4444`)
- Modify: `frontend/src/App.css` (instrument-modal block near line 707)

**Interfaces:**
- Consumes: everything from Task 1 (`localOpeningHours`, `fundingText`, `swapTimeText`, `marginText`, `leverageText`, `spreadText`, `priceText`, `rangePosition`, `HoursRow`); `fetchMarketDetail` / `MarketDetail` from `./lib/feed` (unchanged); `useCloseOnEscape` from `./lib/useCloseOnEscape`; `CloseButton`.
- Produces: `MarketInfoPopover` default export with props `{ epic: string; brokerId: string; title?: string; anchor: { x: number; y: number }; onClose: () => void }`. `ChartLegend`'s `onOpenDetails` prop becomes `(x: number, y: number) => void`.

- [ ] **Step 1: Write the failing e2e test**

Create `frontend/e2e/market-info.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { seedSingleChartDefault, stubStateApi } from "./helpers";

// Curated market-info popover, opened from the legend's ⓘ button. The details
// endpoint is stubbed (values modeled on real OIL_CRUDE data) and the browser
// timezone is pinned to UTC so the local-hours conversion is deterministic.
test.use({ timezoneId: "UTC" });

const DETAILS = {
  instrument: {
    epic: "US100",
    name: "US Tech 100",
    type: "INDICES",
    currency: "USD",
    lotSize: 1,
    guaranteedStopAllowed: true,
    marginFactor: 5,
    marginFactorUnit: "PERCENTAGE",
    openingHours: {
      mon: ["00:00 - 21:00", "22:00 - 00:00"],
      tue: ["00:00 - 21:00", "22:00 - 00:00"],
      wed: ["00:00 - 21:00", "22:00 - 00:00"],
      thu: ["00:00 - 21:00", "22:00 - 00:00"],
      fri: ["00:00 - 17:00"],
      sat: [],
      sun: ["22:00 - 00:00"],
      zone: "UTC",
    },
    overnightFee: {
      longRate: -0.01096,
      shortRate: -0.01096,
      swapChargeTimestamp: 1783026000000, // 21:00 UTC
      swapChargeInterval: 1440,
    },
  },
  dealingRules: {
    minDealSize: { value: 1, unit: "POINTS" },
    maxDealSize: { value: 125000, unit: "POINTS" },
  },
  snapshot: {
    marketStatus: "TRADEABLE",
    bid: 68.425,
    offer: 68.457,
    high: 68.758,
    low: 66.998,
    decimalPlacesFactor: 3,
    percentageChange: 0.02,
  },
};

test("legend ⓘ opens the curated popover; Esc and outside click dismiss", async ({ page }) => {
  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.route("**/api/market/**/details**", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(DETAILS),
    }),
  );

  await page.goto("/");
  await page.locator(".tab-bar").waitFor();

  await page.locator(".cl-info").click();
  const pop = page.locator(".mi-popover");
  await expect(pop).toBeVisible();

  // Header: name + epic.
  await expect(pop.locator(".mi-name")).toHaveText("US Tech 100");
  await expect(pop.locator(".mi-epic")).toHaveText("US100");

  // Day range bar.
  await expect(pop.locator(".mi-range-low")).toContainText("66.998");
  await expect(pop.locator(".mi-range-high")).toContainText("68.758");
  await expect(pop.locator(".mi-range-pill")).toHaveText("68.425");

  // Trading hours, grouped, in the (pinned-UTC) local zone.
  const hours = pop.locator(".mi-hours-row");
  await expect(hours.nth(0)).toContainText("Mon – Thu");
  await expect(hours.nth(0)).toContainText("00:00 – 21:00, 22:00 – 00:00");
  await expect(hours.nth(1)).toContainText("Fri");
  await expect(hours.nth(2)).toContainText("closed");

  // Trading info rows (formatted, not raw).
  await expect(pop).toContainText("USD");
  await expect(pop).toContainText("-0.011%"); // funding, 3 decimals
  await expect(pop).toContainText("21:00"); // swap charge time
  await expect(pop).toContainText("5.00%"); // margin
  await expect(pop).toContainText("20:1"); // leverage
  await expect(pop).toContainText("0.032"); // spread at 3 decimals

  // Raw section is collapsed by default, expands on click.
  await expect(pop.locator(".instrument-section")).toHaveCount(0);
  await pop.locator(".mi-alldetails-toggle").click();
  await expect(pop).toContainText("Guaranteed Stop Allowed");
  await expect(pop).toContainText("Max Deal Size");

  // Esc dismisses.
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);

  // Reopen, outside click dismisses (clicking the ⓘ again must not count as outside).
  await page.locator(".cl-info").click();
  await expect(page.locator(".mi-popover")).toBeVisible();
  await page.mouse.click(600, 400); // chart area, far from the popover
  await expect(page.locator(".mi-popover")).toHaveCount(0);
});
```

- [ ] **Step 2: Run the e2e to verify it fails**

Run: `cd frontend && npx playwright test e2e/market-info.spec.ts`
Expected: FAIL — `.mi-popover` never appears (the old modal renders instead).

- [ ] **Step 3: Create the popover component**

Create `frontend/src/MarketInfoPopover.tsx`:

```tsx
// Market-info popover — opened from the ⓘ button in the chart legend, anchored
// at the button (TradingView/Capital-style), dismissed by outside click or Esc.
//
// Curated sections up top (day range bar, local trading hours, formatted
// trading info), and the FULL raw broker payload under a collapsed "All
// details" — so curation never hides anything the broker sends, and new broker
// fields keep appearing with zero code changes (the old modal's guarantee).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import CloseButton from "./CloseButton";
import { fetchMarketDetail, type MarketDetail } from "./lib/feed";
import { useCloseOnEscape } from "./lib/useCloseOnEscape";
import {
  fundingText,
  leverageText,
  localOpeningHours,
  marginText,
  priceText,
  rangePosition,
  spreadText,
  swapTimeText,
} from "./lib/marketInfoFormat";

interface Props {
  epic: string;
  // Active data broker id — the detail is broker-specific (epics aren't portable).
  brokerId: string;
  // Friendly title (e.g. the legend symbol name); falls back to epic.
  title?: string;
  // Viewport point to anchor the top-left corner at (the ⓘ button's bottom-left).
  anchor: { x: number; y: number };
  onClose: () => void;
}

const WIDTH = 300;
const MARGIN = 8; // min gap to the viewport edges

// ---------------------------------------------------------------------------
// Generic raw renderer (unchanged from the old InstrumentDetailsModal) — feeds
// the "All details" section. Renders whatever the broker sends, skips empties.
// ---------------------------------------------------------------------------

function humanize(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  const titled = spaced.charAt(0).toUpperCase() + spaced.slice(1);
  return titled.replace(/\b(Utc|Id|Epic|Fx|Cfd)\b/gi, (m) => m.toUpperCase());
}

function isEmpty(v: unknown): boolean {
  return v == null || v === "" || v === "-";
}

function formatValue(key: string, v: unknown): string | null {
  if (isEmpty(v)) return null;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number" || typeof v === "string") return String(v);
  if (Array.isArray(v)) {
    const parts = v.map((x) => formatValue(key, x)).filter((x): x is string => x != null);
    return parts.length ? parts.join(", ") : null;
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("value" in o && !isEmpty(o.value)) {
      return isEmpty(o.unit) ? String(o.value) : `${o.value} ${o.unit}`;
    }
    if (key.toLowerCase().includes("hours")) return formatRawOpeningHours(o);
    const pairs = Object.entries(o)
      .map(([k, val]) => {
        const f = formatValue(k, val);
        return f == null ? null : `${humanize(k)}: ${f}`;
      })
      .filter((x): x is string => x != null);
    return pairs.length ? pairs.join("; ") : null;
  }
  return null;
}

const DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const DAY_LABEL: Record<string, string> = {
  mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun",
};

function formatRawOpeningHours(o: Record<string, unknown>): string | null {
  const zone = typeof o.zone === "string" ? o.zone : "";
  const lines = DAY_ORDER.filter((d) => d in o).map((d) => {
    const wins = Array.isArray(o[d]) ? (o[d] as unknown[]).map(String) : [];
    return `${DAY_LABEL[d]}  ${wins.length ? wins.join(", ") : "closed"}`;
  });
  if (!lines.length) return null;
  return lines.join("\n") + (zone ? `\n(${zone})` : "");
}

function rowsFor(section: Record<string, unknown>): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  for (const [k, v] of Object.entries(section)) {
    const value = formatValue(k, v);
    if (value != null) out.push({ label: humanize(k), value });
  }
  return out;
}

const RAW_SECTIONS: Array<{ key: keyof MarketDetail; title: string }> = [
  { key: "instrument", title: "Instrument" },
  { key: "dealingRules", title: "Dealing rules" },
  { key: "snapshot", title: "Market snapshot" },
];

// Safe typed getters into the untyped sections.
function num(o: Record<string, unknown>, k: string): number | undefined {
  const v = o[k];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function str(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k];
  return typeof v === "string" && v !== "" && v !== "-" ? v : undefined;
}
function obj(o: Record<string, unknown>, k: string): Record<string, unknown> | undefined {
  const v = o[k];
  return v != null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

export default function MarketInfoPopover({ epic, brokerId, title, anchor, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [detail, setDetail] = useState<MarketDetail | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [showRaw, setShowRaw] = useState(false);
  // Clamped position — starts at the anchor, adjusted after measuring.
  const [pos, setPos] = useState(anchor);

  // One fetch on open (not polled — the snapshot is a point-in-time quote and
  // that's fine for a click-to-open view).
  useEffect(() => {
    let cancelled = false;
    setState("loading");
    void fetchMarketDetail(epic, brokerId).then((d) => {
      if (cancelled) return;
      if (d) {
        setDetail(d);
        setState("ready");
      } else {
        setState("error");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [epic, brokerId]);

  useCloseOnEscape(onClose);

  // Outside mousedown dismisses (same pattern as ContextMenu). The opening
  // click was a `click` on the ⓘ, so its own mousedown predates this listener.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  // Keep the card inside the viewport once its real size is known (content
  // changes across loading → ready → raw expanded).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(MARGIN, Math.min(anchor.x, window.innerWidth - r.width - MARGIN)),
      y: Math.max(MARGIN, Math.min(anchor.y, window.innerHeight - r.height - MARGIN)),
    });
  }, [anchor, state, showRaw]);

  const offsetMinutes = -new Date().getTimezoneOffset();

  const inst = detail?.instrument ?? {};
  const rules = detail?.dealingRules ?? {};
  const snap = detail?.snapshot ?? {};

  const decimals = num(snap, "decimalPlacesFactor");
  const low = num(snap, "low");
  const high = num(snap, "high");
  const bid = num(snap, "bid");
  const offer = num(snap, "offer");
  const rangePct = rangePosition(low, high, bid);

  const hoursDict = obj(inst, "openingHours");
  const hourRows = hoursDict ? localOpeningHours(hoursDict, offsetMinutes) : [];

  const fee = obj(inst, "overnightFee");
  const feeLong = fee ? fundingText(fee.longRate) : null;
  const feeShort = fee ? fundingText(fee.shortRate) : null;
  const feeTime = fee ? swapTimeText(fee.swapChargeTimestamp, offsetMinutes) : null;

  const minSize = formatValue("minDealSize", rules.minDealSize);
  const margin = marginText(num(inst, "marginFactor"), inst.marginFactorUnit);
  const leverage = leverageText(num(inst, "marginFactor"), inst.marginFactorUnit);
  const spread = spreadText(bid, offer, decimals);

  const infoRows: Array<{ label: string; value: string }> = [];
  const currency = str(inst, "currency");
  if (currency) infoRows.push({ label: "Currency", value: currency });
  if (minSize) infoRows.push({ label: "Min size", value: minSize });
  if (margin) infoRows.push({ label: "Margin", value: margin });
  if (leverage) infoRows.push({ label: "Leverage", value: leverage });
  if (spread) infoRows.push({ label: "Spread", value: spread });
  const type = str(inst, "type");
  if (type) infoRows.push({ label: "Type", value: type });

  return (
    <div
      ref={ref}
      className="mi-popover"
      style={{ left: pos.x, top: pos.y, width: WIDTH }}
    >
      <div className="mi-head">
        <div className="mi-titles">
          <span className="mi-name">{title || epic}</span>
          <span className="mi-epic">{epic}</span>
        </div>
        <CloseButton onClick={onClose} />
      </div>

      {state === "loading" && <p className="instrument-note">Loading…</p>}
      {state === "error" && (
        <p className="instrument-note">Couldn’t load instrument details.</p>
      )}

      {state === "ready" && detail && (
        <>
          {rangePct != null && (
            <div className="mi-section">
              <div className="mi-section-title">Day range</div>
              <div className="mi-range">
                <div className="mi-range-track">
                  <div className="mi-range-marker" style={{ left: `${rangePct}%` }} />
                  <div
                    className="mi-range-pill"
                    style={{ left: `${rangePct}%` }}
                  >
                    {priceText(bid, decimals)}
                  </div>
                </div>
                <div className="mi-range-ends">
                  <span className="mi-range-low">Low {priceText(low, decimals)}</span>
                  <span className="mi-range-high">High {priceText(high, decimals)}</span>
                </div>
              </div>
            </div>
          )}

          {hourRows.length > 0 && (
            <div className="mi-section">
              <div className="mi-section-title">
                Trading hours <span className="mi-caption">your local time</span>
              </div>
              {hourRows.map((r) => (
                <div className="mi-hours-row" key={r.days}>
                  <span className="mi-hours-days">{r.days}</span>
                  <span className="mi-hours-times">{r.hours}</span>
                </div>
              ))}
            </div>
          )}

          {(infoRows.length > 0 || feeLong || feeShort) && (
            <div className="mi-section">
              <div className="mi-section-title">Trading info</div>
              {infoRows.slice(0, 2).map((r) => (
                <div className="mi-row" key={r.label}>
                  <span className="mi-label">{r.label}</span>
                  <span className="mi-value">{r.value}</span>
                </div>
              ))}
              {(feeLong || feeShort) && (
                <div className="mi-funding">
                  <div className="mi-row">
                    <span className="mi-label">Overnight funding</span>
                  </div>
                  {feeLong && (
                    <div className="mi-row mi-sub">
                      <span className="mi-label">Long</span>
                      <span className="mi-value">{feeLong}</span>
                    </div>
                  )}
                  {feeShort && (
                    <div className="mi-row mi-sub">
                      <span className="mi-label">Short</span>
                      <span className="mi-value">{feeShort}</span>
                    </div>
                  )}
                  {feeTime && (
                    <div className="mi-row mi-sub">
                      <span className="mi-label">Time</span>
                      <span className="mi-value">{feeTime}</span>
                    </div>
                  )}
                </div>
              )}
              {infoRows.slice(2).map((r) => (
                <div className="mi-row" key={r.label}>
                  <span className="mi-label">{r.label}</span>
                  <span className="mi-value">{r.value}</span>
                </div>
              ))}
            </div>
          )}

          <button
            className="mi-alldetails-toggle"
            onClick={() => setShowRaw((s) => !s)}
          >
            <span className={`mi-chevron${showRaw ? " open" : ""}`}>▸</span> All details
          </button>
          {showRaw &&
            RAW_SECTIONS.map(({ key, title: sectionTitle }) => {
              const rows = rowsFor(detail[key]);
              if (!rows.length) return null;
              return (
                <div className="instrument-section" key={key}>
                  <div className="instrument-section-title">{sectionTitle}</div>
                  <dl className="instrument-grid">
                    {rows.map((r) => (
                      <div className="instrument-row" key={r.label}>
                        <dt>{r.label}</dt>
                        <dd>{r.value}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              );
            })}
        </>
      )}
    </div>
  );
}
```

Note the "Trading info" row order intentionally interleaves the funding block after the first two rows (Currency, Min size) to mirror Capital's sheet.

- [ ] **Step 4: Rewire the legend and ChartCore; delete the old modal**

In `frontend/src/ChartLegend.tsx`:

The prop declaration (line ~112) becomes:

```ts
  // Open the market-info popover, anchored at the ⓘ button (viewport coords).
  onOpenDetails: (x: number, y: number) => void;
```

The ⓘ button's onClick (line ~314) becomes:

```tsx
          onClick={(e) => {
            e.stopPropagation();
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            onOpenDetails(r.left, r.bottom + 6);
          }}
```

In `frontend/src/ChartCore.tsx`:

1. Replace the import (line 44):

```ts
import MarketInfoPopover from "./MarketInfoPopover";
```

2. Find the `detailsOpen` state declaration (`grep -n "detailsOpen" src/ChartCore.tsx`) and replace it with:

```ts
  // Market-info popover anchor (viewport coords of the legend ⓘ); null = closed.
  const [detailsAnchor, setDetailsAnchor] = useState<{ x: number; y: number } | null>(null);
```

3. The legend prop (line ~4444) becomes:

```tsx
        onOpenDetails={(x, y) => setDetailsAnchor({ x, y })}
```

4. The render block (lines ~4453-4460) becomes:

```tsx
      {detailsAnchor && (
        <MarketInfoPopover
          epic={symbol.epic}
          brokerId={brokerId}
          title={symbol.name ?? symbol.epic}
          anchor={detailsAnchor}
          onClose={() => setDetailsAnchor(null)}
        />
      )}
```

5. Delete the old component:

```bash
rm frontend/src/InstrumentDetailsModal.tsx
```

6. Confirm nothing else references it:

```bash
grep -rn "InstrumentDetailsModal" frontend/src frontend/e2e
```

Expected: no matches.

- [ ] **Step 5: Add the CSS**

In `frontend/src/App.css`, replace the line `.instrument-modal { width: 460px; }` (~line 707) with the popover styles. Keep the existing `.instrument-title/.instrument-body` rules if other code uses them — check with `grep -n "instrument-title\|instrument-body" frontend/src/*.tsx`; if only the deleted modal used them, remove those two rules. Keep `.instrument-note`, `.instrument-section*`, `.instrument-grid`, `.instrument-row` (reused by the raw section).

```css
/* Market-info popover (legend ⓘ) — anchored card, no backdrop, no shadow. */
.mi-popover {
  position: fixed;
  z-index: 60;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px 12px 12px;
  max-height: 70vh;
  overflow-y: auto;
  font-size: 12px;
}
.mi-head { display: flex; align-items: flex-start; gap: 8px; }
.mi-titles { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.mi-name { font-weight: 600; font-size: 13px; }
.mi-epic { color: var(--text-dim); font-size: 11px; }
.mi-section { margin-top: 12px; }
.mi-section-title { font-weight: 600; margin-bottom: 6px; }
.mi-caption { color: var(--text-dim); font-weight: 400; font-size: 11px; }

/* Day range bar */
.mi-range-track {
  position: relative;
  height: 4px;
  border-radius: 2px;
  background: var(--border);
  margin: 26px 0 6px; /* room for the pill above */
}
.mi-range-marker {
  position: absolute;
  top: -3px;
  width: 2px;
  height: 10px;
  background: var(--text);
  transform: translateX(-50%);
}
.mi-range-pill {
  position: absolute;
  bottom: 10px;
  transform: translateX(-50%);
  background: var(--text);
  color: var(--bg);
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 11px;
  white-space: nowrap;
}
.mi-range-ends { display: flex; justify-content: space-between; }
.mi-range-low { color: var(--down, #d33); }
.mi-range-high { color: var(--up, #2962ff); }

/* Hour + info rows */
.mi-hours-row,
.mi-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 3px 0;
}
.mi-hours-days,
.mi-label { color: var(--text-dim); flex-shrink: 0; }
.mi-hours-times,
.mi-value { text-align: right; }
.mi-funding { margin: 2px 0; }
.mi-row.mi-sub { padding-left: 12px; }

/* Collapsed raw section */
.mi-alldetails-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 12px;
  padding: 0;
  border: none;
  background: none;
  color: var(--text-dim);
  font-size: 12px;
  cursor: pointer;
}
.mi-alldetails-toggle:hover { color: var(--text); }
.mi-chevron { display: inline-block; transition: transform 0.1s; }
.mi-chevron.open { transform: rotate(90deg); }
```

CSS variables: before using `var(--bg)`, `var(--border)`, `var(--text)`, `var(--text-dim)`, `var(--up)`, `var(--down)`, check the top of `App.css` for the actual variable names the app defines (e.g. they may be `--panel-bg` / `--line`); use the app's real tokens — the popover must match the existing dropdown-menu look in both themes. If no up/down tokens exist, use the concrete colors the legend/OHLC code uses for up/down values.

- [ ] **Step 6: Type-check and run the e2e**

```bash
cd frontend && npx tsc --noEmit && npx playwright test e2e/market-info.spec.ts
```

Expected: tsc clean; e2e PASS. Common failures:
- Popover closes instantly on open → the ⓘ `click` bubbled a `mousedown` that predates the listener; verify the button handler calls `e.stopPropagation()` (it does not stop the native mousedown — but the listener attaches AFTER the opening mousedown already fired, so this should not occur; if it does, add `{ capture: false }` and register the listener in a `setTimeout(0)`).
- Hours assertions fail → check `timezoneId: "UTC"` is in the spec before blaming the math.

- [ ] **Step 7: Run the full unit + e2e suites**

```bash
cd frontend && npm run test:unit && npx playwright test
```

Expected: all green (pre-existing failures unrelated to this change are acceptable only if they also fail on a clean checkout — verify with `git stash && npx playwright test <failing spec> && git stash pop` before dismissing one).

- [ ] **Step 8: Commit**

```bash
git add -A frontend/src frontend/e2e frontend/src/App.css
git commit -m "feat(market-info): curated anchored popover replaces the raw instrument-details modal"
```

---

### Task 3: Visual verification in the running app

**Files:** none (verification only; small CSS polish edits to `frontend/src/App.css` allowed).

**Interfaces:** consumes the running dev server (do NOT restart the user's HMR servers — they're already running; check with `lsof -iTCP -sTCP:LISTEN | grep -i node` / try the app port first).

- [ ] **Step 1: Open the app in the browser** (claude-in-chrome, new tab, set a document.title like "market-info check"), navigate to the dev app, open a chart, click the legend ⓘ.
- [ ] **Step 2: Screenshot the popover** in the light theme (the canonical one) and compare against the design: anchored at ⓘ, white card 1px border no shadow, range bar with pill, grouped local hours, formatted trading info, "All details" collapsed.
- [ ] **Step 3: Check edge behavior**: click ⓘ near the right viewport edge (narrow window) — popover stays inside the viewport; expand "All details" — popover scrolls internally, still clamped.
- [ ] **Step 4: Dismiss checks**: Esc, outside click, and switching symbol while open (popover should just close or refetch — clicking the symbol name closes it via outside-click, which is fine).
- [ ] **Step 5: Fix any visual misses** (spacing, token colors) directly in `App.css`, re-screenshot, then commit:

```bash
git add frontend/src/App.css
git commit -m "style(market-info): popover polish after in-app visual check"
```

- [ ] **Step 6: Close the browser tab I opened** (dev-environment convention).

---

## Self-Review (done at plan-writing time)

- **Spec coverage:** shell/anchor/dismiss (Task 2 steps 3-4), curated sections incl. conditional rendering (Task 2 step 3), formatters + tests (Task 1), raw All-details (Task 2 step 3), CSS conventions (Task 2 step 5), e2e (Task 2 steps 1/6), error/loading states (component keeps the old copy). Backend untouched throughout. ✓
- **Placeholders:** none — all code inline. The CSS-token caveat in Task 2 Step 5 is a deliberate verify-against-codebase instruction, not a TBD.
- **Type consistency:** `HoursRow {days, hours}` matches between module, tests, and component; `onOpenDetails(x, y)` matches ChartLegend prop, button handler, and ChartCore usage; `anchor: {x, y}` prop consistent. ✓
