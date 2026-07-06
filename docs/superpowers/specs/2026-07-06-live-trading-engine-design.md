# Live Trading Engine + Side Panel — Design

Date: 2026-07-06

## Goal

Add an automated trading engine and a side panel that — like the backtest —
takes a rule-based strategy as input, but instead of simulating over history it
trades a **real or demo broker account** in real time.

## Core principle: orchestration, not new trading logic

The live engine is an orchestration layer over parts that already exist. It
reuses, unchanged:

- **The rule schema** — `frontend/src/lib/backtestConfig.ts` and its Python
  mirror (`OperandDTO`/`RuleDTO`/`RuleGroupDTO`, `strategy/rule.py`).
- **The rule evaluator** — the Python `RuleStrategy` (`strategy/rule.py`), which
  the backtest already runs. It is **not** re-implemented in TypeScript.
- **The order path** — `POST /orders` already accepts `source:"strategy"`,
  `confirm` (required for real money), and broker brackets (`stop_level`,
  `take_profit_level`). All three brokers (paper, IG, Capital) already dedupe on
  `client_order_id` (paper: `_results` LRU; IG/Capital: shared
  `_dealing._idempotent_hit` ledger). **No new order plumbing is required.**
- **The rule editor UI** — the same component the backtest panel renders.

## Execution model (settled decisions)

1. **Browser-driven now, backend-daemon later.** v1 runs the loop in the
   frontend while the tab is open. The design keeps a clean seam so the loop can
   later move to an autonomous backend daemon (see "The evaluation seam").
2. **Broker-attached brackets.** On entry, the stop-loss and take-profit are
   sent to the broker as part of the order, so they sit server-side and fire
   even if the tab closes or the engine dies. Rule-based exits still run
   in-engine while the tab is open.
3. **Arm snapshots a copy.** "Go live" copies the current backtest config into
   the live engine. Later edits to the backtest config never touch a running
   (armed) strategy; the user re-arms to adopt changes.
4. **Single-owner lock:** `BroadcastChannel` lease (same-browser scope) for v1.
   A backend "armed lease" is the future-daemon upgrade, noted but not built.
5. **Keying:** the engine is keyed per **epic + account** (mirroring how the
   backtest persists per cell + epic). Different instruments can be armed
   concurrently; two armed copies of the same epic + account are not allowed.
6. **Live-v1 position model — netted, single position per side.** The engine
   holds at most one open position per epic + account, reflecting the broker's
   netted book. This explicitly excludes two backtest features:
   - **No scale-in** (`maxConcurrent > 1` / `ScalingConfig`): a netted broker
     position can't reconstruct per-entry spacing, so the decision layer treats
     an entry-while-held as a no-op, not an add.
     `longScaling` / `shortScaling` from the config are ignored live.
   - **No hedging** (simultaneous long + short): a netted position is one side at
     a time. If both sides' entry rules fire while flat, the engine opens the
     first and the other is a no-op until flat again.
   These keep the decision layer trivial and are stated so nobody expects
   backtest parity for scale-in / hedging strategies.

## The evaluation seam (the load-bearing choice)

The frontend drives the loop and computes indicator series (exactly as the
backtest already does), but **does not evaluate rules itself.** Each closed bar
it calls a new stateless backend endpoint that runs the existing `RuleStrategy`
and then applies a thin **live decision layer**:

```
POST /api/strategy/evaluate
  request:  { config, series, candles, position }
    config    — the armed snapshot's 4 rule groups + longRisk/shortRisk + longEnabled/shortEnabled
    series    — indicator arrays keyed by seriesName (same payload shape as backtest)
    candles   — the loaded window ending at the latest CLOSED bar (warmup + the bar to act on)
    position  — the reconciled broker position for this epic, or null:
                { side: "buy"|"sell", quantity, open_level }
  response: { actions: [ Action ], ... }
    Action  — { kind: "open"|"close", leg: "long"|"short", side: "buy"|"sell",
               reason, stop_level?: number, take_profit_level?: number }
```

