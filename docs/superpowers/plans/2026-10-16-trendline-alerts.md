# Trendline Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Alerts on the auto Trendlines indicator: on one right-clicked line (a frozen `line` kind) and on whichever line is nearest to price (`indicator` kind, `TRENDLINES`), both firing server-side with no browser open.

**Architecture:** Both alert types watch one straight line in bars of the alert's timeframe. The `line` kind is a cheap hub series (`IndicatorKey("LINE", (tRef, pRef, slope), ())`) whose reference bar the engine rolls forward every 1000 bars. The nearest-line kind runs the full Python Trendlines compute once per closed bar and keeps the HELD line (the previous bar's nearest), so close mode judges a cross against one line (`resolve_close`) and intrabar only projects (no recompute). The frontend gains a `LineAlert` type in the same server-alert cache, a right-click "Add alert" entry, a `LineAlertModal`, a dashed sloped alert line and a bell.

**Tech Stack:** Python 3 / FastAPI / pytest (backend), TypeScript / React / klinecharts / vitest (frontend).

**Spec:** `docs/superpowers/specs/2026-10-16-trendline-alerts-design.md`

## Global Constraints

- No em dashes ("—" or "--") in any UI text; split the sentence instead.
- Tooltips use the shared `Tooltip` / `InfoTip` components; never a native `title=` attribute. Disabled menu items carry `disabledReason`.
- Run only the affected frontend test files (`npx vitest run <files>`), never the full frontend suite.
- `npx tsc -b` (NOT `--noEmit`) is the typecheck. It is high-CPU: ask the user before running it.
- Backend tests: `cd backend && python3 -m pytest <specific files> -q`.
- Commits stage explicit paths only (`git add <path> ...`). Shared worktree: never `git stash`, `git clean`, `git restore`, `git checkout -- .`.
- Commit on `main`, no branches, never push.
- Parity fixtures regenerate with `cd frontend && UPDATE_PARITY=1 npx vitest run src/lib/alertableParity.test.ts`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Seed cap is 2000 bars (`SEED_CAP`), `MAX_WARMUP` 1950; line rebase threshold 1000 bars.
- Native timeframes only (1m to 1W); non-native: "Alerts on this timeframe are coming later"; seconds: entry hidden.

## Spec deviations (decided while planning against the real code)

1. **No `series_needs` / `resolve(params, ctx)`.** The spec template mentions D1 from the earlier spec, but the real `AlertKind` protocol (`backend/auto_trader/core/alert_kinds.py:36-44`) is `indicator_key` + `resolve(params, price, values)`. This plan adds `resolve_close` and `level_sig` to that real protocol.
2. **No new store method.** `AlertStore.update` already merges `params` sub-keys (`alert_store.py:195-199`), so the rebase patches `{"params": {"tRef", "pRef"}}` through it.
3. **`link` stays nullable for `line`.** "Keep" on pane removal unlinks (as for indicator alerts); the menu always sends a link. Required-link would make "Keep" impossible.
4. **Readiness split from seeding.** `warmup(key)` stays the seed target (MAX_WARMUP for LINE and TRENDLINES); a new `min_bars(key)` gates `ready`. TRENDLINES `ready` does not require non-None values (an empty pane is "ok", not "waiting"), via a new `sparse(key)`.
5. **Held-line signature is two outputs `a1`, `a2`** (anchor open times in ms) plus `slope`, not one `held_sig` number.
6. **`held` parity is Python-only.** TS never computes `held`; Python gets an invariant test (same anchors on consecutive bars means `held == value`). `value` (tl_nearest) is in the TS/Python parity fixture.
7. **Line-alert bell only when the chart's timeframe equals the alert's.** The dashed line shows whenever the pane's alert timeframe matches; the bell needs bar-exact projection, which a different chart timeframe cannot give.
8. **The 1m decision** is a constant `TRENDLINES_REFUSED_TF` set by Task 0's measurement.

## Review Focus

1. **Server restarted after a long outage** (a 1m line alert whose `tRef` fell out of the 2000-bar seed): expect the alert to report `waiting_for_data`, never to fire on a wrong level. Pinned in Task 2 (`test_line_not_ready_when_tref_missing`).
2. **Pinned Trendlines pane (1D pin on a 1H chart):** the line's slope must be per DAILY bar and `tRef` a daily bar time. Pinned in Task 7 (`alertLineOf` with HTF starts).
3. **Weekend gap:** a line alert counts bars, not hours, across a market closure. Pinned in Task 1 (`test_line_compute_counts_bars_across_a_gap`).
4. **Editing Trendlines settings after a "this line" alert:** the alert must not move, be re-pointed or trigger the conflict prompt. Pinned in Task 9 (`syncAlertsAfterEdit leaves line alerts alone`).
5. **Nearest-line alert on a pane that draws nothing:** status `ok`, never fires. Pinned in Task 2 (`test_trendlines_ready_with_no_line`) and Task 3 (`resolve` returns None).

Also watched (no dedicated test can pin it): a full Python Trendlines compute runs inline on the event loop at each close. Task 0's number decides 1m; if even 1H looks heavy (> 500 ms), stop and raise it with the user.

---

### Task 0: Measure the Python Trendlines compute on 2000 bars

**Files:**
- None committed. Result recorded in the spec's Known limits (Task 11) and used in Task 1.

- [ ] **Step 1: Run the timing script**

```bash
cd backend && python3 - <<'EOF'
import math, random, statistics, time
from datetime import datetime, timedelta, timezone
from auto_trader.core.models import Candle
from auto_trader.indicators.trendlines import compute_trendlines, parse_trendlines_config

def series(seed):
    random.seed(seed)
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    p, out = 100.0, []
    for i in range(2000):
        o = p
        p = max(1.0, p + random.gauss(0, 0.6) + 0.8 * math.sin(i / 40))
        hi, lo = max(o, p) + random.random() * 0.4, min(o, p) - random.random() * 0.4
        out.append(Candle(t0 + timedelta(minutes=i), o, hi, lo, p, 1.0))
    return out

cfg = parse_trendlines_config([], {})
times = []
for s in range(5):
    c = series(s)
    t = time.perf_counter(); compute_trendlines(c, cfg); times.append((time.perf_counter() - t) * 1000)
print("ms per 2000-bar compute:", [round(x) for x in times], "median", round(statistics.median(times)))
EOF
```

Expected: one line with five timings and a median.

- [ ] **Step 2: Decide 1m**

If the median is above 150 ms, nearest-line alerts refuse 1m: Task 1 sets `TRENDLINES_REFUSED_TF = frozenset({"MINUTE"})` and Task 6 mirrors `new Set(["MINUTE"])`. Otherwise both are empty. If the median is above 500 ms, stop and report to the user before continuing (every timeframe would stall the feed loop). Write the median down for Task 11.

---

### Task 1: LINE and TRENDLINES in the alertable registry (both sides + parity)

**Files:**
- Modify: `backend/auto_trader/indicators/trendlines.py` (emit block at `:1086-1100`, new helpers after `parse_trendlines_config`)
- Modify: `backend/auto_trader/indicators/alertable.py`
- Modify: `frontend/src/lib/indicators/trendlinesOutputs.ts` (new `canonicalTrendlinesParams`)
- Modify: `frontend/src/lib/alertableIndicators.ts` (registry entry, `MAIN_LINE_KEY`, type, label)
- Modify: `frontend/src/lib/alertableParity.test.ts` (TRENDLINES case)
- Regenerate: `backend/tests/fixtures/indicator_parity/{alertable,values}.json`
- Test: `backend/tests/test_alertable.py`, `backend/tests/test_indicator_parity.py`

**Interfaces:**
- Produces (Python, `indicators/trendlines.py`): `TL_SLOT_FIELDS: tuple[str, ...]` (33 names), `trendlines_config_params(cfg) -> list[float]`, `TL_DEFAULT_PARAMS: list[float]`, `compute_trendlines(candles, cfg, *, nearest_out: list[TrendLine | None] | None = None)`.
- Produces (Python, `indicators/alertable.py`): `ALERTABLE["TRENDLINES"]`, `TRENDLINES_REFUSED_TF: frozenset[str]`, `min_bars(key) -> int`, `sparse(key) -> bool`, `line_key(t_ref: int, p_ref: float, slope: float) -> IndicatorKey`; `compute` returns `{"value"}` for LINE and `{"value", "held", "slope", "a1", "a2"}` for TRENDLINES; `warmup` returns `MAX_WARMUP` for both; `indicator_label` gives `"Trendlines nearest"` / `"Trendline"`.
- Produces (TS): `canonicalTrendlinesParams(calcParams: unknown, extendData?: unknown): number[]`; `AlertIndicator` includes `"TRENDLINES"`; `MAIN_LINE_KEY.TRENDLINES === "tl_nearest"`.

- [ ] **Step 1: Write the failing backend tests**

Append to `backend/tests/test_alertable.py`:

```python
from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle
from auto_trader.indicators.trendlines import (
    TL_DEFAULT_PARAMS, TL_SLOT_FIELDS, parse_trendlines_config, trendlines_config_params,
)

H = 3_600_000


def hc(ms, close):
    return Candle(datetime.fromtimestamp(ms / 1000, tz=timezone.utc), close, close, close, close, 1.0)


def test_trendlines_validate_accepts_canonical_only():
    assert len(TL_DEFAULT_PARAMS) == len(TL_SLOT_FIELDS) == 33
    assert A.validate_indicator("TRENDLINES", list(TL_DEFAULT_PARAMS), {}, "value", "price") == {}
    short = list(TL_DEFAULT_PARAMS)[:5]
    with pytest.raises(ValueError, match="Trendlines settings"):
        A.validate_indicator("TRENDLINES", short, {}, "value", "price")
    bad = list(TL_DEFAULT_PARAMS)
    bad[2] = 1  # min_touches parses to 2, so 1 is not canonical
    with pytest.raises(ValueError, match="canonical"):
        A.validate_indicator("TRENDLINES", bad, {}, "value", "price")
    with pytest.raises(ValueError, match="target"):
        A.validate_indicator("TRENDLINES", list(TL_DEFAULT_PARAMS), {}, "value", "value")
    with pytest.raises(ValueError, match="config"):
        A.validate_indicator("TRENDLINES", list(TL_DEFAULT_PARAMS), {"x": "y"}, "value", "price")


def test_trendlines_validate_applies_warmup_cap():
    # min_bars = ATR 14 + 2 * pivot_len + min_span_bars, so a canonical but
    # huge min span must 422 like an over-long MA does. If the parser clamps
    # min_span_bars below the cap, raise pivot_len instead (same slot list).
    huge = list(TL_DEFAULT_PARAMS)
    huge[TL_SLOT_FIELDS.index("min_span_bars")] = A.MAX_WARMUP
    canon = trendlines_config_params(parse_trendlines_config(huge, {}))
    assert A.min_bars(A.IndicatorKey("TRENDLINES", tuple(canon), ())) > A.MAX_WARMUP
    with pytest.raises(ValueError, match="too long"):
        A.validate_indicator("TRENDLINES", canon, {}, "value", "price")


def test_line_and_trendlines_warmup_min_bars_and_sparse():
    tl = A.IndicatorKey("TRENDLINES", tuple(TL_DEFAULT_PARAMS), ())
    ln = A.line_key(10 * H, 100.0, 0.5)
    assert A.warmup(tl) == A.MAX_WARMUP and A.warmup(ln) == A.MAX_WARMUP
    assert A.min_bars(tl) == 14 + 2 * 5 + 20  # trendlines_warmup on the defaults
    assert A.min_bars(ln) == 1
    assert A.sparse(tl) and not A.sparse(ln)
    assert A.indicator_label(tl) == "Trendlines nearest"


def test_line_compute_projects_from_the_reference_bar():
    bars = [hc(h * H, 1.0) for h in range(5, 12)]
    out = A.compute(A.line_key(8 * H, 100.0, 0.5), bars)["value"]
    assert out == [None, None, None, 100.0, 100.5, 101.0, 101.5]
    assert A.compute(A.line_key(99 * H, 100.0, 0.5), bars)["value"] == [None] * 7


def test_line_compute_counts_bars_across_a_gap():
    # Fri 20:00..21:00, then Mon 00:00..01:00: the slope is per BAR.
    fri = int(datetime(2026, 10, 9, 20, tzinfo=timezone.utc).timestamp() * 1000)
    mon = int(datetime(2026, 10, 12, 0, tzinfo=timezone.utc).timestamp() * 1000)
    bars = [hc(fri, 1), hc(fri + H, 1), hc(mon, 1), hc(mon + H, 1)]
    assert A.compute(A.line_key(fri, 10.0, 1.0), bars)["value"] == [10.0, 11.0, 12.0, 13.0]


def test_trendlines_held_equals_value_while_the_nearest_line_is_unchanged():
    from tests.test_indicator_parity import _ALERTABLE_CANDLES as candles
    out = A.compute(A.IndicatorKey("TRENDLINES", tuple(TL_DEFAULT_PARAMS), ()), candles)
    assert any(v is not None for v in out["value"])
    same = 0
    for i in range(1, len(candles)):
        if out["a1"][i] is not None and (out["a1"][i], out["a2"][i]) == (out["a1"][i - 1], out["a2"][i - 1]):
            assert out["held"][i] == pytest.approx(out["value"][i], rel=1e-12)
            assert out["value"][i] - out["value"][i - 1] == pytest.approx(out["slope"][i], rel=1e-9, abs=1e-12)
            same += 1
    assert same > 0
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && python3 -m pytest tests/test_alertable.py -q`
Expected: FAIL with `ImportError: cannot import name 'TL_DEFAULT_PARAMS'`.

- [ ] **Step 3: Trendlines helpers and `nearest_out`**

In `backend/auto_trader/indicators/trendlines.py`, right after `parse_trendlines_config` (before `_legacy_near_price`), add:

```python
# calcParams slot order, so a config round-trips to the canonical array an
# alert stores. Mirrors TL_SLOT_KEYS in trendlinesOutputs.ts.
TL_SLOT_FIELDS: tuple[str, ...] = (
    "pivot_len", "touch_mult", "min_touches", "min_span_bars", "max_proj_bars",
    "max_lines", "min_swing_atr", "min_swing_reach", "pair_pivots", "max_touches",
    "max_span_bars", "max_slope_atr", "min_slope_atr", "max_touch_spacing",
    "min_touch_spacing", "min_crossings", "max_crossings", "pierce_mult",
    "min_back_bars", "max_dist_atr", "max_dist_pct", "merge_atr", "max_per_pivot",
    "merge_pct", "major_pivots", "major_len", "major_size_atr", "lookback_bars",
    "extend_left", "fan_atr", "fan_pct", "fan_keep", "pivot_strong",
)


def trendlines_config_params(cfg: TrendlinesConfig) -> list[float]:
    """The canonical calcParams for a parsed config (every slot, as floats)."""
    return [float(getattr(cfg, f)) for f in TL_SLOT_FIELDS]
```

And at the end of the module:

