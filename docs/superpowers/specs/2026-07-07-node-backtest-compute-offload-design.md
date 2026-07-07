# Node backtest compute offload — run the same TS server-side

Date: 2026-07-07

## Motivation

Today **all** indicator math runs in the browser. `buildSeries()` computes every
operand/ATR/slope series from the exact candles, and the browser POSTs the finished
numbers to `POST /api/backtest`; the Python backend is deliberately indicator-agnostic
and only evaluates rules against the posted arrays. That design gives us one prized
property: **the chart and the backtest use the identical TypeScript, so they can never
disagree.** Reimplementing the math in Python would put that guarantee at risk.

This is **forward-looking, not a current pain point** (see memory
`offload-compute-to-node`). The reason to write it down now is that the computation path
turns out to be almost entirely pure, so the option is cheap to keep open — and we want a
plan on the shelf for when a real signal arrives:

- users backtesting huge ranges / many symbols and waiting noticeably,
- wanting backtests or scans to run **without the tab open** (scheduled / overnight /
  server-side),
- weak-device (phone / old laptop) complaints,
- running the same backtest for many users and caching the result once.

The move: run the **existing TypeScript** in a small Node service, instead of rewriting
the math in Python. Same source → same numbers → parity preserved.

## Scope

- **In scope:** offloading the **backtest series computation** (`buildSeries()` and the
  indicator functions it calls) to an optional Node service that can run headless.
- **Explicitly out of scope:**
  - **Interactive chart indicators stay in the browser.** They recompute on every
    pan / zoom / param-tweak / tick and must feel instant; the browser already holds the
    candles. Round-tripping these to a server would only add lag. This spec never touches
    the chart render path.
  - **Rewriting indicator math in Python** — the whole point is to *avoid* that.
  - **Rewriting the rule engine** — the Python backtest engine
    (`backend/.../api/routers/backtest.py`, `strategy/rule.py`) is unchanged. It keeps
    receiving pre-computed series and evaluating rules positionally.
  - **Live evaluation** (`/api/strategy/evaluate`) — same shape, could follow later, not
    in this pass.
  - **Making it the default.** The browser path stays; the Node service is an *alternate
    producer* of the same `series` payload, selected per-run.

## Current state (as mapped)

The scoping pass (read-only) found the computation path is **highly portable** — pure
math, no DOM, no `window`, no klinecharts *runtime* calls:

| Component | File:line | Portable? |
|-----------|-----------|-----------|
| `buildSeries()` | `frontend/src/lib/backtestSeries.ts:34-77` | ✅ pure async; one injected callback |
| MA/EMA/SMA + HTF align | `frontend/src/lib/mtf.ts:45-199` | ✅ pure |
| ATR | `frontend/src/lib/atr.ts:11-38` | ✅ pure |
| VWAP/AVWAP | `frontend/src/lib/indicators/vwap.ts:77-136` | ✅ pure |
| Linear Regression | `frontend/src/lib/indicators/lr.ts:40-86` | ✅ pure |
| RSI + divergences | `frontend/src/lib/indicators/rsi.ts:358-427` | ✅ pure (`draw` callback is separate, not called) |
| Prev High/Low | `frontend/src/lib/indicators/prevHl.ts:413-448` | ⚠️ pure math, but tz-sensitive (see hazard below) |
| config/hash/seriesName | `frontend/src/lib/backtestConfig.ts` | ✅ pure data + hashing |

`KLineData` in `backtestSeries.ts` is imported **type-only** — it's just
`{ timestamp, open, high, low, close, volume? }`. **But** (review finding): the indicator
*modules* also import klinecharts **runtime** values (`IndicatorSeries`, `LineType` —
`rsi.ts:11`, `vwap.ts:7`, `ma.ts:6`) for the chart-template definitions co-located at the
bottom of each file. The compute functions never touch them, but a Node consumer of these
modules as-is would drag klinecharts runtime in. Step A must split compute from template.

**Chart-state inputs verified safe (review finding):** drawing-based operands snapshot
their anchors as absolute `{timestamp, value}` pairs into the recipe at copy time
(`backtestSeries.ts:229-253`, `chartOperand.ts:99-114`); AVWAP anchors are absolute
epoch-ms in the operand. Backtest config comes from persistence and candles from the
backend, not the klinecharts instance — the whole request is serializable, nothing needs
live chart state.

