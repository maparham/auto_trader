# Entry-price-aware, counted exit conditions — design

**Date:** 2026-07-06
**Status:** Approved, ready for implementation plan

## Problem

Exit rules today compare indicators, price fields, and constants against each
other (`EMA(9) crossesBelow EMA(21)`, `RSI < 30`). They cannot reference the
**price you entered at**, and they are memoryless — a condition either passes on
this bar or it doesn't. Two very common exit patterns are therefore
inexpressible:

- "Close a long the **3rd time** the price closes **below the entry price**."
- "Close a long the **2nd time** the price **crosses the entry price**."

Both need two new capabilities:

1. **Entry price as something a condition can reference** (`entryPrice`).
2. **A per-condition "Nth time" count** — fire on the Nth occurrence since entry,
   not the first.

The user's framing — "more like a rule, but it takes the entry price into
account" and "current price *or indicators*" — points squarely at the existing
rule DSL (which already speaks indicators), not the engine-level price-stop path
(`RiskConfig`, which speaks only price-distance/ATR). This spec extends the rule
path.

## Non-goals (explicit scope boundaries)

Each is a separate follow-up, out of scope here:

- **Value-at-entry of arbitrary operands** (e.g. "the EMA(9) reading at the
  moment we entered"). Only the entry *price* is in scope. The operand model is
  left open enough that this could generalize later, but nothing here builds it.
- Consecutive-run or edge/re-entry counting semantics (see "Count semantics"
  below — we deliberately pick cumulative and only cumulative).
- Any change to entries, price-level stops/targets (`RiskConfig`), scaling, or
  session-close behavior.
- Counting across positions or a "lifetime" count — the count is strictly per
  open position and resets on each new entry.

## Background: current architecture

- **Frontend computes all indicator series** and posts candles + series + rules;
  the **backend does zero indicator math** — it reads posted series by index.
- Strategy: `backend/auto_trader/strategy/rule.py` (`RuleStrategy`). Per-side
  `long_entry` / `long_exit` / `short_entry` / `short_exit` `RuleGroup`s. Exit
  groups are evaluated only while the side holds (`ctx.position_long > 0`).
- Rule model (`strategy/rule.py`): `Operand(kind="indicator"|"price"|"const", …)`,
  `Rule(left, op, right)`, `RuleGroup(combine="AND"|"OR", rules)`.
  Operators: `crossesAbove`, `crossesBelow`, `gt`, `lt`, `gte`, `lte`.
- `Context` (`strategy/base.py`) exposes `history`, `position_long`,
  `position_short` — **but not entry price or entry time**. This is the key seam
  the feature must extend.
- The **same `RuleStrategy.on_bar` runs in backtest, paper, and live.** Live goes
  through `POST /api/strategy/evaluate`
  (`backend/auto_trader/api/routers/strategy.py`), which builds a `RuleStrategy`,
  seeds `ctx.position_long/short` from the reconciled broker position, and calls
  `on_bar`. So an exit-rule change must be honored in **both** engines or live
  silently diverges from backtest.
- Config mirror: `frontend/src/lib/backtestConfig.ts` (`Operand`, `Operator`,
  `Rule`, `RuleGroup`, `seriesName`). Modal:
  `frontend/src/BacktestSettingsModal.tsx` (`OPERATORS`, operand editor,
  `RuleGroupSection`). DTOs: `backend/auto_trader/api/schemas.py`
  (`OperandDTO`, `RuleDTO`, `RuleGroupDTO`, `EvaluateRequest`).

## Design

### 1. `entryPrice` operand

Add a new operand kind, `entry`, to the rule DSL. It resolves to the open
position's entry (fill) price for the side the rule belongs to. It is a constant
for the life of the position — both its "now" and "prev" value equal the entry
price, so it composes with cross operators (a cross of a moving series against
the flat entry line works naturally).

- **Backend** (`strategy/rule.py`):
  - `Operand.kind` gains `"entry"`.
  - `series_name(op)` returns `None` for `entry` (no posted series).
  - `_operand_values` returns `(entry_price, entry_price)` for `kind="entry"`,
    reading the side's entry price off `Context`. If no position is held (should
    not happen inside an exit group) or the price is unknown, it returns
    `(None, None)`, which — per existing D2 semantics — makes the comparison
    `False`.
  - `_operand_name` returns `"entryPrice"` for reasons/labels.