```python
TL_DEFAULT_PARAMS: list[float] = trendlines_config_params(parse_trendlines_config([], {}))
```

Change the `compute_trendlines` signature to:

```python
def compute_trendlines(
    candles: Sequence[Candle], cfg: TrendlinesConfig, *,
    nearest_out: list[TrendLine | None] | None = None,
) -> tuple[list[dict[str, float]], list[TrendLine]]:
    """Transliteration of TS stepTrendlinesBar over every bar: same loop order,
    same branch order, same arithmetic order. Returns (points, live lines).
    `nearest_out`, when given (length n, all None), receives the line behind
    tl_nearest at each bar: alert-only, the TS has no twin."""
```

Replace the emit tail (`nearest_v = 0.0` through `points[i] = point`) with:

```python
        nearest_v = 0.0
        nearest_d = math.inf
        nearest_line: TrendLine | None = None
        # select_levels reads max_lines 0 as uncapped; the parser never yields
        # 0, but a raw cfg can, and it must still emit no tl_k. Mirrors TS.
        shown = min(len(drawn), cfg.max_lines)
        for r in range(shown):
            v = project_at(drawn[r], i)
            point[tl_output_name(r + 1)] = v
            d = abs(v - close)
            if d < nearest_d:
                nearest_d = d
                nearest_v = v
                nearest_line = drawn[r]
        if shown:
            point[TL_NEAREST] = nearest_v
        if nearest_out is not None:
            nearest_out[i] = nearest_line
        points[i] = point
```

- [ ] **Step 4: Alertable registry**

In `backend/auto_trader/indicators/alertable.py`, extend the imports:

```python
from auto_trader.core.alert_bars import candle_ms
from auto_trader.indicators.trendlines import (
    TL_NEAREST, TL_SLOT_FIELDS, TrendLine, compute_trendlines, parse_trendlines_config,
    project_at, trendlines_config_params, trendlines_warmup,
)
```

Add the registry entry inside `ALERTABLE` after `"ATR"`:

```python
    # calcParams is the CANONICAL full array (trendlines_config_params), checked
    # by the parser rather than by ranges, so "params" is empty.
    "TRENDLINES": {"lines": ["value"], "priceTarget": True, "params": [], "config": {}},
```

After `ALERTABLE`, add (set per Task 0; empty when its median was 150 ms or less):

```python
# Timeframes a nearest-line alert refuses: one full Trendlines compute runs per
# closed bar, inline. Set from the 2026-10-16 timing (plan Task 0).
TRENDLINES_REFUSED_TF: frozenset[str] = frozenset()


def line_key(t_ref: int, p_ref: float, slope: float) -> IndicatorKey:
    """The hub need for a `line` alert: a straight line in bars from tRef."""
    return IndicatorKey("LINE", (float(t_ref), float(p_ref), float(slope)), ())
```

(Place `line_key` after the `IndicatorKey` class.) At the top of `warmup`:

```python
    if key.indicator in ("LINE", "TRENDLINES"):
        # Seed target only: load all the history the cap allows. Readiness
        # is min_bars, not this.
        return MAX_WARMUP
```

After `warmup`, add:

```python
def min_bars(key: IndicatorKey) -> int:
    """Closed bars a series needs before `ready` (warmup is the SEED target)."""
    if key.indicator == "LINE":
        return 1
    if key.indicator == "TRENDLINES":
        return trendlines_warmup(parse_trendlines_config(list(key.calc), {}), TL_NEAREST)
    return warmup(key)


def sparse(key: IndicatorKey) -> bool:
    """Outputs may be None on a ready series (no trendline drawn)."""
    return key.indicator == "TRENDLINES"
```

At the top of `validate_indicator`, right after the `spec is None` check:

```python
    if indicator == "TRENDLINES":
        n = len(TL_SLOT_FIELDS)
        if (
            not isinstance(calc_params, list) or len(calc_params) != n
            or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v)
                   for v in calc_params)
        ):
            raise ValueError(f"params.calcParams must be the {n} Trendlines settings")
        if [float(v) for v in calc_params] != trendlines_config_params(
            parse_trendlines_config(calc_params, {})
        ):
            raise ValueError("params.calcParams must be canonical Trendlines settings")
        if not isinstance(config, dict) or config:
            raise ValueError("params.config must be {} for TRENDLINES")
        if line != "value":
            raise ValueError("params.line must be one of ['value']")
        if target != "price":
            raise ValueError("params.target must be 'price' for TRENDLINES")
        # Same warm-up cap as the other indicators: a huge pivot length or
        # min span must 422 rather than wait forever for bars.
        if min_bars(IndicatorKey("TRENDLINES", tuple(calc_params), ())) > MAX_WARMUP:
            raise ValueError("params.calcParams: length too long for alerts")
        return {}
```

At the top of `compute`:

```python
    if key.indicator == "LINE":
        t_ref, p_ref, slope = key.calc
        times = [candle_ms(c) for c in candles]
        try:
            j = times.index(int(t_ref))
        except ValueError:
            return {"value": [None] * len(candles)}
        return {"value": [None if k < j else p_ref + slope * (k - j) for k in range(len(candles))]}
    if key.indicator == "TRENDLINES":
        return _trendlines_values(key, candles)
```

And the helper above `compute`:

```python
def _trendlines_values(key: IndicatorKey, candles: Sequence[Candle]) -> dict[str, list[float | None]]:
    """value: the nearest line at bar i (tl_nearest). held: the line nearest
    at bar i-1, projected to bar i (the one a close-mode cross is judged
    against). slope / a1 / a2: the nearest line's slope per bar and anchor
    open times, so intrabar can project it and the engine can tell a switch."""
    n = len(candles)
    nearest: list[TrendLine | None] = [None] * n
    points, _ = compute_trendlines(candles, parse_trendlines_config(list(key.calc), {}), nearest_out=nearest)
    held: list[float | None] = [None] * n
    for i in range(1, n):
        prev = nearest[i - 1]
        if prev is not None:
            held[i] = project_at(prev, i)
    return {
        "value": [p.get(TL_NEAREST) for p in points],
        "held": held,
        "slope": [None if ln is None else (ln.p2 - ln.p1) / (ln.i2 - ln.i1) for ln in nearest],
        "a1": [None if ln is None else float(candle_ms(candles[ln.i1])) for ln in nearest],
        "a2": [None if ln is None else float(candle_ms(candles[ln.i2])) for ln in nearest],
    }
```

At the top of `indicator_label`:

```python
    if key.indicator == "TRENDLINES":
        return "Trendlines nearest"
    if key.indicator == "LINE":
        return "Trendline"
```

Check `alert_bars.py` imports nothing from `indicators` (it imports only stdlib and `core.models`), so the new import is cycle-free.

- [ ] **Step 5: Run the backend tests**

Run: `cd backend && python3 -m pytest tests/test_alertable.py -q`
Expected: PASS. (`test_indicator_parity.py::test_alertable_registry_matches_frontend` now fails until Step 8; that is expected.)

- [ ] **Step 6: TS canonical params and registry mirror**

In `frontend/src/lib/indicators/trendlinesOutputs.ts`, after `parseTrendlinesConfig`:

```ts
/** calcParams slot order. Mirrors TL_SLOT_FIELDS in indicators/trendlines.py. */
const TL_SLOT_KEYS: ReadonlyArray<keyof TrendlinesConfig> = [
  "pivotLen", "touchMult", "minTouches", "minSpanBars", "maxProjBars", "maxLines",
  "minSwingAtr", "minSwingReach", "pairPivots", "maxTouches", "maxSpanBars",
  "maxSlopeAtr", "minSlopeAtr", "maxTouchSpacing", "minTouchSpacing", "minCrossings",
  "maxCrossings", "pierceMult", "minBackBars", "maxDistAtr", "maxDistPct", "mergeAtr",
  "maxPerPivot", "mergePct", "majorPivots", "majorLen", "majorSizeAtr", "lookbackBars",
  "extendLeft", "fanAtr", "fanPct", "fanKeep", "pivotStrong",
];

/** Every slot, resolved (legacy extendData migrations included): what an
 * alert stores, so the server can re-parse it with no extendData. */
export function canonicalTrendlinesParams(calcParams: unknown, extendData?: unknown): number[] {
  const cfg = parseTrendlinesConfig(calcParams, extendData);
  return TL_SLOT_KEYS.map((k) => cfg[k] as number);
}
```

In `frontend/src/lib/alertableIndicators.ts`:

```ts
export type AlertIndicator = "MA" | "RSI" | "ATR" | "TRENDLINES";
```

Add to `ALERTABLE` after `ATR`:

```ts
  TRENDLINES: { lines: ["value"], priceTarget: true, params: [], config: {} },
```

```ts
export const MAIN_LINE_KEY: Record<AlertIndicator, string> = {
  MA: "ma", RSI: "val", ATR: "atr", TRENDLINES: "tl_nearest",
};
```

At the top of `indicatorLabel`:

```ts
  if (id.indicator === "TRENDLINES") return "Trendlines nearest";
```

- [ ] **Step 7: Parity case**

In `frontend/src/lib/alertableParity.test.ts`, import:

```ts
import { computeTrendlines } from "./indicators/trendlines";
import { canonicalTrendlinesParams, parseTrendlinesConfig } from "./indicators/trendlinesOutputs";
```

Append to `CASES` (before `] as const`):

```ts
  { indicator: "TRENDLINES", calcParams: canonicalTrendlinesParams([], {}), config: {} },
```

At the top of `series`:

```ts
  if (c.indicator === "TRENDLINES") {
    const pts = computeTrendlines(data, parseTrendlinesConfig(c.calcParams, {})).points;
    return pts.map((p) => (p as Record<string, number | undefined>).tl_nearest ?? null);
  }
```

(`series` reads `c.calcParams[0]` after this branch, unchanged.)

- [ ] **Step 8: Regenerate fixtures and run parity both sides**

Run: `cd frontend && UPDATE_PARITY=1 npx vitest run src/lib/alertableParity.test.ts && npx vitest run src/lib/alertableParity.test.ts src/lib/alertableIndicators.test.ts`
Expected: PASS.
Run: `cd backend && python3 -m pytest tests/test_indicator_parity.py tests/test_alertable.py tests/test_trendlines_indicator.py -q`
Expected: PASS (including `test_alertable_values_match_frontend[TRENDLINES-{}]`).

- [ ] **Step 9: Commit**

```bash
git add backend/auto_trader/indicators/trendlines.py backend/auto_trader/indicators/alertable.py \
  backend/tests/test_alertable.py backend/tests/fixtures/indicator_parity/alertable.json \
  backend/tests/fixtures/indicator_parity/values.json frontend/src/lib/indicators/trendlinesOutputs.ts \
  frontend/src/lib/alertableIndicators.ts frontend/src/lib/alertableParity.test.ts
git commit -m "feat(alerts): LINE and TRENDLINES in the alertable registry

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Hub readiness, TRENDLINES intrabar projection, `bars_after`

**Files:**
- Modify: `backend/auto_trader/core/alert_indicators.py` (`ready` `:315-320`, `values` `:322-342`, new `bars_after`)
- Test: `backend/tests/test_alert_indicators.py`

**Interfaces:**
- Consumes: `min_bars`, `sparse`, `line_key`, `TL_DEFAULT_PARAMS` (Task 1).
- Produces: `IndicatorHub.bars_after(key: SeriesKey, t_ms: int) -> int | None` (closed bars after the one opening at `t_ms`; None if absent). TRENDLINES intrabar `values` returns the closed dict with `value = value + slope` and makes no compute call.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_alert_indicators.py`:

```python
from auto_trader.indicators.alertable import line_key
from auto_trader.indicators.trendlines import TL_DEFAULT_PARAMS

TL = IndicatorKey("TRENDLINES", tuple(TL_DEFAULT_PARAMS), ())


def test_line_values_and_bars_after():
    async def main():
        now = [10 * H + 5]
        hub, _, _ = make([c(i * H, float(i)) for i in range(5, 10)], now)
        ln = line_key(8 * H, 100.0, 0.5)
        hub.set_needs({KEY: {ln}})
        await hub.on_sample("capital", "US100", Sample(now[0], 9.0, None, None))
        await asyncio.sleep(0)
        assert hub.values(KEY, ln, intrabar=False) == {"value": 100.5}
        assert hub.values(KEY, ln, intrabar=True) == {"value": 101.0}  # the forming 10h bar
        assert hub.bars_after(KEY, 8 * H) == 1
        assert hub.bars_after(KEY, 99 * H) is None
    asyncio.run(main())


def test_line_not_ready_when_tref_missing():
    async def main():
        now = [10 * H + 5]
        hub, _, _ = make([c(i * H, float(i)) for i in range(5, 10)], now)
        ln = line_key(2 * H, 100.0, 0.5)  # older than every bar the server holds
        hub.set_needs({KEY: {ln}})
        await hub.on_sample("capital", "US100", Sample(now[0], 9.0, None, None))
        await asyncio.sleep(0)
        assert not hub.ready(KEY, ln)
        assert hub.values(KEY, ln, intrabar=False) is None
    asyncio.run(main())


def _fake_tl(n):
    value = [None] * n
    slope = [None] * n
    value[-1], slope[-1] = 50.0, 0.25
    return {"value": value, "held": [None] * n, "slope": slope, "a1": [None] * n, "a2": [None] * n}


def test_trendlines_intrabar_projects_without_recompute(monkeypatch):
    calls = []
    real = alert_indicators_mod.compute

    def fake(ind, bars):
        if ind.indicator != "TRENDLINES":
            return real(ind, bars)
        calls.append(len(bars))
        return _fake_tl(len(bars))

    monkeypatch.setattr(alert_indicators_mod, "compute", fake)

    async def main():
        now = [60 * H + 5]
        hub, _, t = make([c(i * H, 1.0) for i in range(0, 60)], now)
        hub.set_needs({KEY: {TL}})
        await hub.on_sample("capital", "US100", Sample(now[0], 1.0, None, None))
        await asyncio.sleep(0)
        assert len(calls) == 1
        t[0] = 5.0
        assert hub.values(KEY, TL, intrabar=True)["value"] == 50.25
        assert len(calls) == 1  # no forming-bar recompute
    asyncio.run(main())


def test_trendlines_ready_with_no_line(monkeypatch):
    monkeypatch.setattr(alert_indicators_mod, "compute",
                        lambda ind, bars: {k: [None] * len(bars) for k in ("value", "held", "slope", "a1", "a2")})

    async def main():
        now = [60 * H + 5]
        hub, _, _ = make([c(i * H, 1.0) for i in range(0, 60)], now)
        hub.set_needs({KEY: {TL}})
        await hub.on_sample("capital", "US100", Sample(now[0], 1.0, None, None))
        await asyncio.sleep(0)
        assert hub.ready(KEY, TL)  # an empty pane is "ok", it just never fires
        assert hub.values(KEY, TL, intrabar=True)["value"] is None
    asyncio.run(main())
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && python3 -m pytest tests/test_alert_indicators.py -q`
Expected: FAIL (`AttributeError: 'IndicatorHub' object has no attribute 'bars_after'`, and the TRENDLINES ones on readiness/recompute).