**Why a decision layer, not raw signals — this is a correctness requirement.**
`RuleStrategy.on_bar` emits an entry signal on *every* bar its entry rule is true
(a level rule like `EMA9 gt EMA21` fires for as long as it holds); the
open/rejected decision lives in `BacktestEngine`'s `ScalingConfig`, which the
browser-driven path does not run. Wrapping `on_bar` naively would stack a new
order every bar while already in a position. The endpoint therefore:

1. Sets `ctx.position_long` / `ctx.position_short` from the reconciled broker
   `position` (netted: a net-long position → `position_long = qty`,
   `position_short = 0`, and only ever one side). This is also what makes
   `on_bar`'s exit guard `if ctx.position_long > 0` fire correctly.
2. Runs `RuleStrategy.on_bar` for the **latest closed bar only** to get signals.
3. Maps signals → actions: an entry signal while **flat on that side** → `open`;
   an entry signal while **already holding** that side → skipped; an exit signal
   → `close`.
4. For an `open`, computes the bracket via the existing `engine.risk.stop_level`
   / `target_level` from the entry-reference price (the latest closed bar's
   close) and the side's risk spec, returning `stop_level` / `take_profit_level`.

The frontend places the resulting actions via `/orders` (opens carry the
bracket; closes use `closePosition`). The real reuse points are `RuleStrategy`
(signals) and `engine.risk` (levels) — **not** `BacktestEngine`'s loop, whose
semantics deliberately differ from live (see Known limitations).

Why this and not TS-side evaluation: evaluating rules in TypeScript would mean
writing net-new cross / AND-OR / operator logic and keeping it in lockstep with
Python `RuleStrategy` forever — then rewriting it again for the backend daemon.
Reusing `RuleStrategy` is *less* new code, preserves the "same interface as live"
property the backtest was built around, and means that when the daemon arrives,
**evaluation and order routing are already server-side** — the daemon only has to
take over "drive the loop + compute indicators + provide bars." That is the real
seam.

## Data flow (per closed bar, while tab open and strategy armed)

1. The live-candle WebSocket (`frontend/src/lib/feed.ts`) fires; the engine
   detects a **bar close** (the bar timestamp advanced), not the in-progress bar.
2. Compute indicator series over history + live bars, reusing the backtest's
   indicator math.
3. **Reconcile:** fetch the broker's open positions for this epic + account to
   learn the true open state (live never starts flat).
4. `POST /strategy/evaluate` → signals for the newest closed bar.
5. For each signal, `POST /orders` with:
   - a **derived** `client_order_id = hash(strategyId, barTs, leg, side)` (so a
     replay collapses to one order — brokers already dedupe on it),
   - broker `stop_level` / `take_profit_level` computed from the snapshot's
     stop/target **spec + the actual fill price** (absolute levels, per entry),
   - `confirm:true` for real-money accounts.
6. Update the panel's status and event log.

## The panel (`LiveTradingPanel.tsx`) — settled UI

**Housing — a dedicated Live panel (chosen over a mode-toggle or a stacked
section).** The Backtest panel stays as-is and gains a single **"Go live →"**
button. Pressing it snapshots a *copy* of the current config into a separate
Live panel — a clearly distinct surface so "testing" is never confused with
"trading real money." The Live panel reuses the same rule editor component.

**Header:** epic + a prominent env badge (`DEMO` blue / `LIVE` red).

**Rules — editable, staged while armed (policy 1).** The Live panel holds its
own editable copy of the rules, independent of the backtest.
- Disarmed → freely editable, exactly like the backtest.
- Armed → the engine trades a **frozen snapshot**. Edits are still allowed but
  show as **pending** with a "Re-arm to apply" banner; the running strategy keeps
  using the frozen copy until the user re-arms. Nothing typed silently changes
  what is trading.

**Live-only controls:** account picker (from `GET /api/brokers` — demo/live),
position size, and the **Arm / Disarm** switch. Real-money accounts require an
extra typed confirm to arm; demo arms in one click.

**Status area:** armed state, current position (side/qty/entry/uP&L with its
broker bracket levels shown as live-at-broker), next-bar countdown, and last-eval
time (incl. "no signal").