- **Context** (`strategy/base.py`): add `long_entry_price: float | None` and
  `short_entry_price: float | None`, defaulting to `None`.
  - The rule needs to know which side's entry price to read. `RuleStrategy`
    already evaluates each group in a known side context (`long_exit` → long),
    so it passes the correct side's entry price down into rule evaluation.
- **Backtest engine** (`engine/backtest.py`): after updating
  `ctx.position_long/short`, set `ctx.long_entry_price` from the (single) open
  long `Position.entry` (or `None` if flat), likewise for short. Single-position
  netting per side makes this unambiguous today.
- **Live** (`api/routers/strategy.py`): set `ctx.long_entry_price` /
  `ctx.short_entry_price` from the reconciled position's `open_level` (already
  present on the position payload).
- **Frontend**: add `entry` to the operand `kind` union and the operand-kind
  dropdown in the rule editor; label it "Entry price". No length/field inputs —
  it's parameterless like a price field. Mirror in `OperandDTO`.

### 2. Per-condition "Nth time" count

Each `Rule` gains an optional `count: int | None` (default `None` = today's
behavior: fire on the 1st occurrence). When set to N ≥ 1, the rule is satisfied
on the **Nth bar since entry** on which its base comparison is true.

#### Count semantics — cumulative (chosen)

Count **every** bar since entry whose base comparison is true, whether or not
they are consecutive. The Nth such bar satisfies the rule. This is the user's
explicit reading: "the 3rd candle that closed below the entry, not necessarily
consecutive." Consecutive-run and edge/re-entry models are explicitly rejected.

This unifies both examples:

- "3rd close below entry" → `close lt entryPrice`, `count = 3`.
- "2nd cross of entry" → `close crosses entryPrice`, `count = 2`. A cross is only
  true on the bar it happens, so counting true-bars = counting crossings.

#### Computation — pure scan, no mutable counter

The count is computed as a **pure function of history since entry**, not an
incrementing per-position counter:

At each bar, `RuleStrategy` finds the entry bar index (from the position's entry
time/index — see below), re-evaluates the rule's base comparison for every bar
from the entry bar through the current bar, counts the `true` results, and treats
the rule as satisfied iff `count_of_true >= count` **and** the current bar's base
comparison is true. (Requiring the current bar to be true means the rule fires
*on* the Nth occurrence bar — the bar that pushes the tally to N — rather than
staying latched true forever after.)

Rationale: this matches the codebase's stateless-strategy philosophy (like
`trade_from_time` gating) — no mutable counter to store, reset, or get wrong
across entry/exit. It auto-resets per position because the scan window starts at
each new entry. Cost is O(bars-since-entry) per counted rule per bar, which is
negligible for backtest and live sizes.

Re-evaluating a past bar needs: the indicator series values at that index
(available — series arrays are full-length), the entry price (a constant), and
the previous bar for cross operators (available in history). All are in scope
during the scan.

#### Knowing the entry bar (the parity requirement)

The scan needs the position's entry **time** (to locate the start index in
history):