- [ ] **Step 3: Implement**

In `backend/auto_trader/core/alert_indicators.py`, extend the import:

```python
from auto_trader.indicators.alertable import SEED_CAP, IndicatorKey, compute, min_bars, sparse, warmup
```

Replace `ready`:

```python
    def ready(self, key: SeriesKey, ind: IndicatorKey) -> bool:
        st = self._states.get(key)
        if st is None or not st.ok or len(st.series.closed) < min_bars(ind):
            return False
        vals = st.closed_vals.get(ind)
        if vals is None:
            return False
        # A sparse indicator (Trendlines with no line drawn) is still ready:
        # its alert has no level and simply does not fire.
        return sparse(ind) or all(v is not None for v in vals.values())
```

In `values`, right after `if not intrabar: return st.closed_vals[ind]`:

```python
        if ind.indicator == "TRENDLINES":
            # The held line (nearest at the last close) one bar on: a
            # projection, never a forming-bar recompute of the whole detector.
            closed = st.closed_vals[ind]
            v, s = closed.get("value"), closed.get("slope")
            return {**closed, "value": v + s if v is not None and s is not None else None}
```

After `forming_open_ms`, add:

```python
    def bars_after(self, key: SeriesKey, t_ms: int) -> int | None:
        """Closed bars after the one opening at `t_ms`, or None if that bar
        is not in the series (the `line` kind's rebase reads this)."""
        st = self._states.get(key)
        if st is None:
            return None
        for back, bar in enumerate(reversed(st.series.closed)):
            if candle_ms(bar) == t_ms:
                return back
        return None
```

- [ ] **Step 4: Run tests**

Run: `cd backend && python3 -m pytest tests/test_alert_indicators.py -q`
Expected: PASS (all old tests too).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/alert_indicators.py backend/tests/test_alert_indicators.py
git commit -m "feat(alerts): hub serves line and nearest-trendline needs

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Alert kinds: `resolve_close`, `level_sig`, `LineKind`, TRENDLINES rules

**Files:**
- Modify: `backend/auto_trader/core/alert_kinds.py`
- Test: `backend/tests/test_alert_kinds.py`

**Interfaces:**
- Consumes: `line_key`, `TRENDLINES_REFUSED_TF` (Task 1).
- Produces: protocol methods `resolve_close(params, last: Candle | None, before: Candle | None, vals, pvals) -> tuple[Pair | None, Pair | None]` and `level_sig(params, values) -> tuple | None` on every kind; `LINE = LineKind()`; `KINDS["line"]`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_alert_kinds.py` (and change `test_registry_has_both_kinds` to assert `{"price_level", "indicator", "line"}`):

```python
from datetime import datetime, timezone

from auto_trader.core.alert_kinds import LINE
from auto_trader.core.models import Candle
from auto_trader.indicators.trendlines import TL_DEFAULT_PARAMS


def bar(close):
    return Candle(datetime(2026, 1, 1, tzinfo=timezone.utc), close, close, close, close, 1.0)


def line_params(**kw):
    p = {"timeframe": "1H", "evalOn": "close", "condition": "crossing", "trigger": "every",
         "tRef": 36_000_000, "pRef": 100.0, "slope": 0.5,
         "anchors": {"t1": 7_200_000, "p1": 96.0, "t2": 21_600_000, "p2": 98.0},
         "link": {"scope": "s", "instanceId": "TRENDLINES", "lineKey": "7200000:21600000"}}
    p.update(kw)
    return p


def test_line_validate_and_resolve():
    p = line_params()
    LINE.validate(p, STREAMS)
    assert p["timeframe"] == "HOUR" and isinstance(p["tRef"], int)
    assert LINE.indicator_key(p).indicator == "LINE"
    assert LINE.resolve(p, 101.0, {"value": 100.5}) == (101.0, 100.5)
    assert LINE.resolve(p, 101.0, {"value": None}) is None
    assert LINE.label(p) == "Trendline (1H)"
    LINE.validate(line_params(link=None), STREAMS)


@pytest.mark.parametrize("override,msg", [
    ({"tRef": "x"}, "tRef"), ({"slope": float("nan")}, "slope"), ({"anchors": {"t1": 1}}, "anchors"),
    ({"timeframe": "HOUR_2"}, "timeframe"), ({"evalOn": "x"}, "evalOn"),
    ({"link": {"scope": "s", "instanceId": "T"}}, "lineKey"),
])
def test_line_validate_rejects(override, msg):
    with pytest.raises(ValueError, match=msg):
        LINE.validate(line_params(**override), STREAMS)


def test_line_sig_ignores_the_rolling_reference():
    p = line_params()
    LINE.validate(p, STREAMS)
    assert LINE.sig(p) == LINE.sig(dict(p, tRef=p["tRef"] + 3_600_000, pRef=101.0))
    assert LINE.sig(p) != LINE.sig(dict(p, condition="greater"))


def tl_params(**kw):
    return ind_params(indicator="TRENDLINES", calcParams=list(TL_DEFAULT_PARAMS), config={},
                      link={"scope": "s", "instanceId": "TRENDLINES"}, **kw)


def test_trendlines_close_pair_uses_the_held_line():
    p = tl_params()
    INDICATOR.validate(p, STREAMS)
    # Old line at 100 (prev bar) / 100.2 (this bar); the new nearest is 99.
    vals = {"value": 99.0, "held": 100.2, "slope": -0.1, "a1": 3.0, "a2": 4.0}
    pvals = {"value": 100.0, "held": 99.9, "slope": 0.2, "a1": 1.0, "a2": 2.0}
    cur, prev = INDICATOR.resolve_close(p, bar(99.5), bar(99.0), vals, pvals)
    assert cur == (99.5, 100.2) and prev == (99.0, 100.0)  # same line both bars: no cross
    assert INDICATOR.level_sig(p, vals) == (3.0, 4.0)
    assert INDICATOR.resolve(p, 99.5, {"value": None}) is None


def test_default_resolve_close_and_level_sig():
    p = ind_params()
    INDICATOR.validate(p, STREAMS)
    cur, prev = INDICATOR.resolve_close(p, bar(101.0), bar(99.0), {"value": 100.0}, {"value": 100.0})
    assert cur == (101.0, 100.0) and prev == (99.0, 100.0)
    assert INDICATOR.level_sig(p, {"value": 1.0}) is None
    assert INDICATOR.resolve_close(p, None, None, None, None) == (None, None)


def test_trendlines_refuses_value_target():
    with pytest.raises(ValueError, match="target"):
        INDICATOR.validate(tl_params(target="value", value=1.0), STREAMS)
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && python3 -m pytest tests/test_alert_kinds.py -q`
Expected: FAIL with `ImportError: cannot import name 'LINE'`.

- [ ] **Step 3: Implement**

In `backend/auto_trader/core/alert_kinds.py`:

Imports:

```python
from auto_trader.core.models import Candle
from auto_trader.indicators.alertable import (
    TRENDLINES_REFUSED_TF, IndicatorKey, indicator_label, line_key, validate_indicator, volume_weighted,
)
```

Protocol: add

```python
    def resolve_close(
        self, params: dict, last: Candle | None, before: Candle | None,
        vals: dict[str, float | None] | None, pvals: dict[str, float | None] | None,
    ) -> tuple[Pair | None, Pair | None]: ...
    def level_sig(self, params: dict, values: dict[str, float | None] | None) -> tuple | None: ...
```

Module helpers (after `_validate_common`):

```python
def _resolve_close_default(kind, params, last, before, vals, pvals):
    """Close mode's two pairs: this close vs this bar's level, and the
    previous close vs the previous bar's level."""
    cur = kind.resolve(params, last.close, vals) if last is not None and vals else None
    prev = kind.resolve(params, before.close, pvals) if before is not None and pvals else None
    return cur, prev


def _validate_series_params(params: dict) -> None:
    """Native timeframe (canonicalised) and evalOn: shared by the kinds that
    read closed bars."""
    tf = params.get("timeframe")
    try:
        canon = _tf.canonicalize(tf) if isinstance(tf, str) else None
    except _tf.TimeframeError:
        canon = None
    if canon is None or not _tf.is_native(canon):
        raise ValueError("params.timeframe must be a native timeframe (1m to 1W)")
    params["timeframe"] = canon
    if params.get("evalOn") not in _EVAL_ON:
        raise ValueError("params.evalOn must be 'close' or 'intrabar'")
```

`PriceLevelKind`: add

```python
    def resolve_close(self, params, last, before, vals, pvals):
        return _resolve_close_default(self, params, last, before, vals, pvals)

    def level_sig(self, params, values):
        return None
```

`IndicatorKind.validate`: replace its inline timeframe/evalOn block with `_validate_series_params(params)`, and after it add:

```python
        if params["indicator"] == "TRENDLINES" and params["timeframe"] in TRENDLINES_REFUSED_TF:
            raise ValueError("params.timeframe: nearest-line alerts need 5m or longer")
```

`IndicatorKind`: add

```python
    def resolve_close(self, params, last, before, vals, pvals):
        if params.get("indicator") != "TRENDLINES":
            return _resolve_close_default(self, params, last, before, vals, pvals)
        # The line nearest at the previous close, at both bars: `held` is it
        # projected to this bar, the previous `value` is it at its own bar.
        # A switch to another line is therefore never read as a cross.
        held = (vals or {}).get("held")
        was = (pvals or {}).get("value")
        cur = (last.close, held) if last is not None and held is not None and math.isfinite(held) else None
        prev = (before.close, was) if before is not None and was is not None and math.isfinite(was) else None
        return cur, prev

    def level_sig(self, params, values):
        if params.get("indicator") != "TRENDLINES" or not values:
            return None
        return (values.get("a1"), values.get("a2"))
```

New kind, before `PRICE_LEVEL = ...`:

```python
class LineKind:
    """A frozen straight line in bars of `timeframe` (a right-clicked
    trendline): level = pRef + slope * (bars since tRef). tRef/pRef roll
    forward (engine rebase), so they are not part of `sig`."""

    def validate(self, params: dict, streams: Callable[[], bool]) -> None:
        t_ref = params.get("tRef")
        if not _finite_number(t_ref) or t_ref <= 0 or t_ref != int(t_ref):
            raise ValueError("params.tRef must be a bar open time in ms")
        params["tRef"] = int(t_ref)
        for f in ("pRef", "slope"):
            if not _finite_number(params.get(f)):
                raise ValueError(f"params.{f} must be a finite number")
        a = params.get("anchors")
        if not isinstance(a, dict) or not all(_finite_number(a.get(k)) for k in ("t1", "p1", "t2", "p2")):
            raise ValueError("params.anchors must be {t1, p1, t2, p2} numbers")
        _validate_common(params)
        _validate_series_params(params)
        link = params.get("link")
        if link is not None and not (
            isinstance(link, dict)
            and isinstance(link.get("scope"), str) and 0 < len(link["scope"]) <= 200
            and isinstance(link.get("instanceId"), str) and 0 < len(link["instanceId"]) <= 64
            and isinstance(link.get("lineKey"), str) and 0 < len(link["lineKey"]) <= 64
        ):
            raise ValueError("params.link must be {scope, instanceId, lineKey} strings or null")

    def bar_resolution(self, params: dict) -> str:
        return params["timeframe"]

    def eval_on(self, params: dict) -> str:
        return params["evalOn"]

    def indicator_key(self, params: dict) -> IndicatorKey:
        return line_key(params["tRef"], params["pRef"], params["slope"])

    def resolve(self, params, price, values):
        level = (values or {}).get("value")
        if level is None or not math.isfinite(level):
            return None
        return (price, level)

    def resolve_close(self, params, last, before, vals, pvals):
        return _resolve_close_default(self, params, last, before, vals, pvals)

    def level_sig(self, params, values):
        return None

    def label(self, params: dict) -> str:
        return f"Trendline ({_tf.label(params['timeframe'])})"

    def sig(self, params: dict) -> str:
        keys = ("slope", "anchors", "timeframe", "evalOn", "condition", "trigger")
        return json.dumps({k: params.get(k) for k in keys}, sort_keys=True)

    def payload_extras(self, params: dict, pair: Pair) -> dict:
        return {"label": self.label(params), "target": "price", "subject": pair[0], "evalOn": params["evalOn"]}
```

Registry:

```python
PRICE_LEVEL = PriceLevelKind()
INDICATOR = IndicatorKind()
LINE = LineKind()
KINDS: dict[str, AlertKind] = {"price_level": PRICE_LEVEL, "indicator": INDICATOR, "line": LINE}
```

- [ ] **Step 4: Run tests**

Run: `cd backend && python3 -m pytest tests/test_alert_kinds.py tests/test_alertable.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/alert_kinds.py backend/tests/test_alert_kinds.py
git commit -m "feat(alerts): line alert kind and held-line close pairs

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Engine: `resolve_close`, held-line baseline reset, line rebase

**Files:**
- Modify: `backend/auto_trader/core/alert_engine.py` (`__init__` `:92-133`, `_forget` `:470-477`, `on_tick` `:735-741`, `_evaluate_one` `:769-797`, new `_maybe_rebase_line`)
- Test: `backend/tests/test_alert_engine.py`

**Interfaces:**
- Consumes: `kind.resolve_close`, `kind.level_sig` (Task 3), `IndicatorHub.bars_after` (Task 2), `AlertStore.update`.
- Produces: module constant `LINE_REBASE_BARS = 1000`; rebase writes `{"params": {"tRef", "pRef"}}` and broadcasts `__alerts__:changed`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_alert_engine.py`:

```python
import auto_trader.core.alert_engine as alert_engine_mod
import auto_trader.core.alert_indicators as alert_indicators_mod
from auto_trader.indicators.trendlines import TL_DEFAULT_PARAMS


def line_row(id="al-l", **params):
    p = {"timeframe": "HOUR", "evalOn": "close", "condition": "crossing_up", "trigger": "every",
         "tRef": 9 * H, "pRef": 9.5, "slope": 0.5,
         "anchors": {"t1": 6 * H, "p1": 8.0, "t2": 8 * H, "p2": 9.0},
         "link": {"scope": "s", "instanceId": "TRENDLINES", "lineKey": "k"}}
    p.update(params)
    return {**row(id=id), "kind": "line", "params": p}


def test_line_close_mode_fires_on_the_projected_level(tmp_path):
    async def main():
        bars = [hourly([10, 10, 10, 9], 6)]  # line 9.5 at 9h, close 9 below
        eng, store, sent = make_ind_engine(tmp_path, bars)
        created = await store.create("u1", line_row())
        eng.on_alert_changed("u1", created, "al-l")
        await eng.on_tick("capital", "US100", 12.0, None, None, t_ms=10 * H + 5)
        await asyncio.sleep(0)
        bars[0] = hourly([10, 10, 10, 9, 12], 6)  # 10h closes at 12 > 10.0
        await eng.on_tick("capital", "US100", 12.0, None, None, t_ms=11 * H + 5)
        fired = [m["value"] for _, m in sent if m["key"] == "__alerts__:fired"]
        assert len(fired) == 1
        assert fired[0]["level"] == pytest.approx(10.0) and fired[0]["label"] == "Trendline (1H)"
    asyncio.run(main())


