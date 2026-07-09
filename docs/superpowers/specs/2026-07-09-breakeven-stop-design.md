# Set-to-breakeven stop + merged breakeven line

## Problem

Traders want a one-click way to move a position's stop-loss (SL) to its entry
price ("breakeven") once the trade is in profit. At breakeven the SL price
equals the entry price, so the red SL line and the neutral entry line land on
the exact same pixel row — and their always-on DOM pills (both anchored at
`TRADE_PILL_LEFT`) stack directly on top of each other. Two lines and two pills
for one price is redundant and unreadable.

## Approach (chosen)

**Merged breakeven state (Approach A).** When a position's SL sits at its entry
(within one tick), the two lines/pills collapse into a single red line with one
pill tagged `· BE`. Everything is derived from levels on each render — there is
no stored "breakeven mode" flag; the merge appears when the levels coincide and
dissolves when they diverge.

A **"Set to breakeven"** button in the position edit form stages `SL = entry`,
which the chart previews live; the existing **Update** button commits it.

### Rejected alternatives
- **B — de-collide the pills only:** keeps two lines fighting on one row and two
  labels for one price. Treats the symptom.
- **C — SL absorbs/recolors the entry line without a merged state:** repurposes
  the entry line's meaning; can read as "the entry moved."

### Deliberately out of scope (YAGNI)
- Breakeven-plus-buffer, auto-breakeven, trailing stops. Exact entry, manual only.
- Any breakeven affordance on resting orders (no fill yet) or the new-order ticket.
- Drag-to-split the merged line. Un-breakeven is done through the edit form.
- No new commit/apply path — reuses the form's staging + Update.

## Definitions

- **Breakeven price** = `round(entry)` where `entry = trade.priceLevel` (the
  position's fixed open level), rounded to the instrument's `precision`. Because
  the true fill can sit sub-tick, the staged stop can be a fraction of a tick off
  the exact fill. This is the best achievable and is acceptable.
- **`isBreakeven(price, stop, precision)`** — shared helper: `stop != null &&
  price != null && Math.abs(stop - price) < tick`, where `tick = 10 ** -precision`.
  Used identically by every render layer so the three layers never disagree.

## Component changes

### 1. Button — `OrderTicket.tsx` `EditTicket` / `ExitRow`

- Add a compact **"Set to breakeven"** action within the Stop-loss `ExitRow`
  (or immediately beside it) in the edit form only.
- On click: `patch({ stop: round(trade.priceLevel) })`. This stages into
  `pendingEditsSignal[trade.id]` exactly like typing/dragging the SL — the
  on-chart lines preview the merged state immediately, and **Update** commits it
  via the existing `applyEditedLevels` path.
- **Visibility rule** (hidden, not merely disabled, when it fails):
  - `trade.kind === "position"` (never resting orders).
  - `latest != null` — need a price to confirm profit (`latest = getLivePrice ??
    mark`, already computed at `OrderTicket.tsx:602`).
  - `sideValid("stop", round(trade.priceLevel))` — the form's existing check.
    Gating on the *rounded* stop (not raw `latest > entry`) closes the sub-tick
    sliver where `round(entry)` could land the wrong side of a barely-profitable
    `latest` and get the Update blocked. With this gate, whenever the button
    shows, staging BE is guaranteed valid.
  - Hide when SL is already at breakeven (`isBreakeven(entry, stop, precision)`),
    since clicking would be a no-op.

### 2. Merged line spec — `positionLines.ts` `tradeLineSpecs`

When `isBreakeven(price, stop, precision)` for a **position** (`t.kind ===
"position"`):
- **Skip** pushing the separate `${id}:stop` spec.
- The `${id}:price` spec becomes the merged line:
  - `color: STOP_COLOR` (red) — the stop is now the live constraint.
  - Keeps `restKind: "bar"` + `entryTs` so the entry-candle terminal dot still
    shows where the position was opened.
  - `draggable: false` (a position's entry is never draggable; the merged line is
    display-only — no drag-to-split).
  - `label`: append the BE tag → `${word} ${qty} @ ${fmt(price)}${pnlStr} · BE`
    (subject to the existing `hideTradeLabels` / focused-field suppression). The
    canvas label carries the tag too, not just the DOM pill, for the
    non-selected render path.

Non-position trades and non-breakeven positions are unchanged. Orders never merge.

### 3. DOM pill — `ChartCore.tsx` (pill build ~4255)

When `isBreakeven(merged.price, merged.stop, precision)` for a position:
- **Skip** pushing the `field: "stop"` pill.
- Append `· BE` to the entry (`field: "price"`) pill's label. Its P/L hint reads
  `0.00` (flat by construction).

### 4. H-bracket — `drawPositionBracket` (`positionLines.ts` / `ChartCore.tsx`)

No special-casing needed: the SL leg already collapses to zero length and the
SL% badge reads `0.0%`, which is itself the breakeven cue. **Verify** the R:R
badge does not render `NaN`/`Infinity` when the SL distance is 0 — hide it or
show `—` in that case.

## Data flow

```
User in profit → edit form → "Set to breakeven"
  → patch({ stop: round(entry) }) → pendingEditsSignal[id]
      → ChartCore re-renders lines/pills from merged levels
          → isBreakeven true → merged red line + "· BE" pill (live preview)
  → Update → applyEditedLevels → broker SL = entry
```

Un-breakeven: edit the SL to another price or toggle it off in the same form;
levels diverge → next render restores the normal two-line / two-pill display
automatically (no stored mode to reset).

## Edge cases

- **No live price and no `upnl`** (`latest == null`): button hidden — cannot
  confirm profit.
- **Short positions**: identical merge; `sideValid` handles the reversed side.
- **Sub-tick entry**: BE is `round(entry)`; may sit a fraction of a tick off the
  true fill (documented above, acceptable).
- **TP present**: unaffected — TP keeps its own green line/pill; only entry+stop merge.
- **SL already at entry from a manual drag/edit** (pre-existing): the merge now
  renders correctly for that case too, since it is level-derived, not
  button-derived.

## Testing

- `isBreakeven` unit tests: exactly-equal, within-tick, one-tick-apart (not
  merged), null stop / null price, varying precision.
- `tradeLineSpecs`: position at breakeven emits one red `:price` spec with the
  `· BE` label and no `:stop` spec; diverged levels emit the normal two specs;
  orders never merge.
- Button visibility: shown only for in-profit positions where `round(entry)`
  passes `sideValid`; hidden for orders, at-a-loss, `latest == null`, and when
  already at breakeven.
- Bracket: SL distance 0 does not render `NaN` R:R.
- Manual/visual: click the button on an in-profit long and short; confirm one red
  line + `· BE` pill, entry dot retained, Update commits, and editing SL away
  restores two lines.
