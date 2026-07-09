# Set-to-breakeven stop + merged breakeven line — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Set to breakeven" button to the position edit form that stages `SL = entry`, and render the resulting entry/SL overlap as a single merged red line + one `· BE`-tagged pill instead of two lines stacked on the same price row.

**Architecture:** Everything is level-derived per render — no stored "breakeven mode" flag. A shared pure helper `isBreakeven(price, stop, precision)` in `trading.ts` decides the merge; three render layers (line specs, DOM pill, and — verified only — the bracket) key off it. The button stages into `pendingEditsSignal` exactly like a drag, and the existing **Update** commits it.

**Tech Stack:** React 19 + TypeScript, klinecharts overlays, Vitest for unit tests. Frontend lives in `frontend/`.

## Global Constraints

- Work directly on `main` (1-person team; do not branch).
- Frontend commands run from `frontend/`. Unit tests: `npm run test:unit` (Vitest, node env). Type/build check: `npm run build`.
- Use the shared `Tooltip`/`InfoTip` components, never native `title=` for NEW tooltips (per CLAUDE.md). (Existing `title=` in touched files may stay.)
- Breakeven price is always `round(entry)` to the instrument `precision`; `entry = trade.priceLevel`. Tick = `10 ** -precision`.
- The button is position-only, in-profit-only, and never appears on resting orders or the new-order ticket.
- Colors already defined in `positionLines.ts`: `STOP_COLOR = "#f23645"`, `PRICE_COLOR = "#6b7280"`, `TP_COLOR = "#089981"`.

---

### Task 1: `isBreakeven` + `breakevenEligible` helpers

**Files:**
- Modify: `frontend/src/lib/trading.ts` (add two exported functions near `clampLevelToPrice`, ~line 582)
- Test: `frontend/src/lib/trading.test.ts` (append a new `describe` block)

**Interfaces:**
- Consumes: `OrderSide` (already defined in `trading.ts`), `TradeView` (already defined in `trading.ts`).
- Produces:
  - `isBreakeven(price: number | null, stop: number | null, precision: number): boolean` — true when both are non-null and `|stop - price| < 10 ** -precision`.
  - `breakevenEligible(trade: TradeView, latest: number | null, precision: number): boolean` — true when the "Set to breakeven" button should show.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/trading.test.ts`. Note the file imports via top-level `await import("./trading")` — add the two names to that destructure (line ~12) AND add the `describe` blocks:

Add `isBreakeven, breakevenEligible,` to the existing destructure:

```ts
const {
  clampLevelToPrice,
  brokerLabel,
  noteBrokerLabels,
  isCapital,
  migrateCapitalLiveAccountKeys,
  isBreakeven,
  breakevenEligible,
} = await import("./trading");
```

Then append these blocks at the end of the file:

```ts
describe("isBreakeven", () => {
  it("true when stop equals price", () => {
    expect(isBreakeven(100, 100, 2)).toBe(true);
  });
  it("true when within one tick", () => {
    expect(isBreakeven(100, 100.004, 2)).toBe(true); // tick = 0.01
  });
  it("false when a full tick apart", () => {
    expect(isBreakeven(100, 100.01, 2)).toBe(false);
  });
  it("false when either level is null", () => {
    expect(isBreakeven(null, 100, 2)).toBe(false);
    expect(isBreakeven(100, null, 2)).toBe(false);
  });
  it("respects precision (5dp: 0.00001 tick)", () => {
    expect(isBreakeven(1.23456, 1.234569, 5)).toBe(true);
    expect(isBreakeven(1.23456, 1.23457, 5)).toBe(false);
  });
});