def test_line_rebase_moves_the_reference_and_keeps_last_fired(tmp_path, monkeypatch):
    monkeypatch.setattr(alert_engine_mod, "LINE_REBASE_BARS", 2)

    async def main():
        bars = [hourly([10, 10, 10, 9], 6)]
        eng, store, sent = make_ind_engine(tmp_path, bars)
        created = await store.create("u1", line_row(tRef=7 * H, pRef=8.5))
        eng.on_alert_changed("u1", created, "al-l")
        await eng.on_tick("capital", "US100", 9.0, None, None, t_ms=10 * H + 5)
        await asyncio.sleep(0)
        eng._last_fired_bar[("u1", "al-l")] = 123
        bars[0] = hourly([10, 10, 10, 9, 9], 6)  # 10h closes: 3 bars after 7h
        await eng.on_tick("capital", "US100", 9.0, None, None, t_ms=11 * H + 5)
        saved = (await store.list_user("u1"))[0]["params"]
        assert saved["tRef"] == 10 * H and saved["pRef"] == pytest.approx(8.5 + 0.5 * 3)
        assert eng._last_fired_bar[("u1", "al-l")] == 123
        assert any(m["key"] == "__alerts__:changed" for _, m in sent)
    asyncio.run(main())


def tl_row(id="al-t", **params):
    return ind_row(id=id, indicator="TRENDLINES", calcParams=list(TL_DEFAULT_PARAMS), config={},
                   link={"scope": "s", "instanceId": "TRENDLINES"}, **params)


def _patch_tl(monkeypatch, last_value, held):
    real = alert_indicators_mod.compute

    def fake(ind, bars):
        if ind.indicator != "TRENDLINES":
            return real(ind, bars)
        n = len(bars)
        out = {k: [None] * n for k in ("value", "held", "slope", "a1", "a2")}
        out["value"][-2], out["value"][-1] = 100.0, last_value
        out["held"][-1] = held
        out["slope"][-1], out["a1"][-1], out["a2"][-1] = -0.1, 3.0, 4.0
        return out

    monkeypatch.setattr(alert_indicators_mod, "compute", fake)


def _sixty(last):
    return hourly([100.0] * 58 + [99.0] + ([last] if last is not None else []), 0)


def test_trendlines_switch_without_cross_does_not_fire(tmp_path, monkeypatch):
    _patch_tl(monkeypatch, last_value=99.0, held=100.2)

    async def main():
        bars = [_sixty(None)]
        eng, store, sent = make_ind_engine(tmp_path, bars)
        created = await store.create("u1", tl_row())
        eng.on_alert_changed("u1", created, "al-t")
        await eng.on_tick("capital", "US100", 99.0, None, None, t_ms=59 * H + 5)
        await asyncio.sleep(0)
        bars[0] = _sixty(99.5)  # below the old line (100.2), above the new one (99.0)
        await eng.on_tick("capital", "US100", 99.5, None, None, t_ms=60 * H + 5)
        assert not [m for _, m in sent if m["key"] == "__alerts__:fired"]
    asyncio.run(main())


def test_trendlines_cross_of_the_held_line_fires(tmp_path, monkeypatch):
    _patch_tl(monkeypatch, last_value=99.0, held=100.2)

    async def main():
        bars = [_sixty(None)]
        eng, store, sent = make_ind_engine(tmp_path, bars)
        created = await store.create("u1", tl_row())
        eng.on_alert_changed("u1", created, "al-t")
        await eng.on_tick("capital", "US100", 99.0, None, None, t_ms=59 * H + 5)
        await asyncio.sleep(0)
        bars[0] = _sixty(100.5)
        await eng.on_tick("capital", "US100", 100.5, None, None, t_ms=60 * H + 5)
        fired = [m["value"] for _, m in sent if m["key"] == "__alerts__:fired"]
        assert len(fired) == 1 and fired[0]["level"] == pytest.approx(100.2)
    asyncio.run(main())


def test_trendlines_intrabar_baseline_resets_on_a_held_line_switch(tmp_path, monkeypatch):
    async def main():
        eng, store, _ = make_engine(tmp_path)
        state = ("u1", "al-t")
        eng._baseline[state] = (99.0, 100.0)
        eng._level_sig[state] = (1.0, 2.0)
        assert eng._reset_on_level_switch(state, (3.0, 4.0)) is True
        assert eng._baseline[state] is None
        assert eng._reset_on_level_switch(state, (3.0, 4.0)) is False
    asyncio.run(main())
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && python3 -m pytest tests/test_alert_engine.py -q`
Expected: FAIL (`AttributeError: ... LINE_REBASE_BARS`, `_level_sig`, `_reset_on_level_switch`; the line test fails because `line` rows never resolve close pairs through `resolve_close` until wired).

- [ ] **Step 3: Implement**

In `backend/auto_trader/core/alert_engine.py`:

Near the other module constants:

```python
# A `line` alert's reference bar rolls forward once it is this many bars
# behind the newest close, so it never leaves the 2000-bar seed.
LINE_REBASE_BARS = 1000
```

Import `candle_ms` from `auto_trader.core.alert_bars` (add to the existing alert_bars import, or a new line).

`__init__`, after `self._sig`:

```python
        # Held-line signature per alert (nearest-trendline alerts): a change
        # at a close drops the intrabar baseline so a switch is never a cross.
        self._level_sig: dict[tuple[str, str], tuple | None] = {}
```

`_forget`: add `self._level_sig.pop(state_key, None)`.

`start()` (`alert_engine.py:172-176`): add `self._level_sig.clear()` beside `self._baseline.clear()`, so a restart never keeps a stale held-line signature.

New method next to `_forget`:

```python
    def _reset_on_level_switch(self, state_key: tuple[str, str], sig: tuple | None) -> bool:
        """Drop the intrabar baseline when the watched line changed."""
        if sig == self._level_sig.get(state_key):
            return False
        self._level_sig[state_key] = sig
        self._baseline[state_key] = None
        return True
```

In `_evaluate_one`, close branch: replace the two `kind.resolve(...)` lines (`cur = ...`, `prev = ...`) with:

```python
            cur, prev = kind.resolve_close(params, last, before, vals, pvals)
```

Intrabar branch: after the `if vals is None: ... return` block (inside `if ind is not None:`), add:

```python
                self._reset_on_level_switch(state_key, kind.level_sig(params, vals))
```

In `on_tick`, inside the per-row `try`, after `await self._evaluate_one(...)`:

```python
                await self._maybe_rebase_line(user_id, row, closed)
```

New method after `_evaluate_one`:

```python
    async def _maybe_rebase_line(self, user_id: str, row: dict, closed: set[SeriesKey]) -> None:
        """Roll a `line` alert's reference bar forward once it is more than
        LINE_REBASE_BARS behind the newest close: one multiply from the
        stored reference, persisted, then the hub need swapped in place.
        sig excludes tRef/pRef, so baseline and last-fired bar survive."""
        if row.get("kind") != "line" or self._hub is None or not row.get("active", 1):
            return
        kind = kind_of(row)
        if kind is None:
            return
        skey = self._series_key(user_id, row, kind)
        if skey not in closed:
            return
        p = row["params"]
        n = self._hub.bars_after(skey, int(p["tRef"]))
        last = self._hub.last_closed(skey)
        if n is None or n <= LINE_REBASE_BARS or last is None:
            return
        assert self._store is not None and self._broadcast is not None
        patch = {"tRef": candle_ms(last), "pRef": p["pRef"] + p["slope"] * n}
        saved = await self._store.update(user_id, row["id"], {"params": patch})
        if saved is None:
            return
        row["params"] = saved["params"]  # the registry holds this same dict
        self._safe_sync_needs()
        await self._broadcast(user_id, {
            "key": "__alerts__:changed",
            "value": {"broker": row["broker"], "epic": row["epic"], "origin": "engine"},
        })
```

- [ ] **Step 4: Run tests**

Run: `cd backend && python3 -m pytest tests/test_alert_engine.py tests/test_alert_engine_feeds.py tests/test_telegram_rich_alerts.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/alert_engine.py backend/tests/test_alert_engine.py
git commit -m "feat(alerts): engine evaluates line and nearest-trendline alerts

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Router: line reference check on create, status for line rows

**Files:**
- Modify: `backend/auto_trader/api/routers/alerts.py` (imports, `list_alerts` `:131`, `create_alert` `:139-145`)
- Test: `backend/tests/test_alerts_api.py`

**Interfaces:**
- Consumes: `deps.load_alert_bars(broker, epic, resolution, side, count) -> (list[Candle], bool)`, `candle_ms`.
- Produces: `POST /api/alerts` with `kind: "line"`: 422 "Chart and server bars disagree; reload the chart" when `tRef` is not a bar open time the server holds; 503 "Couldn't load bars to check this line; try again" on a failed load.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_alerts_api.py`:

```python
from datetime import datetime, timezone

import auto_trader.api.deps as deps_mod
from auto_trader.core.models import Candle

H = 3_600_000


def _line_body(**kw):
    p = {"timeframe": "HOUR", "evalOn": "close", "condition": "crossing", "trigger": "every",
         "tRef": 9 * H, "pRef": 100.0, "slope": 0.5,
         "anchors": {"t1": 2 * H, "p1": 96.0, "t2": 6 * H, "p2": 98.0},
         "link": {"scope": "s", "instanceId": "TRENDLINES", "lineKey": "7200000:21600000"}}
    p.update(kw)
    return _body(id="al-line", kind="line", params=p)


@pytest.fixture
def bars(monkeypatch):
    state = {"bars": [Candle(datetime.fromtimestamp(h * 3600, tz=timezone.utc), 1, 1, 1, 1, 1.0)
                      for h in range(5, 11)], "degraded": False}

    async def fake(broker, epic, res, side, count):
        return state["bars"], state["degraded"]

    monkeypatch.setattr(deps_mod, "load_alert_bars", fake)
    return state


def test_line_create_round_trip(clerk, bars):
    r = client.post("/api/alerts", json=_line_body(), headers=_auth("alice"))
    assert r.status_code == 200, r.text
    assert r.json()["params"]["tRef"] == 9 * H


def test_line_create_with_unknown_reference_422(clerk, bars):
    r = client.post("/api/alerts", json=_line_body(tRef=3 * H), headers=_auth("alice"))
    assert r.status_code == 422 and "reload the chart" in r.json()["detail"]


def test_line_create_when_bars_fail_503(clerk, bars):
    bars["degraded"] = True
    r = client.post("/api/alerts", json=_line_body(), headers=_auth("alice"))
    assert r.status_code == 503


def test_line_patch_keeps_the_server_reference(clerk, bars):
    client.post("/api/alerts", json=_line_body(), headers=_auth("alice"))
    r = client.patch("/api/alerts/al-line", json={"params": {"condition": "greater"}}, headers=_auth("alice"))
    assert r.status_code == 200
    assert r.json()["params"]["tRef"] == 9 * H and r.json()["params"]["condition"] == "greater"


def test_line_rows_report_a_status(clerk, bars):
    client.post("/api/alerts", json=_line_body(), headers=_auth("alice"))
    rows = client.get("/api/alerts", headers=_auth("alice")).json()["alerts"]
    assert rows[0]["status"] in ("ok", "waiting_for_data")
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && python3 -m pytest tests/test_alerts_api.py -q`
Expected: the 422/503 tests FAIL (no reference check yet); `test_line_rows_report_a_status` FAILS (no status key).

- [ ] **Step 3: Implement**

In `backend/auto_trader/api/routers/alerts.py`:

```python
from auto_trader.core.alert_bars import candle_ms

from .. import deps
from ..deps import current_user
```

Add after `_validate_params`:

```python
async def _check_line_ref(broker: str, epic: str, params: dict[str, Any]) -> None:
    """A `line` alert's reference bar must be one the server holds (closed or
    forming): chart and server bars can disagree (offset grids, lag), and a
    guessed bar would put the alert on the wrong level."""
    try:
        bars, degraded = await deps.load_alert_bars(broker, epic, params["timeframe"], "mid", 10)
    except Exception:
        bars, degraded = [], True
    if degraded or not bars:
        raise HTTPException(503, "Couldn't load bars to check this line; try again")
    if params["tRef"] not in {candle_ms(b) for b in bars}:
        raise HTTPException(422, "Chart and server bars disagree; reload the chart")
```

In `create_alert`, after `_validate_expires_at(body.expires_at)`:

```python
    if body.kind == "line":
        await _check_line_ref(body.broker, body.epic, body.params)
```

In `list_alerts`, change the status default to cover both server-evaluated kinds:

```python
        if st is None and r.get("kind") in ("indicator", "line"):
```

- [ ] **Step 4: Run tests**

Run: `cd backend && python3 -m pytest tests/test_alerts_api.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/routers/alerts.py backend/tests/test_alerts_api.py
git commit -m "feat(alerts): check a line alert's reference bar on create

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Frontend nearest-line: `checkAlertable` TRENDLINES, price-only dialog

**Files:**
- Modify: `frontend/src/lib/alertableIndicators.ts`
- Modify: `frontend/src/IndicatorAlertModal.tsx`
- Test: `frontend/src/lib/alertableIndicators.test.ts`, `frontend/src/chart/indicatorAlertDraft.test.ts`

**Interfaces:**
- Consumes: `canonicalTrendlinesParams` (Task 1).
- Produces: `checkAlertable("TRENDLINES", ...)` returns `{ ok: true, identity: { indicator: "TRENDLINES", calcParams: <33 numbers>, config: {}, priceTarget: true } }` or a reason; `TRENDLINES_REFUSED_TF: ReadonlySet<string>`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/alertableIndicators.test.ts` (inside the `describe`), and import `canonicalTrendlinesParams` from `"./indicators/trendlinesOutputs"`:

```ts
  it("TRENDLINES alerts on the canonical settings, price only, following its pin", () => {
    const r = checkAlertable("TRENDLINES", [7], {}, "HOUR", true);
    expect(r.ok && r.identity).toEqual({
      indicator: "TRENDLINES", calcParams: canonicalTrendlinesParams([7], {}), config: {}, priceTarget: true,
    });
    expect(r.ok && r.identity.calcParams).toHaveLength(33);
    // A legacy extendData migration lands in the canonical array.
    const legacy = checkAlertable("TRENDLINES", [], { declutter: "pivot" }, "HOUR", true);
    expect(legacy.ok && legacy.identity.calcParams[22]).toBe(1);
    const pinned = checkAlertable("TRENDLINES", [], { mtf: { timeframe: "1D" } }, "HOUR", true);
    expect(!pinned.ok && "reason" in pinned && pinned.reason).toContain("pinned timeframe");
    expect(checkAlertable("TRENDLINES", [], { mtf: { timeframe: "1D" } }, "DAY", true).ok).toBe(true);
    const odd = checkAlertable("TRENDLINES", [], {}, "HOUR_2", true);
    expect(!odd.ok && "reason" in odd && odd.reason).toBe("Alerts on this timeframe are coming later");
    expect(indicatorAlertLabel((r as { identity: IndicatorIdentity }).identity, "HOUR")).toBe("Trendlines nearest (1H)");
  });