**Parity hazard — PREV_HL timezone (must fix).** When a Prev High/Low indicator is left on
the "chart/default" timezone, the recipe does **not** capture a tz
(`IndicatorSettings.tsx:612` deletes it); `computePrevHl` then falls back to a module-level
`indicatorTz` initialized from the *runtime's own* timezone. A browser in Europe/Berlin and
a Node process in UTC would bucket day/week boundaries differently → **silently different
series**. Fix before B ships (decision below).

**The one real dependency to abstract: higher-timeframe bar fetching.** `buildSeries()`
takes a callback and calls it when an operand references a higher TF than the base run:

```ts
// backtestSeries.ts (type at ~line 32, used ~line 55)
export type FetchTimeframe = (resolution: string) => Promise<KLineData[]>;
```

In the browser (`BacktestButton.tsx:136-137`) that callback is `fetchRange(...)` →
`frontend/src/lib/feed.ts:512` → `fetch('/api/candles?...')` on the backend. So the *only*
piece the browser supplies that a Node service can't reuse verbatim is **how it gets HTF
candles** — and that's already a clean seam (a single injected function returning
`KLineData[]` ascending by time).

**Request contract** (`frontend/src/api.ts` `BacktestRequest`; validated at
`backend/.../routers/backtest.py:36-76`): the backend checks `len(series[name]) ==
len(candles)` for every series and re-derives each rule's operand names to confirm they're
present. So a Node-produced payload must be **byte-for-byte equivalent** to the browser's:
identical series keys (`seriesName()` contract) and identical array lengths (null-padded
warm-up). Because it's the *same* source, this is automatic — but it's the thing tests
must lock down.

## Design

Three pieces: (A) make the math a shared, Node-runnable library; (B) stand up a thin Node
service exposing it with a server-side `fetchTimeframe`; (C) let the frontend optionally
delegate to it.

### A — Extract a shared, environment-agnostic compute library

Goal: **one source of truth**, consumed by both the frontend bundle and Node — no copy.

- Create a shared package (e.g. `packages/indicators/`) or a `frontend/src/lib`
  sub-tree with **no browser imports**, containing: `backtestSeries.ts`, `mtf.ts`,
  `atr.ts`, the indicator **compute functions**, and `backtestConfig.ts`.
- **Split compute from chart templates** (bigger than a re-export — this is the bulk of A):
  each `indicators/*.ts` currently holds both the pure compute function and the klinecharts
  template (which imports `IndicatorSeries`/`LineType` at runtime). Move the compute
  functions (`computeRsi`, `vwapFrom`, `computeLr`, `computePrevHl`, `maSeries`, …) into
  the shared library; leave the templates (and `customIndicators.ts` with its
  `registerIndicator` calls) frontend-side, importing the compute functions from the
  library. Compute code must never reference template exports.
- **Extract `RESOLUTION_SECONDS` into its own `resolutions.ts`** in the library. It lives
  in `feed.ts` today, and `feed.ts` drags Vite-specific `http.ts`
  (`import.meta.env.VITE_API_BASE`), `syntheticRegistry`, and `theme` — none of which can
  come along. Existing `feed.ts` importers switch to dual imports (`RESOLUTION_SECONDS`
  from `resolutions.ts`, the rest from `feed.ts`). Relatedly: the Node service gets its
  API base from an env var, **not** by reusing `http.ts`.
- Replace the type-only klinecharts import with a **local `KLineData` interface** so the
  library has zero klinecharts dependency.
- **Fix the PREV_HL timezone hazard** (pick one):
  - *Preferred:* always bake an explicit tz into the PREV_HL recipe at operand-copy time —
    resolve "chart/default" to the concrete IANA zone then and there. Deterministic
    payloads, no request-shape change, and the recipe hash honestly reflects what was
    computed.
  - *Alternative:* pass `browserTimezone` alongside the request and have the library take
    tz as a parameter instead of module-level state. (More plumbing; only needed if
    resolving at copy time is undesirable.)
  Either way, `computePrevHl`'s module-level `indicatorTz` fallback must not be the thing
  that decides parity.
- Keep `FetchTimeframe` as the injected seam — the library never fetches anything itself.
- Node-targeted `tsconfig` (ES2020+, **no `DOM` lib**, NodeNext resolution). ESM already
  (`"type": "module"`), so no module-system churn.
- Frontend keeps importing from this library; nothing about the browser path changes
  except the import location.

**Guardrail:** a lint/CI rule that the shared library must not import `window`,
`document`, `fetch`, React, or klinecharts runtime — so it stays portable.

### B — Thin Node compute service

- Small Node (Express/Fastify) service, single endpoint, e.g.
  `POST /compute-series` → `{ candles, cfg, resolution }` in, `{ series }` out.