describe("breakevenEligible", () => {
  const pos = (over = {}) => ({
    kind: "position" as const, id: "D1", epic: "EURUSD", side: "buy" as const,
    quantity: 2, priceLevel: 100, stop: null, takeProfit: null, upnl: null,
    openedAt: null, leverage: null, margin: null, ...over,
  });
  it("long in profit (price above entry) is eligible", () => {
    expect(breakevenEligible(pos(), 101, 2)).toBe(true);
  });
  it("long at a loss (price below entry) is NOT eligible", () => {
    expect(breakevenEligible(pos(), 99, 2)).toBe(false);
  });
  it("short in profit (price below entry) is eligible", () => {
    expect(breakevenEligible(pos({ side: "sell" }), 99, 2)).toBe(true);
  });
  it("not eligible without a latest price", () => {
    expect(breakevenEligible(pos(), null, 2)).toBe(false);
  });
  it("not eligible for a resting order", () => {
    expect(breakevenEligible(pos({ kind: "order" }), 101, 2)).toBe(false);
  });
  it("not eligible when the stop is already at breakeven", () => {
    expect(breakevenEligible(pos({ stop: 100 }), 101, 2)).toBe(false);
  });
  it("rounds entry to precision before the side check (sub-tick sliver)", () => {
    // entry 100.507 rounds to 100.51 at 2dp; latest 100.509 is barely in profit
    // but round(entry) 100.51 is NOT below it → staging BE would be rejected → hide.
    expect(breakevenEligible(pos({ priceLevel: 100.507 }), 100.509, 2)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npm run test:unit -- trading.test`
Expected: FAIL — `isBreakeven is not a function` / `breakevenEligible is not a function`.

- [ ] **Step 3: Implement the helpers**

In `frontend/src/lib/trading.ts`, immediately after `clampLevelToPrice` (before `mergeTradeLevels`, ~line 583), add:

```ts
/** True when a stop sits at its entry (within one tick) — the "breakeven" state
 *  where the SL and entry lines would render on the same price row and collapse
 *  into one. Level-derived; shared by the chart line specs, the DOM pill, and the
 *  edit form so they never disagree. */
export function isBreakeven(
  price: number | null,
  stop: number | null,
  precision: number,
): boolean {
  if (price == null || stop == null) return false;
  const tick = 10 ** -precision;
  return Math.abs(stop - price) < tick;
}

/** Whether the edit form should offer "Set to breakeven": an OPEN position, in
 *  profit, whose rounded entry would be a VALID stop (below the latest for a long,
 *  above for a short), and not already at breakeven. Gating on the ROUNDED entry —
 *  not raw `latest > entry` — closes the sub-tick sliver where round(entry) lands
 *  the wrong side of a barely-profitable price and Update would be rejected. */
export function breakevenEligible(
  trade: TradeView,
  latest: number | null,
  precision: number,
): boolean {
  if (trade.kind !== "position" || latest == null) return false;
  const be = Number(trade.priceLevel.toFixed(precision));
  const validStop = trade.side === "buy" ? be < latest : be > latest;
  if (!validStop) return false;
  return !isBreakeven(trade.priceLevel, trade.stop, precision);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npm run test:unit -- trading.test`
Expected: PASS (all existing + new tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/mahmoudparham/auto_trader
git add frontend/src/lib/trading.ts frontend/src/lib/trading.test.ts
git commit -m "feat(trading): isBreakeven + breakevenEligible helpers"
```

---

### Task 2: Merged breakeven line spec

**Files:**
- Modify: `frontend/src/lib/positionLines.ts` (`tradeLineSpecs`, the price block ~127-152 and stop block ~153-166)
- Test: `frontend/src/lib/positionLines.test.ts` (append to the `tradeLineSpecs` describe)

**Interfaces:**
- Consumes: `isBreakeven` from `./trading` (Task 1).
- Produces: for a position at breakeven, `tradeLineSpecs` emits a SINGLE `${id}:price` spec (red, non-draggable, `bar`-anchored, label suffixed `· BE`) and NO `${id}:stop` spec. Non-breakeven and orders are unchanged.

- [ ] **Step 1: Write the failing tests**

Append inside the `describe("tradeLineSpecs", ...)` block in `frontend/src/lib/positionLines.test.ts`:

```ts
it("merges entry+SL into one red '· BE' line when SL sits at entry (position)", () => {
  const specs = tradeLineSpecs({
    ...base,
    trades: [trade({ priceLevel: 100, stop: 100, openedAt: 1_700_000_000_000 })],
  });
  // Only the entry line survives — no separate :stop.
  expect(specs.map((s) => s.key)).toEqual(["D1:price"]);
  const merged = specs[0];
  expect(merged.color).toBe("#f23645"); // STOP_COLOR — the stop is the live constraint
  expect(merged.draggable).toBe(false); // display-only; un-breakeven via the form
  expect(merged.restKind).toBe("bar"); // keeps the entry-candle anchor + dot
  expect(merged.label).toBe("Long 2 @ 100.00 · BE");
});

it("does NOT merge when SL is a tick away from entry", () => {
  const specs = tradeLineSpecs({
    ...base,
    trades: [trade({ priceLevel: 100, stop: 99.99, openedAt: 1 })],
  });
  expect(specs.map((s) => s.key)).toEqual(["D1:price", "D1:stop"]);
  expect(specs[0].color).toBe("#6b7280"); // PRICE_COLOR — normal entry
});

it("respects a pending SL dragged to entry (merges) via presence-merge", () => {
  const specs = tradeLineSpecs({
    ...base,
    trades: [trade({ priceLevel: 100, stop: 95, openedAt: 1 })],
    pending: { D1: { stop: 100 } },
  });
  expect(specs.map((s) => s.key)).toEqual(["D1:price"]);
  expect(specs[0].label).toBe("Long 2 @ 100.00 · BE");
});

it("never merges a resting order (no fill) even if stop equals price", () => {
  const specs = tradeLineSpecs({
    ...base,
    trades: [trade({ kind: "order", id: "O1", priceLevel: 100, stop: 100 })],
  });
  expect(specs.map((s) => s.key)).toEqual(["O1:price", "O1:stop"]);
  expect(specs.find((s) => s.key === "O1:price")?.color).toBe("#6b7280");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npm run test:unit -- positionLines.test`
Expected: FAIL — the merge tests see `["D1:price","D1:stop"]` / neutral color.

- [ ] **Step 3: Implement the merge**

In `frontend/src/lib/positionLines.ts`:

Add to the import at line 20:

```ts
import { tradeLabel, isBreakeven, type TradeView } from "./trading";
```

Inside `tradeLineSpecs`, after computing `stop` and `tp` (~line 125), compute the merge flag:

```ts
    // A position whose stop sits at its entry (within a tick) is at BREAKEVEN: the
    // SL and entry lines would render on the same row. Collapse them into ONE red,
    // '· BE'-tagged entry line and drop the separate SL line. Orders never merge.
    const breakeven = t.kind === "position" && isBreakeven(price, stop, o.precision);
```

In the `if (price != null)` block, change the pushed spec's `color`, `label`, and `draggable` to account for breakeven. Replace the existing `specs.push({ ... })` for `:price` (lines ~133-151) with:

```ts
      specs.push({
        key: `${t.id}:price`,
        level: price,
        // At breakeven the one line IS the stop → paint it red; otherwise neutral entry.
        color: breakeven ? STOP_COLOR : PRICE_COLOR,
        side: t.side,
        label:
          o.hideTradeLabels || focusedField === "price"
            ? ""
            : `${word} ${t.quantity} @ ${fmt(price)}${pnlStr}${breakeven ? " · BE" : ""}`,
        // A resting order's price line is draggable to reprice it; a filled
        // position's entry is fixed (you can't change a fill), so never draggable.
        draggable: t.kind === "order",
        highlight,
        selected,
        emphasized,
        restKind: t.kind === "order" ? "full" : t.openedAt != null ? "bar" : "stub",
        entryTs: t.kind === "position" ? t.openedAt ?? undefined : undefined,
        onDragEnd: (lvl) => o.onDrag(t.id, "price", lvl),
      });
```

Then gate the `:stop` push so it is skipped at breakeven. Change line ~153 from `if (stop != null) {` to:

```ts
    if (stop != null && !breakeven) {
```

(The `:tp` block is unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npm run test:unit -- positionLines.test`
Expected: PASS (existing + new).

- [ ] **Step 5: Commit**

```bash
cd /Users/mahmoudparham/auto_trader
git add frontend/src/lib/positionLines.ts frontend/src/lib/positionLines.test.ts
git commit -m "feat(chart): merge entry+SL into one breakeven line at same price"
```

---

### Task 3: DOM pill — drop the stop pill, tag the entry pill `BE`

**Files:**
- Modify: `frontend/src/ChartCore.tsx` (pill type ~1306-1318; pill build ~4244-4262; pill render map ~5683-5745)
- Modify: `frontend/src/App.css` (add `.tp-be` chip style near `.trade-pill .tp-plhint` ~line 1920)

**Interfaces:**
- Consumes: `isBreakeven` from `./lib/trading`; `merged` (from `mergeTradeLevels`) and `precisionRef` already in scope at the pill build site.
- Produces: at breakeven the pills array contains one entry pill flagged `breakeven: true` and NO `stop` pill; the render shows a small `BE` chip.

No unit test — `ChartCore.tsx` is integration-tested via the app, not Vitest. Verify by build + visual.

- [ ] **Step 1: Add `breakeven` to the pill state type**

In `frontend/src/ChartCore.tsx`, extend the `tradePills` state shape (~line 1316), adding after `changed: boolean;`:

```ts
      changed: boolean; // this line has an un-applied drag → show Apply/Discard
      breakeven?: boolean; // entry pill only: SL sits at entry → show a "BE" chip
```

- [ ] **Step 2: Import `isBreakeven`**

Find the existing import of `mergeTradeLevels` from `./lib/trading` in `ChartCore.tsx` and add `isBreakeven` to it. (Search for `mergeTradeLevels` in the import list near the top.)

```ts
// e.g. import { ..., mergeTradeLevels, isBreakeven, ... } from "./lib/trading";
```

- [ ] **Step 3: Skip the stop pill and flag the entry pill at breakeven**

In the pill build loop (`frontend/src/ChartCore.tsx` ~4244-4262), after `const merged = mergeTradeLevels(t, pend);` add:

```ts
        const be = t.kind === "position" && isBreakeven(merged.price ?? t.priceLevel, merged.stop, precisionRef.current);
```

Change the entry-pill push (~4253-4254) to carry the flag:

```ts
        if (yP != null)
          pills.push({ ...common, field: "price", y: yP, level: priceLvl, pl: t.kind === "position" ? t.upnl : null, changed: pend.price !== undefined, breakeven: be });
```

Change the stop-pill guard (~4255) so it is skipped at breakeven:

```ts
        if (merged.stop != null && !be) {
```

- [ ] **Step 4: Render the `BE` chip**

In the pill render map (~5735-5739), after the price `<span>` and before the P/L spans, add the chip. Locate:

```tsx
            <span className="tp-price">
              {isEntry && <span className="tp-at">@</span>}{priceText}
            </span>
```

Add immediately after it:

```tsx
            {p.breakeven && <span className="tp-be" title="Stop at breakeven">BE</span>}
```

- [ ] **Step 5: Style the chip**

In `frontend/src/App.css`, after the `.trade-pill .tp-plhint` rule (~line 1920), add:

```css
/* Breakeven chip on the merged entry pill: the stop sits at entry, so the pill is
   red (role color) and carries a compact "BE" tag instead of a second SL pill. */
.trade-pill .tp-be {
  font-family: var(--mono);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: #fff;
  background: var(--pill);
  border-radius: 3px;
  padding: 0 3px;
  line-height: 14px;
}
```

- [ ] **Step 6: Build to verify types + compile**

Run: `cd frontend && npm run build`
Expected: PASS (no type errors).

- [ ] **Step 7: Commit**

```bash
cd /Users/mahmoudparham/auto_trader
git add frontend/src/ChartCore.tsx frontend/src/App.css
git commit -m "feat(chart): merged breakeven pill (drop SL pill, add BE chip)"
```

---

### Task 4: "Set to breakeven" button in the edit form

**Files:**
- Modify: `frontend/src/OrderTicket.tsx` (`EditTicket`, the Stop-loss `ExitRow` area ~674-683; imports ~17-31)
- Modify: `frontend/src/App.css` (add `.ot-be-btn` near the exits styles ~line 3037)

**Interfaces:**
- Consumes: `breakevenEligible` from `./lib/trading` (Task 1); `latest`, `long`, `trade`, `precision`, `patch`, `round` already in scope in `EditTicket`.
- Produces: a button that stages `stop = round(trade.priceLevel)` into pending; committed by the existing **Update**.

No unit test — component-level; the eligibility logic is already unit-tested via `breakevenEligible` (Task 1). Verify by build + visual.

- [ ] **Step 1: Import the helper**

In `frontend/src/OrderTicket.tsx`, add `breakevenEligible` to the existing `./lib/trading` import (lines 17-31):

```ts
import {
  applyEditedLevels,
  mergeTradeLevels,
  clampLevelToPrice,
  breakevenEligible,
  getLivePrice,
  // ...rest unchanged
} from "./lib/trading";
```

- [ ] **Step 2: Compute eligibility + handler in `EditTicket`**

In `EditTicket`, after `const stopValid = sideValid("stop", stop);` (~line 608), add:

```ts
  // "Set to breakeven": stage SL exactly at the fill (rounded to precision). Offered
  // only for an in-profit open position whose rounded entry is a valid stop (see
  // breakevenEligible) — so clicking can never stage a stop the broker would reject.
  const canBreakeven = breakevenEligible(trade, latest, precision);
  const setBreakeven = () => patch({ stop: round(trade.priceLevel) });
```

- [ ] **Step 3: Render the button beside the Stop-loss row**

In `EditTicket`'s JSX, the Stop-loss `ExitRow` is at ~674-682. Wrap it so a BE button sits under it. Replace:

```tsx
        <ExitRow
          label="Stop loss"
          on={stop != null}
          value={stop}
          pct={pct(stop)}
          invalid={!stopValid}
          onToggle={(on) => toggleExit("sl", on)}
          onChange={(v) => setExit("sl", v)}
        />
```

with:

```tsx
        <ExitRow
          label="Stop loss"
          on={stop != null}
          value={stop}
          pct={pct(stop)}
          invalid={!stopValid}
          onToggle={(on) => toggleExit("sl", on)}
          onChange={(v) => setExit("sl", v)}
        />
        {canBreakeven && (
          <button className="ot-be-btn" type="button" onClick={setBreakeven}>
            Set stop to breakeven
          </button>
        )}
```

- [ ] **Step 4: Style the button**

In `frontend/src/App.css`, near the exits styles (after `.ot-exit` rules ~line 3037), add:

```css
/* Compact secondary action under the Stop-loss row: moves SL to the entry price. */
.ot-be-btn {
  align-self: flex-start;
  margin-top: 2px;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-dim);
  background: var(--surface-2, var(--surface));
  border: 1px solid var(--border);
  border-radius: 4px;
  cursor: pointer;
}
.ot-be-btn:hover { color: var(--text); border-color: var(--text-faint); }
```

- [ ] **Step 5: Build to verify types + compile**

Run: `cd frontend && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/mahmoudparham/auto_trader
git add frontend/src/OrderTicket.tsx frontend/src/App.css
git commit -m "feat(trading): Set-to-breakeven button in the position edit form"
```

---

### Task 5: End-to-end manual verification

**Files:** none (verification only).

No code changes. Confirm the whole flow in the running app (dev server already running per user's environment — do NOT restart it; open a browser tab).

- [ ] **Step 1: Full-suite regression**

Run: `cd frontend && npm run test:unit`
Expected: PASS (whole suite, no regressions).

Run: `cd frontend && npm run build`
Expected: PASS (typecheck + build clean).

- [ ] **Step 2: Visual — long position**

Open a paper long position (e.g. `capital:paper`), let it move into profit, click its row to open the edit form. Confirm:
- "Set stop to breakeven" button appears under the Stop-loss row.
- Clicking it stages SL at the entry price; the chart shows ONE red line with a `· BE` pill (no second SL line/pill stacked on it); the entry-candle terminal dot is retained.
- The bracket's SL badge reads `0.00%` and no `NaN`/`Infinity` R:R appears.
- **Update** commits; after refresh the merged line persists (level-derived).
- Editing the SL to another value (or toggling it off) restores the normal two-line / two-pill display.

- [ ] **Step 3: Visual — short position + negative cases**

- Repeat Step 2 for a short (price below entry) — same merged behavior.
- Confirm the button is HIDDEN for: a position at a loss, a resting order (edit an order), and a position whose SL is already at breakeven.

- [ ] **Step 4: Close the browser tab you opened.**

- [ ] **Step 5: Commit (docs only, if any notes were added).** Otherwise skip.

---

## Self-Review

**Spec coverage:**
- Merged breakeven state (Approach A) → Tasks 2 (line), 3 (pill). ✓
- "Set to breakeven" button, position-only, in-profit-only, stage-then-Update → Task 4 + `breakevenEligible` (Task 1). ✓
- Enable rule gated on `sideValid(round(entry))` / `latest != null` → `breakevenEligible` (Task 1), tested incl. the sub-tick sliver. ✓
- Merged line red, non-draggable, `bar` dot kept, `· BE` label → Task 2, tested. ✓
- DOM pill drops SL pill + `· BE` tag → Task 3. ✓
- Bracket needs no special-casing; verify no `NaN` R:R → confirmed in code (`bracketLabels` already guards `Math.abs(entry-stop) > 0` → `rr = null`); re-verified in Task 5 Step 2. ✓
- Drop drag-to-split; un-breakeven via form → Task 2 (`draggable: false`), Task 5 restores-on-edit check. ✓
- BE = `round(entry)`, sub-tick acceptable → Task 4 handler + Task 1 note. ✓
- Out of scope (buffer/auto/trailing, orders, new-order ticket) → not implemented. ✓

**Placeholder scan:** The intentional "placeholder" order test in Task 2 Step 1 is explicitly called out and replaced with the correct version in the same step — no unresolved placeholders remain. All code steps show full code.

**Type consistency:** `isBreakeven(price, stop, precision)` and `breakevenEligible(trade, latest, precision)` signatures are identical across Tasks 1, 2, 3, 4. The pill `breakeven?: boolean` field name matches between the state type (Task 3 Step 1), the build (Step 3), and the render (Step 4). `STOP_COLOR`/`PRICE_COLOR` are the existing constants in `positionLines.ts`.
