# count(), bullish/bearish predicates, and barsSinceEntry — design

Date: 2026-08-04
Status: approved

## Motivation

Rules like "exit when a 3rd red candle closes below the entry price" cannot be
expressed today: the language has no way to count bars matching a condition,
no candle-color predicate, and no notion of trade age. This adds all three:

```
count(bearish(candle), barsSinceEntry) >= 3
candle.close < entry
```

(two exit rows, ANDed by the group).

## Grammar & AST

A new syntactic category, **condition**:

```
condition := comparison            e.g. candle.close < entry
           | cross                 e.g. crossBelow(candle.close, EMA(9))
           | predicate             e.g. bearish(candle[-1])

row       := condition | chain     (a row can now be a bare predicate)
count     := count(condition, window)    -- count is an arithmetic TERM
window    := arith                 (a literal, or barsSinceEntry in exits)
```

- **`bullish(x)` / `bearish(x)`** — `x` must be candle-rooted (`candle`,
  `candle[-1]`, `candle@1H`, and combinations; no explicit field). Semantics:
  `bullish` = close > open, `bearish` = close < open; a doji (close == open)
  is neither. New AST node `Predicate(fn, candle_expr)` (backend
  `nodes.py`, mirrored in `frontend/src/lib/expr/parser.ts`).
- **`count(cond, n)`** — new AST node `Count(cond, window)`. `count` is
  numeric, so `count(...) >= 3`, arithmetic around it, and chains all work.
  The parser special-cases `count`'s first argument to parse an embedded
  condition; conditions remain illegal anywhere else (the validator keeps
  rejecting nested comparisons/crosses with the existing
  `cross_not_toplevel`-style errors, plus a new error for a predicate used
  as a value).
- **`barsSinceEntry`** — new leaf node, **exit-only** (same validation rule
  as `entry`: `entry_in_entry_rule`-style error otherwise). Usable anywhere
  a number is: `count(bearish(candle), barsSinceEntry)`, or standalone
  `barsSinceEntry > 12` (time-based exits).

## Semantics

- `count` window = the last *n* bars **including the current bar** (matches
  `highest`/`lowest`/`avg`).
- A bar where the condition's operands are undefined (indicator warm-up)
  counts as **0** — no window-poisoning. The count itself is `None` until the
  window fully fits in history (`i + 1 >= n`).
- A cross condition inside `count` matches on the bar the cross *fired*
  (needs bar i-1; the first bar of history never matches).
- `barsSinceEntry` = completed bars since the entry bar (0 on the bar the
  trade opened). Consequently `count(cond, 0)` = 0 and a count-based exit
  cannot fire on the entry bar itself.
- Non-positive or fractional windows: `count(cond, n)` with `n < 1` after
  truncation evaluates to 0 matches over an empty window (defined, not None).
- Warm-up (`warmup.py` / `parser.ts warmupOf`):
  - literal window: `n + warmup(cond)`;
  - `barsSinceEntry` window: `warmup(cond)` only — the windowed bars exist
    inside the run by definition;
  - predicate: warm-up of its candle expression (offsets count as usual).

## Evaluation

- **Entry-free rows** (literal window, no `barsSinceEntry`): precomputed as
  series in `series_of` — evaluate each side of the condition to arrays,
  derive a 0/1 match array, rolling-sum it. Predicates likewise from the
  candle open/close arrays.
- **Entry-bearing rows** (`barsSinceEntry` anywhere): the existing per-bar
  recursive path (`CompiledRow._val`). `CompiledRow.evaluate` gains the entry
  bar index alongside `entry_price`; `ExprRuleStrategy` derives it from
  `ctx.long_entry_time` / `ctx.short_entry_time` against the bar history —
  identical for backtest and live.
- `_entry_free` treats `barsSinceEntry` like `Entry` (not precomputable).

## Frontend mirror

- `grammar.lezer`, `parser.ts`: same nodes, same spans discipline.
- `catalog.ts`: a new **Conditions** palette group with `count(cond, n)`
  (insert: `count(bearish(candle), 10)`), `bullish(candle)`,
  `bearish(candle)`, and `barsSinceEntry`.
- `complete.ts`, `lint.ts`, `highlight.ts`: recognize the new names; lint
  mirrors backend validation (exit-only `barsSinceEntry`, condition
  placement, candle-rooted predicate argument).
- `sweepLiterals.ts` / `literalDeco.ts`: count's literal window labeled
  "count window" (sweepable); thresholds inside its condition labeled as
  today.
- Backtest warm-up sizing in the modal picks up the new `warmupOf` terms
  automatically.

## Testing

Backend: parser (all three condition forms inside count, bare-predicate
rows, error spans for misplaced conditions), validator (predicate as a value
rejected, `barsSinceEntry` in entry rules rejected, non-candle-rooted
predicate argument rejected), evaluate (rolling count, undefined-as-zero,
cross-in-count, dynamic window vs entry bar, doji neutrality), warmup (both
window kinds). Frontend: parser/lint/complete mirrors + corpus entries.

## Out of scope

Boolean operators (`and`/`or`/`not`) inside rows; predicates beyond
bullish/bearish; non-candle predicate arguments; anchoring `count` to
arbitrary events other than entry.
