# Backtest bar rule inspector — design

**Date:** 2026-07-12
**Status:** Approved design, pending implementation plan

## Problem

When a backtest doesn't open a trade at a bar where the entry rule looks true,
there is no way to see *why* from the chart. The engine evaluates every rule term
at every bar and knows exactly why it did or didn't act (session mask inactive,
already in a position, spacing/cap rejection, warm-up, next-bar fill), but it
discards all of that after the run. Only *opened* fills keep their term values
(surfaced today via the trade-marker hover popover). The silent cases — rule true
but no trade — are invisible.

Two real sessions hit this: a bar was skipped because it fell outside the Tokyo
session window, then (after removing the mask) because a long was already open
from 50 minutes earlier. Both answers existed inside the engine; nothing on the
chart showed them.

## Solution overview

Add an **inspect mode** to the backtest chart. The user toggles "Inspect" in the
Backtest panel and clicks any bar inside the run; a panel shows, for that bar:

- **All four rule groups** (long entry, short entry, long exit, short exit), each
  as a list of terms with live values (`EMA(9) 30 486.2  >  EMA(200)@15m 30 501.9  ✗`),
  including *failing* terms, and the group's AND/OR verdict.
- The **engine outcome** for the bar: a chip (`opened` / `suppressed` / `no signal`)
  and a one-line reason (`already in position since 07:35`, `outside session window`,
  `warming up`, `spacing not met`).

The values come from a **per-bar trace the backend engine emits with the run**. No
rule logic moves into the browser; the frontend only renders what the engine
recorded. This keeps business logic on the backend, consistent with project
convention.

### Decisions (locked)

| Decision | Choice |
|---|---|
| Trigger | Toggle "Inspect" in the Backtest panel, then click a bar. Mode stays on for bar-to-bar clicking. |
| Scope | All four rule groups shown, ordered relevant-first (entry groups when flat, exit groups when in a position on that side). |
| Data source | Per-bar trace computed by the backend engine during the run and returned with the result. |
| Bar coverage | Bars inside the backtest period only. Bars with no trace entry show a muted "not in backtest range" state — no browser-side recompute. |
| Persistence | **Session-only.** The trace lives in memory for the current run. Inspect works immediately after any run; after a page reload the user re-runs to inspect again. The trace is **not** written to the `localStorage` results blob (it is multi-MB for a month of 5m bars). |

## Data model

### Backend (`auto_trader`)

Generalize term capture and add gate capture. Today `RuleStrategy._terms()`
(`strategy/rule.py:363-387`) filters to passing rules on the firing bar. Add a
sibling that captures **every** term with a pass flag, callable per bar per group.

New dataclasses (in `strategy/models.py` alongside `RuleTerm`):

```python
@dataclass(frozen=True)
class InspectorTerm:
    left: str
    lval: float | None
    op: str
    right: str
    rval: float | None
    left_tf: str | None
    right_tf: str | None
    passed: bool          # NEW vs RuleTerm

@dataclass(frozen=True)
class BarGroupTrace:
    group: str            # "longEntry" | "shortEntry" | "longExit" | "shortExit"
    combine: str          # "AND" | "OR"
    terms: tuple[InspectorTerm, ...]
    passed: bool          # group rollup

@dataclass(frozen=True)
class BarTrace:
    bar_index: int
    time: int             # unix seconds
    groups: tuple[BarGroupTrace, ...]
    # engine gate outcome for this bar
    action: str           # "opened" | "suppressed" | "none"
    reason: str | None    # human one-liner when suppressed
    in_position_long: bool
    in_position_short: bool
    window_active: bool
    warmed_up: bool       # any traced group had all-non-None operands
    spacing_ok: bool | None
```

The engine (`engine/backtest.py`) already computes each of these signals inside
the per-bar loop:
- `window_active` = `is_active(self.mask, bar.time)` (line ~117).
- `in_position_*` = `ctx.position_long/short > 0` after fills.
- `spacing_ok` / cap rejection = the `continue` at lines ~154-156.
- `action`/`reason` = derived from which branch the bar took (opened a fill,
  hit `continue` on mask/cap/spacing, or produced no signal).

The trace is built by evaluating each group through the **existing** evaluation
path (`_operand_values`, `_base_true_at`, `_eval_group`) so inspector values are
by construction identical to what the run used — no parallel logic.

### API (`api/routers/backtest.py`, `schemas.py`)

- Request: add optional `inspect: bool = False` to `BacktestRequest`. When false,
  no trace is computed (zero cost for normal runs).
- Response: add optional `bar_traces: list[BarTraceDTO] | None` to
  `BacktestResponse`. Present only when `inspect=True`.