- **Backtest**: `Position.open_time` exists — engine passes it onto `Context`
  as `long_entry_time` / `short_entry_time` (epoch or datetime, matched to
  history's candle times).
- **Live**: the `/evaluate` request's position payload currently sends
  `open_level` but **not** entry time. **Add an entry-time field to the live
  position DTO** (`PositionStateDTO` in `schemas.py`) and have the frontend
  populate it. Without this, a counted exit would silently never count in live —
  a trading footgun. The user has approved full live/backtest parity.

`Context` gains `long_entry_time` / `short_entry_time: <ts> | None` alongside the
entry-price fields. If entry time is unknown but a `count` is set, the rule
evaluates to `False` (safe: it won't fire spuriously) — but with the live wiring
above, this should not occur in normal operation.

### 3. A `crosses` (either-direction) operator

Add `crosses` to the operator set: true on a bar where the two operands cross in
**either** direction (i.e. `crossesAbove OR crossesBelow`). This makes "crosses
the entry price" expressible in one condition row, matching example 2, and is
broadly useful beyond this feature.

- **Backend** (`strategy/rule.py`): add `"crosses"` to `CROSS_OPS`;
  `_eval_rule` returns true when `sign(lprev - rprev) != sign(lnow - rnow)` and
  they actually cross (handle the touch-then-separate and equality edge cases the
  same way `crossesAbove`/`crossesBelow` already do — a directionless OR of the
  two existing conditions is the simplest correct definition).
- **Frontend**: add `crosses` to `Operator`, `OPERATORS` (with glyph + tooltip),
  and the `OP_REVERSE` mirror map (`crosses` is its own reverse).

### 4. Frontend UI

In the rule editor (`BacktestSettingsModal.tsx`):

- Operand-kind dropdown gains "Entry price".
- Operator dropdown gains "crosses" (either direction).
- Each rule row gains an optional **"Nth time" count** input — a small numeric
  field (blank/absent = 1st). Shown inline on the row; only meaningful when the
  rule is in an exit group, but harmless (unused) if set on an entry rule — the
  engine ignores `count` outside exit evaluation. Keep the control unobtrusive so
  simple rules stay simple.
- Use the shared `Tooltip`/`InfoTip` components per CLAUDE.md for any help text.

### 5. Serialization

- `Rule` / `RuleDTO` gain `count: int | None`.
- `Operand` / `OperandDTO` gain `"entry"` as a valid `kind`.
- `Operator` union + backend op validation gain `"crosses"`.
- `count` is per-rule and side-agnostic in the payload; the engine applies it
  only during exit-group evaluation (entries fire on first occurrence as today).

## Data flow

1. User authors an exit condition in the modal: operand `entryPrice`, operator
   `lt`/`crosses`, other operand `close`, and an "Nth time" count.
2. Config is serialized (`backtestConfig.ts`) and posted — to `/api/backtest`
   (backtest) or `/api/strategy/evaluate` (live) — with the same rule shape.
3. Backend builds `RuleStrategy`; the engine (backtest loop or the single-bar
   evaluate endpoint) seeds `Context` with position size, entry price, and entry
   time per side.
4. `RuleStrategy.on_bar` evaluates the exit group; a counted rule scans history
   since entry, counts true bars, and passes on the Nth. A passing exit group
   emits a close `Signal`, filled next-open in backtest / turned into a close
   action in live.

## Error handling & edge cases

- **Flat side / unknown entry price**: `entryPrice` operand → `None` → comparison
  `False`. Cannot fire an exit when nothing is held.
- **`count` unset or `< 1`**: treated as 1 (fire on first occurrence) — preserves
  today's behavior for every existing rule.
- **Entry bar not found in history** (e.g. warmup boundary): scan window is
  empty → count 0 → rule `False`. Safe.
- **Cross operators + count**: each cross bar counts once; the current-bar-true
  requirement means the rule fires exactly on the Nth cross, not on every bar
  thereafter.
- **AND/OR composition**: a counted rule contributes its boolean to the group
  exactly like any other rule; `combine` logic is unchanged.

## Testing

Backend (`pytest`), mirroring `test_backtest_stops.py` / `test_rule_strategy.py`
conventions with hand-built candle fixtures:

- `entryPrice` operand resolves to the fill price; `close lt entryPrice` fires
  the first bar close dips below entry (count unset).
- Cumulative count: `close lt entryPrice` with `count=3` fires on the 3rd
  (non-consecutive) close-below, not the 1st or 2nd; a recovery bar between dips
  does **not** reset the tally.
- `crosses` operator fires on both up- and down-crosses; with `count=2` fires on
  the 2nd cross.
- Count resets across positions: after an exit and a re-entry, the tally starts
  from zero.
- Short-side mirror of the above.
- Live parity: an `/evaluate` request carrying entry time + `open_level` produces
  the same close decision as the backtest engine on identical candles.
- Regression: existing rules with no `count` and no `entry` operand behave
  exactly as before.

Frontend (`vitest`): serialization round-trips `count` and the `entry` kind and
`crosses` op; the rule editor renders/edits the count field.

## Open risks

- **Netting assumption**: entry price/time on `Context` assumes one position per
  side (the current netted model). If pyramiding lands later, "entry price" needs
  a defined meaning (average? per-lot?) — noted, not solved here.
- **Performance**: O(bars-since-entry) per counted rule per bar. Fine at current
  scales; if a future very-long backtest with many counted rules is slow, a
  memoized per-position tally is a drop-in optimization behind the same seam.