- It calls `buildSeries()` from the shared library, supplying a **server-side
  `fetchTimeframe`**:
  - Preferred: hit the **existing backend candle cache** (`/api/candles`, the sqlite
    history cache) so HTF bars come from the same source the browser used — guaranteeing
    identical inputs, hence identical outputs.
  - It needs the same params the browser passes: `epic`, `resolution`, `from`, `to`,
    `priceSide`, `brokerId`. Those ride along in the request (they already exist
    frontend-side in `BacktestButton`).
  - **Open question to verify before building B:** whether `/api/candles` needs any
    session/broker auth a headless caller won't have. The router
    (`backend/.../routers/charts.py:42`) shows no auth layer, but it delegates into
    broker-context code (`deps._fetch_symbol_candles`) — confirm a plain server-to-server
    call works, or decide what credential the Node service presents.
- Returns the `series` map. Whoever called it forwards that map into the existing
  `POST /api/backtest` unchanged.

Data flow:

```
Node POST /compute-series
  ├─ candles[]     (base bars, from caller)
  ├─ cfg + rules
  ├─ resolution
  └─ {epic, priceSide, brokerId, from, to}   → to build fetchTimeframe

  buildSeries(candles, cfg, resolution, fetchTimeframe=serverFetch)
      serverFetch(tf) → GET backend /api/candles?... → KLineData[]

  → { series }   (identical to what the browser would have posted)
```

### C — Frontend opt-in delegation

- `BacktestButton` gains a switch: compute **locally** (today's path) or **delegate**
  (POST the raw inputs to the Node service, receive `series`, then POST to
  `/api/backtest` as now). Default stays local.
- The rest of `BacktestButton` — request assembly, rendering, persistence — is untouched;
  only the *producer* of `series` changes.
- This makes the two paths trivially **diff-testable** from the same UI.

## Parity strategy (the crux)

The backend trusts the numbers; a silent divergence between browser-computed and
Node-computed series would be a correctness bug. So:

1. **Same source, not a port** — A guarantees the exact same functions run in both places.
2. **Same HTF inputs** — B's `fetchTimeframe` reads the same candle cache the browser does.
3. **Golden diff test** — capture a set of real backtest input payloads; assert that
   `series` computed in-browser (jsdom/vitest) and via the Node service are **deep-equal**
   (keys, lengths, every value incl. `null` warm-up padding). This test is the contract.
4. **Shared unit tests** — the existing vitest indicator tests run against the shared
   library, so both consumers are covered by one suite.

## Risks / tradeoffs

- **New stateful tier.** Today the frontend host is a dumb static CDN and browser compute
  is free (the user's device). A Node service is something to run, scale, monitor, and
  pay for — multiplied by users. Justified only when a real signal (above) appears.
- **HTF fetch latency/cost** moves server-side; mitigated by reading the local candle
  cache rather than upstream brokers.
- **Two code homes to keep honest** — solved by A (one library) + the golden diff test,
  not by discipline alone.
- **Compute/template re-coupling.** The split in A works today, but a future indicator
  refactor that moves compute logic into a template definition would silently break
  portability. The no-browser-import guardrail on the shared library is what catches this
  — it's load-bearing, not nice-to-have.
- **Environment-sensitive math.** PREV_HL's tz fallback is the known instance; the golden
  diff test should deliberately run browser-side and Node-side in *different* timezones so
  any future `Intl`/locale sensitivity fails loudly instead of silently.
- **Scope creep toward "compute everything server-side."** Resist: chart stays in the
  browser; this is backtest-only.

## Rollout

1. **A only** — split compute functions from chart templates, extract the shared library +
   `resolutions.ts`, fix the PREV_HL tz capture, repoint the frontend, add the
   no-browser-import guardrail and the golden test. Zero behavior change, pure safety net.
   *This is the piece worth doing even before there's demand*, because it makes everything
   after it cheap. (Note: the review found A is bigger than a re-export — the
   compute/template split touches every indicator file.)
2. **B** — verify `/api/candles` auth for headless callers, then stand up the Node service
   behind a feature flag; validate with the golden diff test against recorded payloads
   (run the two sides in different timezones on purpose).
3. **C** — wire the opt-in toggle in `BacktestButton`; dogfood on large backtests.
4. Later (out of this spec): headless/scheduled runs, live-eval offload, result caching.

## Not doing (and why)

- **Porting to Python** — breaks the single-source-of-truth; the entire reason to use Node.
- **Moving chart indicators** — interactivity demands local compute.
- **Making Node the default** — the browser path is correct for most runs; Node is the
  escape hatch for heavy/headless work.