Because persistence is session-only, the frontend requests `inspect=True` on
every run it initiates while the feature is on, holds `bar_traces` in memory, and
never persists it.

### Frontend (`frontend/src`)

- Extend `Term` (`lib/api.ts`) — or add `InspectorTerm` — with `pass: boolean`.
- New in-memory store (a `Signal`) keyed by bar time → `BarTrace`, populated from
  the run response, cleared on new run / cleared results. Not in `persist/artifacts.ts`.

## Components

### Backend
1. `strategy/rule.py` — new `_all_terms(group, ctx, i, side)` returning
   `tuple[InspectorTerm, ...]` (every rule, with pass), reusing `_operand_values`
   and the same comparison used by `_base_true_at`. Keep `_terms()` as-is for the
   fill path.
2. `strategy/models.py` — `InspectorTerm`, `BarGroupTrace`, `BarTrace`.
3. `engine/backtest.py` — when `inspect` is on, after evaluating/branching each
   bar, assemble a `BarTrace` (groups from the strategy, gate fields from local
   state) and collect into `result.bar_traces`.
4. `api/routers/backtest.py` + `schemas.py` — request `inspect` flag, response
   `bar_traces`, DTO mapping.

### Frontend
1. `BacktestPanel.tsx` — an "Inspect" toggle next to the existing "Periods"
   control; owns inspect-mode state and the selected bar time.
2. Inspect-mode chart wiring — reuse `ChartCore.tsx` `convertFromPixel` to turn a
   click into a bar timestamp; while active, a thin highlight tracks the hovered
   bar and the cursor signals inspect mode. Click sets the selected bar time.
3. `BacktestInspectorPanel.tsx` (new) — renders the selected bar's `BarTrace`:
   four group cards (relevant-first) of term rows (reusing `termLabel`/`opSymbol`
   and the popover row styling from `signalGlyphs.ts` / `BacktestSignalPopover.tsx`),
   each with its AND/OR verdict, and a footer with the outcome chip + reason +
   the four gate checks. Out-of-range/no-trace bar → muted empty state.
4. In-memory trace store consumed by the panel.

## Data flow

```
Run (inspect=true) ──► backend engine per-bar loop
                         ├─ eval all 4 groups via existing operand path → BarGroupTrace[]
                         ├─ capture gate state (window/position/spacing/warmup) → action+reason
                         └─ BarTrace per in-window bar
                       ◄── BacktestResponse.bar_traces
frontend: hold bar_traces in memory (Signal), keyed by bar time
Inspect toggle ON → chart click ─(convertFromPixel)→ bar time
                                     └─► lookup BarTrace → BacktestInspectorPanel
```

## Error handling & edge cases

- **Bar outside the run** (no trace): muted "not in backtest range" state, no error.
- **No run yet / results cleared:** Inspect toggle disabled with a hint.
- **Reload:** results rehydrate but the trace does not (session-only); Inspect
  toggle prompts a re-run. No stale/partial trace is ever shown.
- **Coded (Python) strategies:** rule-group traces are rule-strategy-specific.
  For coded strategies the group cards are omitted; the outcome chip + gate
  reasons still render (they come from the engine, not the rule tree). Non-goal to
  introspect arbitrary Python strategy internals.
- **Operand `None` (cold series):** term renders the value as `—` and counts as a
  fail; `warmed_up=false` when any traced group had a None operand.

## Testing

**Backend (pytest):**
- Parity: for a fixture run, every bar the engine *opened* a fill has a `BarTrace`
  whose corresponding group `passed=true` and whose passing terms match the
  existing `Fill.terms` exactly (guards against inspector/fill divergence).
- Gate reasons: construct runs that trip each gate (mask-inactive bar, already-in-
  position bar, spacing rejection, warm-up bar) and assert the bar's
  `action`/`reason`/gate booleans.
- `inspect=false` returns `bar_traces=None` and adds no cost path.

**Frontend (vitest):**
- `BacktestInspectorPanel` renders a `BarTrace`: four groups, failing terms shown,
  relevant-first ordering by position state, correct outcome chip + reason.
- Click-to-bar: a click x maps to the expected bar time (mock `convertFromPixel`).
- Out-of-range bar → muted state; toggle disabled when no trace present.

## Non-goals

- Ghost/suppressed markers on the chart (ideas 1/3/4 from brainstorming). This is
  the on-demand inspector only.
- Inspecting bars outside the backtest period, or live recompute in the browser.
- Reload-surviving trace persistence.
- Introspecting coded Python strategy internals beyond engine gate outcomes.
```