**Open positions & history — hybrid (option C):**
- **Open positions reuse the existing systems** — they appear in the shared
  positions dock and as the existing draggable entry/SL/TP chart lines,
  tagged `strat` to distinguish engine-owned from manual trades. No separate
  position system; the panel mirrors/links to them.
- **History is where the Live panel adds value — a per-strategy journal:** a
  closed-trades list (sourced from broker fills) plus the *same metrics the
  backtest reports* (net P&L, n trades, win rate, max drawdown), so live
  performance is directly comparable to the backtested result. This reuses the
  backtest trades-panel / metrics presentation.

**Disarm keeps the open position** (and its broker bracket); it only stops the
engine. A separate explicit "Disarm & flatten now" is the destructive variant.

## Re-arm with an open position (folded-in decision)

When the user re-arms with a new snapshot while a position is open, the open
position **finishes under the rules it was opened with** — both its broker
bracket (already server-side) and its engine-managed rule-based exits use the
**original** snapshot until the position closes. The **new snapshot governs only
future entries** (positions opened after the re-arm).

This requires the engine to tag each open position with the snapshot that opened
it (its "rule vintage") and to evaluate that position's exits against *its own*
opening snapshot, not the currently-armed one. Because positions are netted
(at most one open per epic + account), in practice this means: the currently
open position keeps its opening snapshot; the freshly-armed snapshot is what the
engine uses for the next entry once the position is flat. The panel surfaces this
— e.g. the pending-changes banner reads "applies to new entries; current position
finishes on its original rules."

## Live-only safety (hazards the backtest never faces)

1. **Idempotency.** Browser-driven guarantees repeats (reload mid-bar, HMR, two
   tabs, re-arm). The derived `client_order_id` collapses them to one order.
   Confirmed: all three brokers dedupe.
2. **Single owner.** A `BroadcastChannel` lease ensures only one tab drives a
   given armed (epic + account) strategy; other tabs show "running elsewhere."
3. **Reconcile on arm and on every reload.** Query broker positions and adopt
   them before evaluating, so the engine never re-enters an already-open
   position or manages a phantom.
4. **Missed bars.** On wake-from-sleep (several bars closed at once), evaluate
   only the **latest** closed bar. Never replay a stale cross as a fresh market
   order. This is a deliberate semantic break from the backtest's
   replay-every-bar model.
5. **Warmup.** On arm, load history and warm indicators before the first live
   eval, reusing the backtest's history-depth setting.

## Known limitations (stated, not solved in v1)

- **Browser-driven:** closing the tab stops entries and rule-based exits. Broker
  brackets still protect open positions server-side.
- **Trailing / ATR stops** can't be expressed as a static broker bracket. In
  browser-driven mode they are engine-managed while the tab is open, or mapped
  to the broker's native trailing stop where supported. Flagged, not solved in
  v1.
- **Fill parity:** live fills at market on signal detection, so entry prices will
  not match the backtest's next-bar-open fills. Expected, not a bug.
- **Bracket anchoring:** the broker bracket is computed from the *latest closed
  bar's close* and sent with the entry order, so the position is protected the
  instant it fills. The stop distance is therefore anchored to that close, not to
  the actual fill price (they differ by the entry slippage). The more-correct
  alternative — place the market order, read `fill_price` from the `OrderResult`,
  then attach the bracket via `applyLevels` — leaves a brief unprotected window
  and is deferred; v1 uses submit-from-close.

## New code surface

- **Backend:** one endpoint, `POST /api/strategy/evaluate`, wrapping the existing
  `RuleStrategy`. No new order plumbing.
- **Frontend:**
  - `liveEngine.ts` — the loop: WS bar-close → compute indicators → reconcile →
    evaluate → place orders; owns the `BroadcastChannel` lease and the derived
    `client_order_id`.
  - `LiveTradingPanel.tsx` — reuses the rule editor, adds arm / account / size /
    status.
  - Persistence of the armed snapshot per epic + account (so an armed strategy
    survives a reload and re-adopts its broker position on resume).

## Out of scope (future)

- Autonomous backend daemon (the loop moves server-side; the evaluation seam and
  order routing already support it).
- Backend "armed lease" replacing the `BroadcastChannel` lock.
- Multiple armed copies of the same epic + account.