```

(Import `type IndicatorIdentity` from `"./alertableIndicators"`.)

Append to `frontend/src/chart/indicatorAlertDraft.test.ts`:

```ts
  it("a Trendlines pane drafts a nearest-line alert from tl_nearest", () => {
    const ind = { name: "TRENDLINES", calcParams: [], extendData: {}, result: [{ tl_nearest: 101.5 }] };
    const r = buildIndicatorAlertDraft({ ...args(chartWith(ind)), name: "TRENDLINES", paneId: "candle_pane" });
    expect(r && "draft" in r && r.draft).toMatchObject({
      lastValue: 101.5, timeframe: "HOUR", identity: { indicator: "TRENDLINES", config: {}, priceTarget: true },
    });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run src/lib/alertableIndicators.test.ts src/chart/indicatorAlertDraft.test.ts`
Expected: FAIL (TRENDLINES is hidden).

- [ ] **Step 3: Implement**

In `frontend/src/lib/alertableIndicators.ts`, import `canonicalTrendlinesParams` from `"./indicators/trendlinesOutputs"` and add after `MAIN_LINE_KEY`:

```ts
// Mirrors TRENDLINES_REFUSED_TF in alertable.py (plan Task 0's timing).
export const TRENDLINES_REFUSED_TF: ReadonlySet<string> = new Set<string>();
```

In `checkAlertable`, right before `if (type === "EMA" || type === "MA") {`:

```ts
  if (type === "TRENDLINES") {
    // The pane's lines are found on its pin's bars, so the alert lives there.
    const pin = tryCanonicalTf((e.mtf as { timeframe?: string } | undefined)?.timeframe ?? "");
    if (pin && pin !== tryCanonicalTf(resolution)) {
      return { ok: false, reason: "Alerts follow the line's pinned timeframe" };
    }
    if (!isNativeTf(resolution)) return { ok: false, reason: "Alerts on this timeframe are coming later" };
    if (TRENDLINES_REFUSED_TF.has(resolution)) return { ok: false, reason: "Nearest-line alerts need 5m or longer" };
    return {
      ok: true,
      identity: { indicator: "TRENDLINES", calcParams: canonicalTrendlinesParams(calcParams, e), config: {}, priceTarget: true },
    };
  }
```

Check `tryCanonicalTf("")` returns null/undefined (falsy) in `lib/timeframe.ts`; if it throws, guard with `mtfTf ? tryCanonicalTf(mtfTf) : null`.

In `frontend/src/IndicatorAlertModal.tsx`, in `Body`:

```tsx
  // Nearest-line alerts compare price with the line only.
  const priceOnly = base.identity.indicator === "TRENDLINES";
```

Change the radio guard to `{base.identity.priceTarget && !priceOnly && (`, and right after the "Indicator" field add:

```tsx
        {priceOnly && (
          <div className="al-field">
            <span>History</span>
            <span>Uses the last 2000 bars</span>
          </div>
        )}
```

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/lib/alertableIndicators.test.ts src/chart/indicatorAlertDraft.test.ts src/lib/indicatorAlertSync.test.ts src/lib/alertableParity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/alertableIndicators.ts frontend/src/lib/alertableIndicators.test.ts \
  frontend/src/chart/indicatorAlertDraft.test.ts frontend/src/IndicatorAlertModal.tsx
git commit -m "feat(alerts): nearest-trendline alerts from the Trendlines pane

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Frontend: `alertLine` on the drawn segment and the line-alert draft

**Files:**
- Modify: `frontend/src/lib/indicators/trendlineMarks.ts` (`TrendlineSegment`, new `TrendlineAlertLine`, `alertLineOf`)
- Modify: `frontend/src/lib/indicators/trendlines.ts` (segment push at `:3723-3735`)
- Create: `frontend/src/chart/lineAlertDraft.ts`
- Modify: `frontend/src/lib/signals.ts` (`LineAlertDraft`, `LineAlertRequest`, `lineAlertRequest`)
- Test: `frontend/src/lib/indicators/trendlineMarks.test.ts`, `frontend/src/chart/lineAlertDraft.test.ts`

**Interfaces:**
- Produces: `interface TrendlineAlertLine { slope; tRef; pRef; t1; p1; t2; p2 }` (numbers); `alertLineOf(line: {i1; p1; i2; p2}, times: readonly number[], refIdx: number): TrendlineAlertLine | null`; `TrendlineSegment.alertLine?: () => TrendlineAlertLine | null`; `buildLineAlertDraft(args): { draft: LineAlertDraft } | { reason: string } | null`; signals `LineAlertDraft { epic; broker; precision; timeframe; line: TrendlineAlertLine; link: { scope; instanceId; lineKey } }`, `LineAlertRequest = { mode: "create"; draft } | { mode: "edit"; id }`, `lineAlertRequest: Signal<LineAlertRequest | null>`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/indicators/trendlineMarks.test.ts` (import `alertLineOf`):

```ts
describe("alertLineOf", () => {
  const line = { i1: 2, p1: 10, i2: 6, p2: 12 };
  it("projects to the reference bar in the line's own series", () => {
    const times = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => 1_000 + i * 3_600_000);
    expect(alertLineOf(line, times, 8)).toEqual({
      slope: 0.5, tRef: times[8], pRef: 13, t1: times[2], p1: 10, t2: times[6], p2: 12,
    });
  });
  it("a pinned line uses its HTF bar times, so the slope is per HTF bar", () => {
    const day = 86_400_000;
    const starts = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => i * day);
    const r = alertLineOf(line, starts, 7);
    expect(r?.slope).toBe(0.5);
    expect(r?.tRef).toBe(7 * day);
  });
  it("null before the second anchor or off the series", () => {
    const times = [0, 1, 2, 3, 4, 5, 6];
    expect(alertLineOf(line, times, 5)).toBeNull();
    expect(alertLineOf(line, times, 9)).toBeNull();
  });
});
```

Create `frontend/src/chart/lineAlertDraft.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildLineAlertDraft } from "./lineAlertDraft";

const line = { slope: 0.5, tRef: 9, pRef: 13, t1: 2, p1: 10, t2: 6, p2: 12 };
const seg = (alertLine?: () => typeof line | null) => ({
  key: "2:6", x0: 0, y0: 0, x1: 1, y1: 1, clone: () => null, alertLine,
});
const base = { scope: "tab.t1.cell.c2", instanceId: "TRENDLINES", epic: "US100", broker: "b", precision: 2 };

describe("buildLineAlertDraft", () => {
  it("drafts on the chart timeframe with the segment's line", () => {
    const r = buildLineAlertDraft({ ...base, seg: seg(() => line), ext: {}, resolution: "HOUR" });
    expect(r && "draft" in r && r.draft).toEqual({
      epic: "US100", broker: "b", precision: 2, timeframe: "HOUR", line,
      link: { scope: "tab.t1.cell.c2", instanceId: "TRENDLINES", lineKey: "2:6" },
    });
  });
  it("a pinned pane drafts on its pin", () => {
    const r = buildLineAlertDraft({ ...base, seg: seg(() => line), ext: { mtf: { timeframe: "1D" } }, resolution: "HOUR" });
    expect(r && "draft" in r && r.draft.timeframe).toBe("DAY");
  });
  it("reasons and hiding", () => {
    expect(buildLineAlertDraft({ ...base, seg: seg(() => line), ext: {}, resolution: "HOUR_2" }))
      .toEqual({ reason: "Alerts on this timeframe are coming later" });
    expect(buildLineAlertDraft({ ...base, seg: seg(() => null), ext: {}, resolution: "HOUR" }))
      .toEqual({ reason: "This line can't take an alert yet" });
    expect(buildLineAlertDraft({ ...base, seg: seg(), ext: {}, resolution: "HOUR" }))
      .toEqual({ reason: "This line can't take an alert yet" });
    expect(buildLineAlertDraft({ ...base, seg: seg(() => line), ext: {}, resolution: "SECOND_5" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlineMarks.test.ts src/chart/lineAlertDraft.test.ts`
Expected: FAIL (`alertLineOf` not exported; module `./lineAlertDraft` missing).

- [ ] **Step 3: Implement**

In `frontend/src/lib/indicators/trendlineMarks.ts`, add the field to `TrendlineSegment` (after `clone`):

```ts
  /** The line as an alert sees it, in the indicator's OWN bars (the pin's
   * under a timeframe pin). Absent on debug-layer lines. */
  alertLine?: () => TrendlineAlertLine | null;
```

And below the interface:

```ts
export interface TrendlineAlertLine {
  /** Price per bar of the line's own series. */
  slope: number;
  /** Open time of the reference bar (newest closed) and the line there. */
  tRef: number;
  pRef: number;
  /** Anchors as bar open times, for drawing. */
  t1: number;
  p1: number;
  t2: number;
  p2: number;
}

/** A drawn line frozen for an alert. `times` are the bar open times its
 * indices live in (chart bars, or HTF starts under a pin); `refIdx` the
 * newest closed bar there. Null before the second anchor or off the series.
 * Same arithmetic as trendlines.ts projectAt (not imported: that module
 * imports this one). */
export function alertLineOf(
  line: { i1: number; p1: number; i2: number; p2: number },
  times: readonly number[],
  refIdx: number,
): TrendlineAlertLine | null {
  const t1 = times[line.i1];
  const t2 = times[line.i2];
  const tRef = times[refIdx];
  if (t1 == null || t2 == null || tRef == null || line.i2 <= line.i1 || refIdx < line.i2) return null;
  const pRef = line.p1 + ((line.p2 - line.p1) * (refIdx - line.i1)) / (line.i2 - line.i1);
  return { slope: (line.p2 - line.p1) / (line.i2 - line.i1), tRef, pRef, t1, p1: line.p1, t2, p2: line.p2 };
}
```

In `frontend/src/lib/indicators/trendlines.ts`, import `alertLineOf` from `"./trendlineMarks"` (same import block as `setTrendlineSegments`), and in `segments.push({...})` after `clone: ...,` add:

```ts
        // Unpinned, the chart's newest bar is forming, so the reference is
        // the one before it; under a pin lastIdx is already the newest
        // CLOSED HTF bar (calc applied the closed-bar rule).
        alertLine: () =>
          alertLineOf(
            line,
            starts ?? (timestamps ??= dataList.map((d) => d.timestamp)),
            mtf ? lastIdx : lastIdx - 1,
          ),
```

In `frontend/src/lib/signals.ts`, add `import type { TrendlineAlertLine } from "./indicators/trendlineMarks";` and after `indicatorAlertRequest`:

```ts
export interface LineAlertDraft {
  epic: string;
  broker: string;
  precision: number;
  timeframe: string;
  line: TrendlineAlertLine;
  link: { scope: string; instanceId: string; lineKey: string };
}
export type LineAlertRequest = { mode: "create"; draft: LineAlertDraft } | { mode: "edit"; id: string };
export const lineAlertRequest = new Signal<LineAlertRequest | null>(null);
```

Create `frontend/src/chart/lineAlertDraft.ts`:

```ts
// Turns a right-clicked trendline into a line-alert draft (or the reason it
// cannot have one). The menu entry in useTrendlineMenu reads this.
import { alertTimeframeOf } from "../lib/alertableIndicators";
import { isNativeTf, parseTf } from "../lib/timeframe";
import type { TrendlineSegment } from "../lib/indicators/trendlineMarks";
import type { LineAlertDraft } from "../lib/signals";

/** null = hide the entry (a seconds chart). */
export function buildLineAlertDraft(args: {
  seg: TrendlineSegment; ext: Record<string, unknown> | undefined; resolution: string;
  scope: string; instanceId: string; epic: string; broker: string; precision: number;
}): { draft: LineAlertDraft } | { reason: string } | null {
  // A pinned pane's lines live on the pin's bars, whatever the chart shows.
  const timeframe = alertTimeframeOf(args.ext, args.resolution);
  try {
    if (parseTf(timeframe).unit === "SECOND") return null;
  } catch {
    return null;
  }
  if (!isNativeTf(timeframe)) return { reason: "Alerts on this timeframe are coming later" };
  const line = args.seg.alertLine?.() ?? null;
  if (!line) return { reason: "This line can't take an alert yet" };
  return {
    draft: {
      epic: args.epic, broker: args.broker, precision: args.precision, timeframe, line,
      link: { scope: args.scope, instanceId: args.instanceId, lineKey: args.seg.key },
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlineMarks.test.ts src/chart/lineAlertDraft.test.ts src/lib/indicators/trendlines.test.ts src/lib/indicators/trendlinesMtf.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/trendlineMarks.ts frontend/src/lib/indicators/trendlineMarks.test.ts \
  frontend/src/lib/indicators/trendlines.ts frontend/src/chart/lineAlertDraft.ts \
  frontend/src/chart/lineAlertDraft.test.ts frontend/src/lib/signals.ts
git commit -m "feat(alerts): freeze a drawn trendline into a line-alert draft

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Frontend alertsApi: the `line` kind in the server-alert cache

**Files:**
- Modify: `frontend/src/lib/alertsApi.ts`
- Create: `frontend/src/lib/alertEdit.ts`
- Modify: `frontend/src/AlertsSidebar.tsx` (`IndicatorAlertRow` `:145-200`, `sortIndicator` `:384`, `liveInd` `:395`, `indByEpic` `:438-444`)
- Modify: `frontend/src/mobile/MobileAlertsView.tsx` (`:59-72`, `:138-143`)
- Test: `frontend/src/lib/alertsApi.test.ts`

**Interfaces:**
- Consumes: `LineAlertDraft`, `lineAlertRequest` (Task 7).
- Produces (alertsApi): `LineAlertParams`, `LineAlert` (`kind: "line"`), `ServerAlert = IndicatorAlert | LineAlert`, `AnyAlert = SavedAlert | IndicatorAlert | LineAlert`; `loadLineAlerts(epic, broker?)`, `loadServerAlerts(epic, broker?)`, `loadAllServerAlerts(broker?)`, `findServerAlert(id)`, `linkedLineAlerts(scope, instanceId)`, `scopeLinkedLineAlerts(scope, broker?)`, `addLineAlert(a: LineAlert): Promise<boolean>`, `patchLineAlert(id, patch): Promise<boolean>`, `lineAlertLabel(timeframe): string`. `deleteIndicatorAlert(id)` deletes either kind. Indicator-only readers (`loadIndicatorAlerts`, `loadAllIndicatorAlerts`, `linkedAlerts`, `scopeLinkedAlerts`) keep returning `IndicatorAlert` only.
- Produces (alertEdit): `requestAlertEdit(id: string): void`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/alertsApi.test.ts` (extend the import list with `addLineAlert, patchLineAlert, loadLineAlerts, loadServerAlerts, linkedLineAlerts, type LineAlert`):

```ts
function lineRow(broker: string, overrides: Record<string, unknown> = {}) {
  return alertRow({
    id: "al-line", broker, kind: "line",
    params: {
      timeframe: "HOUR", evalOn: "close", condition: "crossing", trigger: "every",
      tRef: 9, pRef: 13, slope: 0.5, anchors: { t1: 2, p1: 10, t2: 6, p2: 12 },
      link: { scope: "tab.t1.cell.c2", instanceId: "TRENDLINES", lineKey: "2:6" },
    },
    ...overrides,
  });
}

describe("line alerts", () => {
  it("hydrate keeps line alerts apart from indicator and price alerts", async () => {
    const broker = freshBroker();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(String(input).includes("triggered")
        ? jsonResponse({ entries: [], seen: 0 })
        : jsonResponse({ alerts: [alertRow({ broker }), indRow(broker), lineRow(broker)] }))));
    await hydrateAlerts();
    expect(loadIndicatorAlerts("US100", broker).map((a) => a.id)).toEqual(["al-ind"]);
    expect(loadLineAlerts("US100", broker).map((a) => a.id)).toEqual(["al-line"]);
    expect(loadServerAlerts("US100", broker).map((a) => a.id).sort()).toEqual(["al-ind", "al-line"]);
    expect(linkedLineAlerts("tab.t1.cell.c2", "TRENDLINES").map((a) => a.id)).toEqual(["al-line"]);
    const line = loadLineAlerts("US100", broker)[0];
    expect(alertLabel(line, 2)).toBe("Crossing Trendline (1H)");
  });

  it("addLineAlert posts the line wire shape; patchLineAlert sends only what may change", async () => {
    const broker = freshBroker();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    const a: LineAlert = {
      kind: "line", id: "al-l2", epic: "US100", broker, condition: "crossing", trigger: "once",
      message: "", expiresAt: null, notify: { toast: true, browser: true, sound: true, push: true, telegram: true },
      precision: 2, params: {
        timeframe: "HOUR", evalOn: "close", tRef: 9, pRef: 13, slope: 0.5,
        anchors: { t1: 2, p1: 10, t2: 6, p2: 12 }, link: { scope: "s", instanceId: "TRENDLINES", lineKey: "2:6" } },
    };
    expect(await addLineAlert(a)).toBe(true);
    const post = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(post.kind).toBe("line");
    expect(post.params).toMatchObject({ tRef: 9, slope: 0.5, condition: "crossing", trigger: "once" });
    expect(await patchLineAlert("al-l2", { condition: "greater", params: { evalOn: "intrabar" } })).toBe(true);
    const patch = JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    expect(patch.params).toEqual({ evalOn: "intrabar", condition: "greater", trigger: "once" });
  });
});
```

(`conditionPhrase(label, condition, "price", "")` at `alertsApi.ts:800-809` joins `[CONDITION_LABELS[condition], label]`, and `CONDITION_LABELS.crossing` is "Crossing", hence "Crossing Trendline (1H)".)

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run src/lib/alertsApi.test.ts`
Expected: FAIL (missing exports).

- [ ] **Step 3: Implement alertsApi**

In `frontend/src/lib/alertsApi.ts`, import `tfLabel` from `"./timeframe"`. Add after `IndicatorAlert`:

```ts
export interface LineAlertParams {
  timeframe: string;
  evalOn: EvalOn;
  /** Reference bar open time and the line there; the server rolls these
   * forward, the client never sends them after create. */
  tRef: number;
  pRef: number;
  /** Price per bar of `timeframe`. */
  slope: number;
  anchors: { t1: number; p1: number; t2: number; p2: number };
  link: { scope: string; instanceId: string; lineKey: string } | null;
}

/** A frozen trendline (right-click "Add alert" on a Trendlines line). */
export interface LineAlert extends Omit<IndicatorAlert, "kind" | "params"> {
  kind: "line";
  params: LineAlertParams;
}

/** Server-evaluated alerts that share one cache: indicator and line. */
export type ServerAlert = IndicatorAlert | LineAlert;

const isIndicator = (a: ServerAlert): a is IndicatorAlert => a.kind === "indicator";
const isLine = (a: ServerAlert): a is LineAlert => a.kind === "line";

export const lineAlertLabel = (timeframe: string): string => `Trendline (${tfLabel(timeframe)})`;
```

Change `AnyAlert`:

```ts
export type AnyAlert = SavedAlert | IndicatorAlert | LineAlert;
```

Change the cache declaration (find `indicatorCache` and `nextInd` types) from `Map<string, IndicatorAlert>` to `Map<string, ServerAlert>`.

Add the row mapper next to `rowToIndicatorAlert`:

```ts
function rowToLineAlert(row: AlertRow): LineAlert {
  const p = row.params as Record<string, unknown>;
  return {
    kind: "line",
    id: row.id,
    epic: row.epic,
    broker: row.broker,
    condition: p.condition as AlertCondition,
    trigger: p.trigger as AlertTrigger,
    message: row.message,
    expiresAt: row.expires_at,
    notify: { ...ALL_CHANNELS, ...(row.notify ?? {}) },
    createdAt: row.created_at,
    precision: row.precision,
    status: row.status,
    params: {
      timeframe: p.timeframe as string,
      evalOn: p.evalOn as EvalOn,
      tRef: p.tRef as number,
      pRef: p.pRef as number,
      slope: p.slope as number,
      anchors: p.anchors as LineAlertParams["anchors"],
      link: (p.link as LineAlertParams["link"]) ?? null,
    },
  };
}
```

In `hydrateAlerts`, replace `if (row.kind === "indicator") { nextInd.set(row.id, rowToIndicatorAlert(row)); } else {` with:

```ts
          if (row.kind === "indicator") {
            nextInd.set(row.id, rowToIndicatorAlert(row));
          } else if (row.kind === "line") {
            nextInd.set(row.id, rowToLineAlert(row));
          } else {
```

In `triggeredRowToClient`, replace the `label:` expression with:

```ts
    label: row.alert?.params && row.kind === "indicator"
      ? rowToIndicatorAlertLabel(row.alert.params)
      : row.alert?.params && row.kind === "line"
        ? lineAlertLabel(row.alert.params.timeframe as string)
        : undefined,
```

Replace the four indicator readers so they filter by kind, and add the line/server readers:

```ts
export function loadIndicatorAlerts(epic: string, broker: string = getPersistBroker()): IndicatorAlert[] {
  return [...indicatorCache.values()].filter(isIndicator).filter((a) => a.epic === epic && a.broker === broker);
}

export function loadAllIndicatorAlerts(broker: string = getPersistBroker()): IndicatorAlert[] {
  return [...indicatorCache.values()].filter(isIndicator).filter((a) => a.broker === broker);
}

export function linkedAlerts(scope: string, instanceId: string): IndicatorAlert[] {
  return [...indicatorCache.values()].filter(isIndicator).filter(
    (a) => a.params.link?.scope === scope && a.params.link.instanceId === instanceId,
  );
}

export function scopeLinkedAlerts(scope: string, broker: string = getPersistBroker()): IndicatorAlert[] {
  return [...indicatorCache.values()].filter(isIndicator)
    .filter((a) => a.broker === broker && a.params.link?.scope === scope);
}

export function loadLineAlerts(epic: string, broker: string = getPersistBroker()): LineAlert[] {
  return [...indicatorCache.values()].filter(isLine).filter((a) => a.epic === epic && a.broker === broker);
}

/** Indicator and line alerts on one epic: the alerts panel lists both. */
export function loadServerAlerts(epic: string, broker: string = getPersistBroker()): ServerAlert[] {
  return [...indicatorCache.values()].filter((a) => a.epic === epic && a.broker === broker);
}

export function loadAllServerAlerts(broker: string = getPersistBroker()): ServerAlert[] {
  return [...indicatorCache.values()].filter((a) => a.broker === broker);
}

export function findServerAlert(id: string): ServerAlert | undefined {
  return indicatorCache.get(id);
}

export function linkedLineAlerts(scope: string, instanceId: string): LineAlert[] {
  return [...indicatorCache.values()].filter(isLine).filter(
    (a) => a.params.link?.scope === scope && a.params.link.instanceId === instanceId,
  );
}

export function scopeLinkedLineAlerts(scope: string, broker: string = getPersistBroker()): LineAlert[] {
  return [...indicatorCache.values()].filter(isLine)
    .filter((a) => a.broker === broker && a.params.link?.scope === scope);
}
```

In `patchIndicatorAlert`, change the guard to:

```ts
  const prev = indicatorCache.get(id);
  if (!prev || prev.kind !== "indicator") return false;
```

After `patchIndicatorAlert`, add:

```ts
export async function addLineAlert(a: LineAlert): Promise<boolean> {
  if (indicatorCache.has(a.id)) return true; // idempotent
  indicatorCache.set(a.id, a);
  bumpAlerts();
  indWriteStart();
  const res = await sendJson("/api/alerts", "POST", {
    id: a.id, broker: a.broker, epic: a.epic, kind: "line",
    params: { ...a.params, condition: a.condition, trigger: a.trigger },
    message: a.message, expires_at: a.expiresAt, notify: a.notify, precision: a.precision,
  });
  indWriteSettled();
  if (res?.ok) return true;
  indicatorCache.delete(a.id);
  bumpAlerts();
  await reportFailure(res, "Alert save failed");
  return false;
}

/** Only what a user (or a pane removal) may change. The geometry is frozen
 * and tRef/pRef belong to the server, so they are never sent: the server
 * merges this into its own params. */
export async function patchLineAlert(
  id: string,
  patch: Partial<Pick<LineAlert, "condition" | "trigger" | "message" | "expiresAt" | "notify">> & {
    params?: Partial<Pick<LineAlertParams, "evalOn" | "link">>;
  },
): Promise<boolean> {
  const prev = indicatorCache.get(id);
  if (!prev || prev.kind !== "line") return false;
  const next: LineAlert = { ...prev, ...patch, params: { ...prev.params, ...(patch.params ?? {}) } };
  indicatorCache.set(id, next);
  bumpAlerts();
  indWriteStart();
  const res = await sendJson(`/api/alerts/${encodeURIComponent(id)}`, "PATCH", {
    params: { ...(patch.params ?? {}), condition: next.condition, trigger: next.trigger },
    message: next.message,
    expires_at: next.expiresAt,
    notify: next.notify,
  });
  indWriteSettled();
  if (res?.ok) return true;
  if (indicatorCache.has(id)) {
    indicatorCache.set(id, prev);
    bumpAlerts();
  }
  await reportFailure(res, "Alert update failed");
  return false;
}
```

In `alertLabel`, right after the `if (a.kind !== "indicator") {` price branch... restructure to:

```ts
export function alertLabel(a: AnyAlert, precision: number): string {
  if (a.kind === "line") return conditionPhrase(lineAlertLabel(a.params.timeframe), a.condition, "price", "");
  if (a.kind !== "indicator") {
    return conditionPhrase(undefined, a.condition, undefined, levelText("price", a.level, precision));
  }
```

(`SavedAlert` has no `kind: "line"`; if `SavedAlert.kind` is optional/undefined, the narrowing still holds. If tsc complains, check `SavedAlert`'s `kind` field at `alertsApi.ts:45` and narrow with `"params" in a && a.kind === "line"`.)

- [ ] **Step 4: alertEdit helper and panel wiring**

Create `frontend/src/lib/alertEdit.ts`:

```ts
// Opens the right editor for a server-evaluated alert: the bell, the alerts
// panel and the mobile list all hold only an id.
import { findServerAlert } from "./alertsApi";
import { indicatorAlertRequest, lineAlertRequest } from "./signals";

export function requestAlertEdit(id: string): void {
  if (findServerAlert(id)?.kind === "line") lineAlertRequest.set({ mode: "edit", id });
  else indicatorAlertRequest.set({ mode: "edit", id });
}
```

In `frontend/src/AlertsSidebar.tsx`:
- Import `loadServerAlerts, loadAllServerAlerts, type ServerAlert` from `./lib/alertsApi` (drop `loadAllIndicatorAlerts` / `loadIndicatorAlerts` if now unused) and `requestAlertEdit` from `./lib/alertEdit`.
- `IndicatorAlertRow`: prop type `a: ServerAlert`; `const edit = () => requestAlertEdit(a.id);`.
- `sortIndicator = (list: ServerAlert[]) => {` (body unchanged).
- `const liveInd = sortIndicator(loadServerAlerts(epic, brokerId));`
- `const indByEpic = new Map<string, ServerAlert[]>(); for (const a of loadAllServerAlerts(brokerId)) {`

In `frontend/src/mobile/MobileAlertsView.tsx`:
- Import `loadAllServerAlerts, type ServerAlert` and `requestAlertEdit`.
- `const indByEpic = new Map<string, ServerAlert[]>(); for (const a of loadAllServerAlerts(broker)) {`
- The items union's indicator member: `alert: ServerAlert`.
- Row click: `onClick={() => requestAlertEdit(a.id)}`.

- [ ] **Step 5: Run tests**

Run: `cd frontend && npx vitest run src/lib/alertsApi.test.ts src/lib/indicatorAlertSync.test.ts src/AlertsSidebar.test.tsx src/mobile/MobileAlertsView.test.tsx`
(Skip any of the last two that do not exist: `ls src/AlertsSidebar*.test.* src/mobile/MobileAlertsView*.test.*`.)
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/alertsApi.ts frontend/src/lib/alertsApi.test.ts frontend/src/lib/alertEdit.ts \
  frontend/src/AlertsSidebar.tsx frontend/src/mobile/MobileAlertsView.tsx
git commit -m "feat(alerts): line alerts in the alerts cache and panels

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Line alert dialog, right-click entry, pane sync

**Files:**
- Create: `frontend/src/LineAlertModal.tsx`
- Modify: `frontend/src/app/usePanelSignals.ts` (`:101-111`), `frontend/src/App.tsx` (`:193-212`, `:1227-1234`), `frontend/src/mobile/MobileModals.tsx` (`:60`, `:134-141`)
- Modify: `frontend/src/chart/useTrendlineMenu.tsx` (Args, real-line menu items `:316-333`)
- Modify: `frontend/src/ChartCore.tsx` (move `alertContext` above `useTrendlineMenu` `:1799`; pass `lineAlert`)
- Modify: `frontend/src/lib/indicatorAlertSync.ts` (`syncAlertsAfterRemove`, `relinkAlerts`, `reconcileLinksForScope`, `unlink`)
- Test: `frontend/src/LineAlertModal.test.tsx` (create), `frontend/src/chart/useTrendlineMenu.debug.test.tsx`, `frontend/src/lib/indicatorAlertSync.test.ts`

**Interfaces:**
- Consumes: `buildLineAlertDraft`, `lineAlertRequest`, `LineAlertRequest` (Task 7); `addLineAlert`, `patchLineAlert`, `findServerAlert`, `deleteIndicatorAlert`, `linkedLineAlerts`, `scopeLinkedLineAlerts`, `lineAlertLabel` (Task 8).
- Produces: `useTrendlineMenu` arg `lineAlert?: { ctx: React.MutableRefObject<{ epic: string; broker: string; precision: number }>; resolutionRef: React.MutableRefObject<string>; blocked: () => boolean }`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/indicatorAlertSync.test.ts` a describe that mocks the line readers. First read the file's existing mock of `./alertsApi` and extend it with `linkedLineAlerts`, `scopeLinkedLineAlerts`, `patchLineAlert` (vi.fn) and `deleteIndicatorAlert` (already mocked). Then:

```ts
describe("line alerts follow pane removal, not settings edits", () => {
  it("syncAlertsAfterRemove offers to delete line alerts too; Keep unlinks them", () => {
    lineAlerts.splice(0, lineAlerts.length, { kind: "line", id: "al-l", params: { link: { scope: "s", instanceId: "TRENDLINES", lineKey: "k" } } });
    indAlerts.splice(0, indAlerts.length);
    syncAlertsAfterRemove("s", "TRENDLINES");
    const req = confirmSpy.mock.calls.at(-1)![0];
    expect(req.message).toBe("Also delete its 1 alert?");
    req.onCancel();
    expect(patchLineAlert).toHaveBeenCalledWith("al-l", { params: { link: null } });
  });
  it("syncAlertsAfterEdit leaves line alerts alone", () => {
    lineAlerts.splice(0, lineAlerts.length, { kind: "line", id: "al-l", params: { link: { scope: "s", instanceId: "TRENDLINES", lineKey: "k" } } });
    indAlerts.splice(0, indAlerts.length);
    confirmSpy.mockClear();
    syncAlertsAfterEdit("s", "TRENDLINES", () => ({ ok: false, reason: "x" }));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(patchLineAlert).not.toHaveBeenCalled();
  });
});
```

(Name `lineAlerts`, `indAlerts`, `confirmSpy` after whatever the existing file uses for its mocked arrays and `requestConfirm` spy; add `lineAlerts` beside them.)

Append to `frontend/src/chart/useTrendlineMenu.debug.test.tsx` a second describe:

```tsx
describe("useTrendlineMenu on a real line", () => {
  afterEach(cleanup);
  it("offers Add alert, disabled with the reason when the line can't take one", () => {
    hit.seg.key = "1:2";
    const el = document.createElement("div");
    const { result } = renderHook(() =>
      useTrendlineMenu({
        chartRef: { current: { getIndicators: () => [{ name: "TL", paneId: "candle_pane", extendData: {} }] } as never },
        containerRef: { current: el }, scope: "s", epicRef: { current: "E" },
        overlays: { isDrawing: () => false, peekOverlayRightClick: () => false } as never,
        lineAlert: {
          ctx: { current: { epic: "E", broker: "b", precision: 2 } },
          resolutionRef: { current: "HOUR" }, blocked: () => false,
        },
      }),
    );
    act(() => { result.current.openAt(10, 10); });
    render(<>{result.current.menu}</>);
    expect(screen.getByText("Add alert")).toBeTruthy();
  });
});
```

(The module-level `hit` mock returns a segment with no `alertLine`, so the entry renders disabled with "This line can't take an alert yet". Import `act` from `@testing-library/react`. Reset `hit.seg.key = "dbg:1|2"` in the existing describe's setup if it relies on it.)

Create `frontend/src/LineAlertModal.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
const add = vi.fn(() => Promise.resolve(true));
vi.mock("./lib/alertsApi", async (orig) => ({
  ...(await orig<typeof import("./lib/alertsApi")>()),
  addLineAlert: (...a: unknown[]) => add(...(a as [])),
}));
import LineAlertModal from "./LineAlertModal";

const draft = {
  epic: "US100", broker: "b", precision: 2, timeframe: "HOUR",
  line: { slope: 0.5, tRef: 9, pRef: 13, t1: 2, p1: 10, t2: 6, p2: 12 },
  link: { scope: "s", instanceId: "TRENDLINES", lineKey: "2:6" },
};

describe("LineAlertModal", () => {
  it("creates a line alert with the frozen geometry", async () => {
    const onClose = vi.fn();
    render(<LineAlertModal request={{ mode: "create", draft }} defaults={{ condition: "crossing", trigger: "once" } as never}
      now={0} onClose={onClose} />);
    expect(screen.getByText("Trendline (1H)")).toBeTruthy();
    fireEvent.click(screen.getByText("Create"));
    await Promise.resolve();
    expect(add).toHaveBeenCalledTimes(1);
    const a = (add.mock.calls[0] as unknown as [{ kind: string; params: Record<string, unknown> }])[0];
    expect(a.kind).toBe("line");
    expect(a.params).toMatchObject({ timeframe: "HOUR", tRef: 9, pRef: 13, slope: 0.5, anchors: { t1: 2, p1: 10, t2: 6, p2: 12 } });
  });
});
```

(Check `AlertDefaults` in `frontend/src/theme.ts` and pass whatever fields `useAlertCommonState` reads; mirror how an existing IndicatorAlertModal test builds `defaults` if one exists: `ls src/IndicatorAlertModal*.test.*`.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run src/LineAlertModal.test.tsx src/chart/useTrendlineMenu.debug.test.tsx src/lib/indicatorAlertSync.test.ts`
Expected: FAIL (module `./LineAlertModal` missing; no "Add alert"; removal ignores line alerts).

- [ ] **Step 3: LineAlertModal**

Create `frontend/src/LineAlertModal.tsx`:

```tsx
// Line alert dialog: price vs one frozen trendline. Create comes from the
// trendline right-click menu; edit from the alerts panel or the chart bell.
// The geometry is fixed once set, so only the condition, evaluation and the
// shared fields are editable.
import { useEffect, useState } from "react";
import FloatingModal from "./components/FloatingModal";
import InfoTip from "./components/InfoTip";
import AlertCommonFields, { useAlertCommonState } from "./components/AlertCommonFields";
import { CONDITIONS } from "./lib/alertUi";
import {
  addLineAlert, conditionPhrase, deleteIndicatorAlert, findServerAlert, lineAlertLabel, newAlertId, patchLineAlert,
  type AlertCondition, type EvalOn, type LineAlert,
} from "./lib/alertsApi";
import { requestConfirm, type LineAlertRequest } from "./lib/signals";
import type { AlertDefaults } from "./theme";

interface Props {
  request: LineAlertRequest;
  defaults: AlertDefaults;
  now: number;
  onClose: () => void;
}


export default function LineAlertModal({ request, defaults, now, onClose }: Props) {
  const found = request.mode === "edit" ? findServerAlert(request.id) : undefined;
  const existing = found?.kind === "line" ? found : undefined;
  useEffect(() => {
    if (request.mode === "edit" && !existing) onClose(); // deleted elsewhere
  }, [request, existing, onClose]);
  if (request.mode === "edit" && !existing) return null;
  return <Body {...{ request, existing, defaults, now, onClose }} />;
}

function Body({ request, existing, defaults, now, onClose }: Props & { existing?: LineAlert }) {
  const isEdit = request.mode === "edit";
  const epic = existing?.epic ?? (request.mode === "create" ? request.draft.epic : "");
  const timeframe = existing?.params.timeframe ?? (request.mode === "create" ? request.draft.timeframe : "");
  const common = useAlertCommonState(existing, defaults, now, isEdit);
  const [condition, setCondition] = useState<AlertCondition>(existing?.condition ?? defaults.condition);
  const [evalOn, setEvalOn] = useState<EvalOn>(existing?.params.evalOn ?? "close");
  const label = lineAlertLabel(timeframe);
  const autoMsg = `${epic} ${conditionPhrase(label, condition, "price", "")}`;

  async function save() {
    const typed = common.message.trim();
    const fields = {
      condition, trigger: common.trigger, message: typed === autoMsg ? "" : typed,
      expiresAt: common.expiresAt, notify: common.notify,
    };
    let ok: boolean;
    if (isEdit) {
      ok = await patchLineAlert(existing!.id, { ...fields, params: { evalOn } });
    } else {
      const d = (request as Extract<LineAlertRequest, { mode: "create" }>).draft;
      const { slope, tRef, pRef, t1, p1, t2, p2 } = d.line;
      ok = await addLineAlert({
        kind: "line", id: newAlertId(), epic: d.epic, broker: d.broker, precision: d.precision,
        createdAt: Date.now(), ...fields,
        params: { timeframe: d.timeframe, evalOn, tRef, pRef, slope, anchors: { t1, p1, t2, p2 }, link: d.link },
      });
    }
    if (ok) onClose();
  }

  return (
    <FloatingModal
      className="alert-modal"
      title={<span>{isEdit ? "Edit alert on " : "Create alert on "}<strong>{epic}</strong></span>}
      onClose={onClose}
      footer={
        <>
          {isEdit && (
            <button className="ghost" onClick={() => requestConfirm({
              message: `Delete this alert on ${epic}?`,
              onConfirm: () => { deleteIndicatorAlert(existing!.id); onClose(); },
            })}>Delete</button>
          )}
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="confirm-primary" onClick={() => void save()}>{isEdit ? "Save" : "Create"}</button>
        </>
      }
    >
      <div className="alert-body">
        <div className="al-field">
          <span>Line</span>
          <strong>{label}</strong>
          <InfoTip title="Line" text={["Fixed where you set it", "Later redraws do not move it"]} />
        </div>
        <div className="al-field">
          <span>Condition</span>
          <div className="al-cond">
            <select className="al-operator" aria-label="Alert condition" value={condition}
              onChange={(e) => setCondition(e.target.value as AlertCondition)}>
              {CONDITIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </div>
        </div>
        <div className="al-field" role="radiogroup" aria-label="Evaluate">
          <span>Evaluate</span>
          <label><input type="radio" aria-label="On bar close" checked={evalOn === "close"} onChange={() => setEvalOn("close")} /> On bar close</label>
          <label><input type="radio" aria-label="As it happens" checked={evalOn === "intrabar"} onChange={() => setEvalOn("intrabar")} /> As it happens</label>
          <InfoTip title="Evaluate" text={["On bar close: no repaint", "As it happens: fires on the live candle"]} />
        </div>
        <AlertCommonFields state={common} now={now} autoMsg={autoMsg} />
      </div>
    </FloatingModal>
  );
}
```

(`useAlertCommonState` already takes a structural `{trigger, message, expiresAt?, notify?}` (`AlertCommonFields.tsx:54-57`), which a `LineAlert` satisfies; no change there. Ids come from `newAlertId()` in `lib/alertsApi.ts`, which also covers browsers without `crypto.randomUUID`.)

- [ ] **Step 4: Render it**

`frontend/src/app/usePanelSignals.ts` (inside `useModalRequests`, beside `indAlertReq`):

```ts
  const [lineAlertReq, setLineAlertReq] = useState(lineAlertRequest.value);
  useEffect(() => lineAlertRequest.subscribe(setLineAlertReq), []);
```

Import `lineAlertRequest`, and add `lineAlertReq` to the returned object.

`frontend/src/App.tsx`: destructure `lineAlertReq`; add it to the Esc effect's guard and dependency array (`|| lineAlertReq`); import `LineAlertModal from "./LineAlertModal"` and `lineAlertRequest`; after the `IndicatorAlertModal` block:

```tsx
      {!isDemoMode() && lineAlertReq && (
        <LineAlertModal
          request={lineAlertReq}
          defaults={settings.alertDefaults}
          now={Date.now()}
          onClose={() => lineAlertRequest.set(null)}
        />
      )}
```

`frontend/src/mobile/MobileModals.tsx`: `const lineAlertReq = useSignal(lineAlertRequest);`, import both, and the same block after the `IndicatorAlertModal` one (same props it passes).

- [ ] **Step 5: Menu entry**

In `frontend/src/chart/useTrendlineMenu.tsx`:

```ts
import { getIndicator } from "../lib/indicators";
import { lineAlertRequest } from "../lib/signals";
import { buildLineAlertDraft } from "./lineAlertDraft";
```

`Args` gains:

```ts
  /** "Add alert" on a line. Absent (tests, read-only surfaces) hides it. */
  lineAlert?: {
    ctx: React.MutableRefObject<{ epic: string; broker: string; precision: number }>;
    resolutionRef: React.MutableRefObject<string>;
    /** Demo, synthetic chart or snapshot view: no alert entry at all. */
    blocked: () => boolean;
  };
```

Destructure `lineAlert` in the hook signature and keep a ref: `const lineAlertRef = useRef(lineAlert); lineAlertRef.current = lineAlert;`.

In the real-line branch, replace the `items` array with:

```tsx
    const alertItems = ((): MenuItem[] => {
      const la = lineAlertRef.current;
      const chart = chartRef.current;
      if (!la || !chart || la.blocked()) return [];
      const ext = getIndicator(chart, hit.paneId, hit.name)?.extendData as Record<string, unknown> | undefined;
      const { epic: e, broker, precision } = la.ctx.current;
      const r = buildLineAlertDraft({
        seg: hit.seg, ext, resolution: la.resolutionRef.current, scope, instanceId: hit.name,
        epic: e, broker, precision,
      });
      if (r === null) return [];
      return "draft" in r
        ? [{ label: "Add alert", icon: MenuIcons.bell, onClick: () => lineAlertRequest.set({ mode: "create", draft: r.draft }) }]
        : [{ label: "Add alert", icon: MenuIcons.bell, disabled: true, disabledReason: r.reason, onClick: () => {} }];
    })();
    const items: MenuItem[] = [
      { label: bold ? "Unhighlight" : "Highlight", icon: MenuIcons.highlight, onClick: () => toggle("bold") },
      { label: hidden ? "Unhide" : "Hide", icon: hidden ? MenuIcons.show : MenuIcons.hide, onClick: () => toggle("hidden") },
      { label: "To drawing", icon: MenuIcons.pencil, onClick: () => void trendlineToDrawing(overlays, hit.seg) },
      ...alertItems,
    ];
```

In `frontend/src/ChartCore.tsx`: cut the `alertContext` declaration and its `.current =` assignment (with their comment) from `:5178-5184` and paste them immediately above `const trendlineMenu = useTrendlineMenu({` (`:1799`), unchanged. Then:

```tsx
  const trendlineMenu = useTrendlineMenu({
    chartRef, containerRef, overlays, scope, epicRef, onDebugPick: trendlineDebug.openFor,
    lineAlert: {
      ctx: alertContext,
      resolutionRef: resRef,
      blocked: () => isDemoMode() || isSynthetic(epicRef.current) || snapViewRef.current,
    },
  });
```

(`alertContext.current` also carries `quoteOnly`; the `ctx` type only reads the three fields, which a wider object satisfies.)

- [ ] **Step 6: Pane sync**

In `frontend/src/lib/indicatorAlertSync.ts`, extend the import with `linkedLineAlerts, patchLineAlert, scopeLinkedLineAlerts, type LineAlert`, then:

```ts
function unlink(alerts: Array<IndicatorAlert | LineAlert>): void {
  for (const a of alerts) {
    if (a.kind === "line") void patchLineAlert(a.id, { params: { link: null } });
    else void patchIndicatorAlert(a.id, { params: { link: null } });
  }
}
```

`relinkAlerts`: after the indicator loop add

```ts
  for (const a of linkedLineAlerts(scope, oldId)) {
    void patchLineAlert(a.id, { params: { link: { scope, instanceId: newId, lineKey: a.params.link!.lineKey } } });
  }
```

`syncAlertsAfterRemove`: `const alerts = [...linkedAlerts(scope, instanceId), ...linkedLineAlerts(scope, instanceId)];` (the rest unchanged; `deleteIndicatorAlert` removes either kind).

`reconcileLinksForScope`:

```ts
  const live = (id: string) => liveInstanceIds.has(id);
  const stale = scopeLinkedAlerts(scope).filter((a) => !live(a.params.link!.instanceId));
  const staleLines = scopeLinkedLineAlerts(scope).filter((a) => !live(a.params.link!.instanceId));
  await Promise.all([
    ...stale.map((a) => patchIndicatorAlert(a.id, { params: { link: null } })),
    ...staleLines.map((a) => patchLineAlert(a.id, { params: { link: null } })),
  ]);
```

`syncAlertsAfterEdit` is untouched: `linkedAlerts` returns indicator alerts only, so line alerts never re-point or prompt.

- [ ] **Step 7: Run tests**

Run: `cd frontend && npx vitest run src/LineAlertModal.test.tsx src/chart/useTrendlineMenu.debug.test.tsx src/lib/indicatorAlertSync.test.ts src/lib/alertsApi.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/LineAlertModal.tsx frontend/src/LineAlertModal.test.tsx frontend/src/app/usePanelSignals.ts \
  frontend/src/App.tsx frontend/src/mobile/MobileModals.tsx frontend/src/chart/useTrendlineMenu.tsx \
  frontend/src/chart/useTrendlineMenu.debug.test.tsx frontend/src/ChartCore.tsx \
  frontend/src/lib/indicatorAlertSync.ts frontend/src/lib/indicatorAlertSync.test.ts
# plus frontend/src/components/AlertCommonFields.tsx if Step 3 widened it
git commit -m "feat(alerts): add an alert to one trendline from its menu

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Chart: dashed line and bell for line alerts

**Files:**
- Create: `frontend/src/lib/lineAlertLevel.ts`
- Modify: `frontend/src/lib/overlays/indicatorAlerts.ts` (ray overlays beside the value lines)
- Modify: `frontend/src/chart/useChartPaint.ts` (bells `:839-854`)
- Modify: `frontend/src/ChartCore.tsx` (`onBellClick` `:6057`)
- Test: `frontend/src/lib/overlays/indicatorAlerts.test.ts`, `frontend/src/lib/lineAlertLevel.test.ts` (create)

**Interfaces:**
- Consumes: `loadLineAlerts`, `LineAlertParams` (Task 8); `alertTimeframeOf`; `alertLineStyles` (`lib/overlays/alertLine.ts`); `requestAlertEdit` (Task 8).
- Produces: `lineLevelNow(p: Pick<LineAlertParams, "tRef" | "pRef" | "slope" | "anchors">, times: readonly number[]): number | null`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/lineAlertLevel.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { lineLevelNow } from "./lineAlertLevel";

const p = { tRef: 30, pRef: 13, slope: 0.5, anchors: { t1: 10, p1: 10, t2: 20, p2: 12 } };

describe("lineLevelNow", () => {
  it("projects from the reference bar to the newest bar", () => {
    expect(lineLevelNow(p, [10, 20, 30, 40, 50])).toBe(14);
  });
  it("falls back to the second anchor when the reference is not loaded", () => {
    expect(lineLevelNow({ ...p, tRef: 99 }, [10, 20, 30])).toBe(12.5);
  });
  it("null when nothing maps", () => {
    expect(lineLevelNow({ ...p, tRef: 99, anchors: { t1: 1, p1: 1, t2: 2, p2: 2 } }, [10, 20])).toBeNull();
  });
});
```

Append to `frontend/src/lib/overlays/indicatorAlerts.test.ts`. Extend its `vi.mock("../alertsApi", ...)` with `loadLineAlerts: () => lineAlerts,` (declare `const lineAlerts: unknown[] = [];` beside `alerts`), and make `fakeChart().chart.getIndicators` return `[{ name: "RSI", paneId: "pane_rsi" }, { name: "TRENDLINES", paneId: "candle_pane", extendData: {} }]`. Then:

```ts
const lineAlert = (scope: string, tf = "HOUR") => ({
  kind: "line", id: "al-l", epic: "US100", broker: "b", condition: "crossing", trigger: "every",
  message: "", expiresAt: null, notify: {}, precision: 2,
  params: { timeframe: tf, evalOn: "close", tRef: 9, pRef: 13, slope: 0.5,
    anchors: { t1: 2, p1: 10, t2: 6, p2: 12 }, link: { scope, instanceId: "TRENDLINES", lineKey: "2:6" } },
});

describe("IndicatorAlertLines: line alerts", () => {
  it("draws a dashed ray through the anchors on the linked cell's timeframe only", () => {
    alerts.splice(0, alerts.length);
    lineAlerts.splice(0, lineAlerts.length, lineAlert("s1"), { ...lineAlert("s1", "DAY"), id: "al-l2" }, { ...lineAlert("s2"), id: "al-l3" });
    const { chart, created } = fakeChart();
    const lines = new IndicatorAlertLines();
    lines.attach(chart as never, "s1", "b", "US100", "HOUR");
    lines.reconcile();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      id: "lnalert:al-l", name: "rayLine", lock: true,
      points: [{ timestamp: 2, value: 10 }, { timestamp: 6, value: 12 }],
    });
    lineAlerts.splice(0, lineAlerts.length);
    lines.reconcile();
    expect(chart.removeOverlay).toHaveBeenCalledWith({ id: "lnalert:al-l" });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run src/lib/lineAlertLevel.test.ts src/lib/overlays/indicatorAlerts.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `frontend/src/lib/lineAlertLevel.ts`:

```ts
// A line alert's level at the chart's newest bar, when the chart shows the
// alert's own timeframe (bars there are the alert's bars, so the slope is
// per chart bar). The reference bar first, then the anchors if the chart
// has not loaded that far back.
import type { LineAlertParams } from "./alertsApi";

export function lineLevelNow(
  p: Pick<LineAlertParams, "tRef" | "pRef" | "slope" | "anchors">,
  times: readonly number[],
): number | null {
  const last = times.length - 1;
  for (const [t, price] of [[p.tRef, p.pRef], [p.anchors.t2, p.anchors.p2], [p.anchors.t1, p.anchors.p1]]) {
    const j = times.lastIndexOf(t);
    if (j >= 0) return price + p.slope * (last - j);
  }
  return null;
}
```

In `frontend/src/lib/overlays/indicatorAlerts.ts`:
- Import `loadLineAlerts, type LineAlert` from `"../alertsApi"` and `alertLineStyles` from `"./alertLine"`.
- Update the header comment: "Also the frozen-trendline (`line`) alerts, drawn as a dashed ray through their anchors on the candle pane of the linked cell, while its Trendlines pane alerts on the alert's timeframe."
- Add `const rayId = (alertId: string) => \`lnalert:${alertId}\`;` beside `ovId`.
- Field: `private rays = new Map<string, string>(); // alertId -> geometry key`.
- In `attach`, beside `this.drawn.clear()`: `this.rays.clear();`.
- New method:

```ts
  // Line alerts to draw: linked to this cell, whose Trendlines instance is
  // here and alerts on the alert's timeframe (a pinned pane, its pin).
  private wantedRays(): Map<string, LineAlert> {
    const out = new Map<string, LineAlert>();
    if (!this.chart) return out;
    for (const a of loadLineAlerts(this.epic, this.broker)) {
      const link = a.params.link;
      if (!link || link.scope !== this.scope) continue;
      for (const [, inds] of getIndicatorsByPane(this.chart)) {
        const ind = inds.get(link.instanceId);
        if (!ind) continue;
        const ext = ind.extendData as Record<string, unknown> | undefined;
        if (alertTimeframeOf(ext, this.resolution) === a.params.timeframe) out.set(a.id, a);
        break;
      }
    }
    return out;
  }

  private reconcileRays(c: Chart, hidden: boolean, hiddenChanged: boolean): void {
    const want = this.wantedRays();
    for (const [id, geo] of this.rays) {
      const w = want.get(id);
      const a = w?.params.anchors;
      if (!a || `${a.t1}:${a.p1}:${a.t2}:${a.p2}` !== geo) {
        c.removeOverlay({ id: rayId(id) });
        this.rays.delete(id);
      } else if (hiddenChanged) {
        c.overrideOverlay({ id: rayId(id), visible: !hidden });
      }
    }
    for (const [id, a] of want) {
      if (this.rays.has(id)) continue;
      const { t1, p1, t2, p2 } = a.params.anchors;
      const made = c.createOverlay({
        id: rayId(id),
        name: "rayLine",
        points: [{ timestamp: t1, value: p1 }, { timestamp: t2, value: p2 }],
        styles: alertLineStyles(false),
        visible: !hidden,
        mode: "normal",
        needDefaultXAxisFigure: false,
        needDefaultYAxisFigure: false,
        // Locked and app-owned: the geometry is frozen with the alert.
        lock: true,
        onRightClick: (e: { preventDefault?: () => void }) => {
          e.preventDefault?.();
          return true;
        },
      } as never);
      if (typeof made === "string") this.rays.set(id, `${t1}:${p1}:${t2}:${p2}`);
    }
  }
```

- In `reconcile()`, capture `const hiddenChanged = hidden !== this.shownHidden;` before the existing `if (hidden !== this.shownHidden)` block, and at the end of `reconcile()` call `this.reconcileRays(c, hidden, hiddenChanged);`.

In `frontend/src/chart/useChartPaint.ts`, import `loadLineAlerts` (beside `loadIndicatorAlerts`) and `lineLevelNow` from `"../lib/lineAlertLevel"`. After the indicator-bell loop (before `setIndicatorBells`):

```ts
    // Line alerts (a frozen trendline): a bell where the line meets the
    // axis, only when the chart shows the alert's own timeframe (its bars
    // are the alert's bars there; on any other timeframe the dashed line
    // shows without a bell).
    if (!overlays.getAlertsHidden()) {
      const times = chart.getDataList().map((d) => d.timestamp);
      for (const a of loadLineAlerts(epicRef.current, brokerIdRef.current)) {
        const p = a.params;
        if (!p.link || p.link.scope !== scope || p.timeframe !== resRef.current) continue;
        const ind = getIndicatorById(chart, p.link.instanceId);
        if (!ind || ind.visible === false) continue;
        const v = lineLevelNow(p, times);
        if (v == null || !Number.isFinite(v)) continue;
        const y = yOf(v);
        if (y != null) bells.push({ id: a.id, y });
      }
    }
```

In `frontend/src/ChartCore.tsx`, import `requestAlertEdit` from `"./lib/alertEdit"` and change the bell handler:

```tsx
        onBellClick={(id) => requestAlertEdit(id)}
```

(Remove `indicatorAlertRequest` from ChartCore's signals import only if nothing else there uses it.)

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/lib/lineAlertLevel.test.ts src/lib/overlays/indicatorAlerts.test.ts src/chart/useLineDrag.test.ts`
(Drop `useLineDrag.test.ts` if absent.)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/lineAlertLevel.ts frontend/src/lib/lineAlertLevel.test.ts \
  frontend/src/lib/overlays/indicatorAlerts.ts frontend/src/lib/overlays/indicatorAlerts.test.ts \
  frontend/src/chart/useChartPaint.ts frontend/src/ChartCore.tsx
git commit -m "feat(alerts): draw line alerts and their bell on the chart

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Docs, typecheck, final checks

**Files:**
- Modify: `CLAUDE.md` (Alerts section)
- Modify: `docs/superpowers/specs/2026-10-16-trendline-alerts-design.md` (status, Task 0 number, deviations)

- [ ] **Step 1: CLAUDE.md**

In the `## Alerts` section, after the paragraph that starts "Alert kinds live in `core/alert_kinds.py`", add:

```markdown
Trendline alerts come in two forms. The `line` kind is a frozen straight line
in bars of its timeframe (`tRef`, `pRef`, `slope`), made from a right-clicked
Trendlines line; the engine rolls `tRef` forward every 1000 bars
(`LINE_REBASE_BARS`) so it stays inside the 2000-bar seed, and create 422s
when the chart's reference bar is not one the server holds. Nearest-line
alerts are `indicator` alerts on `TRENDLINES` with the canonical 33-slot
calcParams; the hub runs the full Trendlines compute once per close and
keeps the held line, so close mode judges a cross against one line
(`resolve_close`) and intrabar only projects it.
```

- [ ] **Step 2: Spec status**

Change the spec's `Status:` line to `Status: implemented <date> (plan docs/superpowers/plans/2026-10-16-trendline-alerts.md).`, add the Task 0 median to "Known limits > Cost", and add an "Accepted deviations" list copying the eight items from this plan's "Spec deviations".

- [ ] **Step 3: Lint the changed frontend files**

Run: `cd frontend && npx eslint src/LineAlertModal.tsx src/chart/lineAlertDraft.ts src/lib/alertEdit.ts src/lib/lineAlertLevel.ts src/lib/alertsApi.ts src/lib/alertableIndicators.ts src/lib/indicatorAlertSync.ts src/lib/overlays/indicatorAlerts.ts src/lib/indicators/trendlineMarks.ts src/lib/indicators/trendlinesOutputs.ts src/chart/useTrendlineMenu.tsx src/chart/useChartPaint.ts src/AlertsSidebar.tsx src/mobile/MobileAlertsView.tsx src/mobile/MobileModals.tsx src/App.tsx src/ChartCore.tsx src/IndicatorAlertModal.tsx src/app/usePanelSignals.ts src/lib/signals.ts`
Expected: no output.

- [ ] **Step 4: Typecheck (ask first)**

Ask the user: "OK to run `npx tsc -b` (high CPU)?" On yes:
Run: `cd frontend && npx tsc -b`
Expected: no errors. Fix any and re-run the affected test files.

- [ ] **Step 5: Backend sweep of the touched test files**

Run: `cd backend && python3 -m pytest tests/test_alertable.py tests/test_alert_indicators.py tests/test_alert_kinds.py tests/test_alert_engine.py tests/test_alert_engine_feeds.py tests/test_alerts_api.py tests/test_indicator_parity.py tests/test_trendlines_indicator.py tests/test_telegram_rich_alerts.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-10-16-trendline-alerts-design.md
git commit -m "docs(alerts): trendline alerts in CLAUDE.md, spec marked implemented

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
