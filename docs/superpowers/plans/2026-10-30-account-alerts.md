# Account Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Server-side alerts on account-wide figures (margin level, open P/L, equity, available, drawdown) that run for every Capital/IG account whether or not the app has it selected, so the user is warned before the broker force-closes positions.

**Architecture:** A new alert kind `account` lives in the existing `alerts` SQLite table (so CRUD, duplicate detection, triggered history and the notify channels are reused) but is evaluated by a new `AccountMonitor` that polls each account's broker summary and positions (30 s, 5 s near a tier), never by the price `AlertEngine`. Pure modules (`account_metrics`, `account_alert_kind`) hold the math and are tested without I/O; the monitor is tested with a fake executor and a fake clock. The frontend gets an `AccountAlert` type with its own cache, a create/edit modal opened from a bell on the dock stats, an "Account" group in the alerts panel, and account branches in the fired toast, Telegram, and push paths.

**Tech Stack:** Python 3.12 / FastAPI / asyncio / sqlite3 / pytest (backend, run with `cd backend && uv run pytest`); React 18 / TypeScript / Vitest + Testing Library (frontend, run single files with `cd frontend && npx vitest run <file>`).

**Spec:** `docs/superpowers/specs/2026-10-30-account-alerts-design.md`

## Global Constraints

- Monitorable accounts are exactly the exec keys whose broker id is one of `capital`, `capital-live`, `ig-demo`, `ig-live` and whose env is not `paper`. MT5 (`mt5`, `mt5-self`) and paper are refused with 422 `account_not_monitorable`.
- Poll cadence: `NORMAL_S = 30`, `FAST_S = 5`; fast when any alert's value is within 20% of its next unfired tier (`|value - level| <= 0.2 * |level|`).
- Hysteresis: 3 points for `marginLevel`, `openPnlPct`, `drawdown`; `0.02 * |level|` for `equity`, `available`, `openPnl`.
- Watchdog: an account whose last good poll is older than `UNMONITORED_AFTER_S = 120`, or whose poll reports a missing figure while positions are open, is reported unmonitored ONCE on push + Telegram + `/ws/state` regardless of per-alert channels, and "monitoring resumed" once on the next good poll.
- Tiers: 1 to 3 entries, labels from `{warn, danger, critical}`, strictly ordered in the firing direction (descending for falling metrics, ascending for `drawdown`).
- Creating or patching an `account` alert requires admin (`deps.require_admin`).
- Daily drawdown peak resets at the SERVER's local midnight (`datetime.now().date()`).
- No em dashes in any UI text or message; use the middle dot `·` as the separator the spec shows.
- Frontend: tooltips use the shared `Tooltip`/`InfoTip` components, never `title=`. Persistent toggle states are muted gray, not accent blue.
- Run only the test files named in each task, never the whole frontend suite. Commit on the current branch; never create a branch.

## Review Focus

Inputs the spec implies but no single section spells out; each has a test pinned in the owning task:

1. A Capital account with NO open positions: `marginLevel` is `None`, nothing fires, nothing re-arms, and the row stays `monitored: true` (Task 1 and Task 4).
2. A tier list patched to remove a currently fired level: the fired set drops it and no notification is sent for the remaining tiers unless they are newly crossed (Task 4).
3. A broker summary that comes back with `available: None` while positions are open: the account is reported unmonitored with reason `missing available`, not silently held (Task 1 and Task 4).
4. A poll that crosses two tiers at once (margin level 160 → 110 with tiers 150/120/100): exactly one notification, naming `danger` (Task 2 and Task 4).
5. The app restarts while a tier is fired: after restart the first poll at the same value does NOT re-notify (Task 4).

---

## File structure

Backend (`backend/auto_trader/`):
- Create `core/account_metrics.py`: `AccountMetrics` dataclass + `account_metrics()` pure function.
- Create `core/account_alert_kind.py`: `AccountAlertKind` (validate, sig, monitorable), tier math (`evaluate_tiers`, `near_tier`, `hysteresis`), `headline()`, labels.
- Create `core/account_monitor.py`: `AccountMonitor` + `ACCOUNT_MONITOR` singleton.
- Modify `core/alert_store.py`: add `delete_meta`.
- Modify `core/alert_engine.py`: `start()` skips `account` rows.
- Modify `api/routers/alerts.py`: kind dispatch, admin gate, monitor routing, status decoration, `GET /api/alerts/account-metrics`.
- Modify `api/app.py`: configure/start/stop the monitor.
- Modify `core/telegram_notify.py`, `core/push_notify.py`: account branches.
- Modify `scripts/alert_probe.py`: `--account KEY`.
- Tests: `tests/test_account_metrics.py`, `tests/test_account_alert_kind.py`, `tests/test_account_monitor.py`, additions to `tests/test_alert_engine.py`, `tests/test_alerts_api.py`, `tests/test_telegram_rich_alerts.py`.

Frontend (`frontend/src/`):
- Modify `lib/alertsApi.ts`: `AccountAlert` type, cache, CRUD, metrics fetch, fired/monitor events.
- Modify `lib/signals.ts`: `accountAlertRequest` signal.
- Modify `app/useAlertFiredNotices.ts`, `public/alert-sw.js`: account branches.
- Create `AccountAlertModal.tsx` (+ `.test.tsx`).
- Modify `PositionsPanel.tsx`, `mobile/MobilePositionsView.tsx`, `App.css`: bell on stats.
- Modify `AlertsSidebar.tsx` (+ test): Account group.
- Modify `App.tsx`: mount the modal.
- Modify `CLAUDE.md`: Account alerts section.

---

### Task 1: Account metrics (pure)

**Files:**
- Create: `backend/auto_trader/core/account_metrics.py`
- Test: `backend/tests/test_account_metrics.py`

**Interfaces:**
- Produces:
  ```python
  @dataclass(frozen=True)
  class AccountMetrics:
      balance: float | None; equity: float | None; margin: float | None
      available: float | None; open_pnl: float | None
      margin_level: float | None; open_pnl_pct: float | None
      currency: str | None
      missing: tuple[str, ...]   # figures needed but absent while positions are open
      def value_of(self, metric: str) -> float | None  # by wire name: marginLevel, openPnl, openPnlPct, equity, available
  def account_metrics(summary: dict | None, positions: Sequence[Position], *, cash_balance: bool) -> AccountMetrics
  ```
  `cash_balance=True` means the broker's `balance` EXCLUDES open P/L (IG); False means it includes it (Capital). Mirrors `liveBalanceInclPnl = isCapital(broker)` in `frontend/src/lib/accountStats.ts:91`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_account_metrics.py
"""account_metrics: the server-side port of lib/accountStats.ts using broker
figures only (no browser leverage or paper-balance fallbacks)."""
from auto_trader.core.account_metrics import account_metrics
from auto_trader.core.models import Position, Side


def pos(upnl=0.0, margin=None, qty=1.0, side=Side.BUY):
    return Position(epic="US100", side=side, quantity=qty, open_level=100.0,
                    deal_id="d", upnl=upnl, margin=margin)


CAPITAL = {"balance": 4210.0, "available": 3010.0, "deposit": 1200.0,
           "profitLoss": -90.0, "currency": "EUR"}


def test_capital_per_position_margin():
    m = account_metrics(CAPITAL, [pos(-40, 700.0), pos(-50, 500.0)], cash_balance=False)
    assert m.margin == 1200.0
    assert m.equity == 3010.0 + 1200.0
    assert m.open_pnl == -90.0                    # summary.profitLoss wins
    assert m.margin_level == (4210.0 / 1200.0) * 100
    assert m.open_pnl_pct == (-90.0 / 4210.0) * 100
    assert m.currency == "EUR" and m.missing == ()


def test_capital_without_position_margin_falls_back_to_balance_minus_available():
    m = account_metrics(CAPITAL, [pos(-40, None), pos(-50, 500.0)], cash_balance=False)
    assert m.margin == 4210.0 - 3010.0
    assert m.equity == 4210.0                     # Capital's balance IS the equity


def test_ig_cash_balance_adds_open_pnl():
    ig = {"balance": 5000.0, "available": 4200.0, "deposit": None,
          "profitLoss": None, "currency": "GBP"}
    m = account_metrics(ig, [pos(-100, None)], cash_balance=True)
    assert m.open_pnl == -100.0                   # summed from positions
    assert m.margin == 5000.0 - 100.0 - 4200.0
    assert m.equity == 5000.0 - 100.0


def test_no_positions_means_no_margin_level_and_nothing_missing():
    m = account_metrics(CAPITAL, [], cash_balance=False)
    assert m.margin_level is None and m.missing == ()
    assert m.equity == 4210.0 and m.value_of("equity") == 4210.0


def test_missing_available_with_positions_is_reported():
    s = {**CAPITAL, "available": None}
    m = account_metrics(s, [pos(-40, None)], cash_balance=False)
    assert "available" in m.missing
    assert m.margin is None and m.margin_level is None


def test_missing_summary_entirely():
    m = account_metrics(None, [pos(-1, None)], cash_balance=False)
    assert "balance" in m.missing and m.value_of("marginLevel") is None


def test_value_of_unknown_metric_is_none():
    assert account_metrics(CAPITAL, [], cash_balance=False).value_of("drawdown") is None
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_account_metrics.py -q`
Expected: ImportError on `account_metrics`.

- [ ] **Step 3: Implement**

```python
# backend/auto_trader/core/account_metrics.py
"""Account-wide figures from broker data only: the server-side half of
frontend/src/lib/accountStats.ts. The browser adds estimates the server has no
inputs for (working-order margin from the configured leverage, the paper
balance); those are left out on purpose, so a margin level here can differ
slightly from the dock's when resting orders reserve margin."""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from auto_trader.core.models import Position

METRICS = ("marginLevel", "openPnl", "openPnlPct", "equity", "available", "drawdown")


@dataclass(frozen=True)
class AccountMetrics:
    balance: float | None
    equity: float | None
    margin: float | None
    available: float | None
    open_pnl: float | None
    margin_level: float | None
    open_pnl_pct: float | None
    currency: str | None
    # Figures a judgement needs but the broker did not supply while positions
    # are open. Non-empty means "not monitored", never a silent hold.
    missing: tuple[str, ...]

    def value_of(self, metric: str) -> float | None:
        return {
            "marginLevel": self.margin_level,
            "openPnl": self.open_pnl,
            "openPnlPct": self.open_pnl_pct,
            "equity": self.equity,
            "available": self.available,
        }.get(metric)


def _num(v) -> float | None:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def account_metrics(
    summary: dict | None, positions: Sequence[Position], *, cash_balance: bool
) -> AccountMetrics:
    s = summary or {}
    balance = _num(s.get("balance"))
    available = _num(s.get("available"))
    currency = s.get("currency") if isinstance(s.get("currency"), str) else None
    reported_pnl = _num(s.get("profitLoss"))
    summed = [p.upnl for p in positions if p.upnl is not None]
    open_pnl = reported_pnl if reported_pnl is not None else (sum(summed) if positions else 0.0)
    if positions and reported_pnl is None and len(summed) != len(positions):
        open_pnl = None

    missing: list[str] = []
    if positions:
        if balance is None:
            missing.append("balance")
        if available is None:
            missing.append("available")
        if open_pnl is None:
            missing.append("profitLoss")

    all_margin_known = bool(positions) and all(p.margin is not None for p in positions)
    margin: float | None
    equity: float | None
    if not positions:
        margin = 0.0
        equity = balance if (not cash_balance or open_pnl is None) else (
            balance + open_pnl if balance is not None else None)
    elif missing:
        margin = None
        equity = None
    elif all_margin_known:
        margin = sum(p.margin for p in positions)  # type: ignore[misc]
        equity = available + margin  # type: ignore[operator]
    else:
        pnl_term = open_pnl if cash_balance else 0.0
        margin = max(0.0, balance + pnl_term - available)  # type: ignore[operator]
        equity = balance if not cash_balance else balance + open_pnl  # type: ignore[operator]

    margin_level = (equity / margin * 100) if (equity is not None and margin) else None
    open_pnl_pct = (open_pnl / balance * 100) if (open_pnl is not None and balance) else None
    return AccountMetrics(
        balance=balance, equity=equity, margin=margin, available=available,
        open_pnl=open_pnl, margin_level=margin_level, open_pnl_pct=open_pnl_pct,
        currency=currency, missing=tuple(missing),
    )
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && uv run pytest tests/test_account_metrics.py -q`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/account_metrics.py backend/tests/test_account_metrics.py
git commit -m "feat(alerts): account metrics from broker figures"
```

---

### Task 2: Account alert kind (validation, sig, tier math, headline)

**Files:**
- Create: `backend/auto_trader/core/account_alert_kind.py`
- Test: `backend/tests/test_account_alert_kind.py`

**Interfaces:**
- Produces:
  ```python
  MONITORABLE_BROKERS = frozenset({"capital", "capital-live", "ig-demo", "ig-live"})
  FALLING = frozenset({"marginLevel", "equity", "available", "openPnl", "openPnlPct"})
  TIER_LABELS = ("warn", "danger", "critical")
  METRIC_LABELS: dict[str, str]        # "marginLevel" -> "MARGIN LEVEL" ...
  def account_label(key: str) -> str   # "capital-live:live" -> "Capital live"
  def is_monitorable(key: str, env: str) -> bool
  def cash_balance(key: str) -> bool   # True for ig-*
  class AccountAlertKind:
      def validate(self, params: dict) -> None          # raises ValueError
      def sig(self, params: dict) -> str
  ACCOUNT_KIND = AccountAlertKind()
  def hysteresis(metric: str, level: float) -> float
  def evaluate_tiers(metric: str, tiers: list[dict], value: float, fired: set[float]) -> tuple[set[float], float | None]
      # returns (new fired set, most severe NEWLY crossed level or None)
  def crossed_now(metric: str, tiers: list[dict], value: float) -> set[float]   # tiers already past `value` (seeding)
  def near_tier(metric: str, tiers: list[dict], value: float, fired: set[float]) -> bool
  def tier_label(tiers: list[dict], level: float) -> str
  def fmt_value(metric: str, value: float, currency: str | None) -> str   # "118.4%" or "4,210 EUR"
  def headline(metric: str, value: float, level: float, label: str, key: str, currency: str | None, equity: float | None) -> str
  ```

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_account_alert_kind.py
import pytest

from auto_trader.core.account_alert_kind import (
    ACCOUNT_KIND, account_label, crossed_now, evaluate_tiers, headline, hysteresis,
    is_monitorable, near_tier,
)

TIERS = [{"level": 150, "label": "warn"}, {"level": 120, "label": "danger"}, {"level": 100, "label": "critical"}]


def P(**kw):
    base = {"metric": "marginLevel", "tiers": TIERS}
    base.update(kw)
    return base


def test_validate_accepts_margin_tiers():
    ACCOUNT_KIND.validate(P())


@pytest.mark.parametrize("bad", [
    P(metric="leverage"),
    P(tiers=[]),
    P(tiers=TIERS + [{"level": 90, "label": "warn"}]),
    P(tiers=[{"level": 100, "label": "critical"}, {"level": 120, "label": "danger"}]),  # wrong order
    P(tiers=[{"level": 100, "label": "boom"}]),
    P(tiers=[{"level": float("nan"), "label": "warn"}]),
    P(metric="drawdown", tiers=[{"level": 10, "label": "danger"}, {"level": 5, "label": "warn"}]),  # drawdown ascends
    P(metric="drawdown", tiers=[{"level": 5, "label": "warn"}], baseline="weekly"),
])
def test_validate_rejects(bad):
    with pytest.raises(ValueError):
        ACCOUNT_KIND.validate(bad)


def test_drawdown_requires_baseline_and_ascending_tiers():
    ACCOUNT_KIND.validate(P(metric="drawdown", baseline="daily",
                            tiers=[{"level": 5, "label": "warn"}, {"level": 10, "label": "danger"}]))
    with pytest.raises(ValueError):
        ACCOUNT_KIND.validate(P(metric="drawdown", tiers=[{"level": 5, "label": "warn"}]))


def test_sig_ignores_labels_and_order_of_keys():
    a = ACCOUNT_KIND.sig(P())
    b = ACCOUNT_KIND.sig(P(tiers=[{"label": "x", "level": 150}, {"level": 120, "label": "y"}, {"level": 100, "label": "z"}]))
    assert a == b
    assert ACCOUNT_KIND.sig(P(tiers=TIERS[:2])) != a
    assert ACCOUNT_KIND.sig(P(metric="equity")) != a


def test_monitorable():
    assert is_monitorable("capital-live:live", "live")
    assert is_monitorable("capital:demo", "demo")
    assert is_monitorable("ig-demo:demo", "demo")
    assert not is_monitorable("capital:paper", "paper")
    assert not is_monitorable("mt5:live", "live")
    assert not is_monitorable("mt5-self:live", "live")


def test_account_label():
    assert account_label("capital-live:live") == "Capital live"
    assert account_label("ig-demo:demo") == "IG demo"
    assert account_label("weird:env") == "weird:env"


def test_hysteresis():
    assert hysteresis("marginLevel", 120) == 3
    assert hysteresis("drawdown", 10) == 3
    assert hysteresis("equity", 5000) == 100
    assert hysteresis("openPnl", -500) == 10


def test_falling_metric_fires_most_severe_once():
    fired, newly = evaluate_tiers("marginLevel", TIERS, 110.0, set())
    assert fired == {150, 120} and newly == 120
    fired, newly = evaluate_tiers("marginLevel", TIERS, 110.0, fired)
    assert newly is None and fired == {150, 120}


def test_rearm_needs_hysteresis():
    fired = {150, 120}
    fired, newly = evaluate_tiers("marginLevel", TIERS, 122.0, fired)
    assert fired == {150, 120} and newly is None          # within 3 points, still fired
    fired, newly = evaluate_tiers("marginLevel", TIERS, 123.5, fired)
    assert fired == {150} and newly is None               # re-armed 120
    fired, newly = evaluate_tiers("marginLevel", TIERS, 119.0, fired)
    assert newly == 120                                   # fires again


def test_drawdown_rises():
    tiers = [{"level": 5, "label": "warn"}, {"level": 10, "label": "danger"}]
    fired, newly = evaluate_tiers("drawdown", tiers, 6.0, set())
    assert fired == {5} and newly == 5
    fired, newly = evaluate_tiers("drawdown", tiers, 1.5, fired)
    assert fired == set()


def test_crossed_now_seeds_without_firing():
    assert crossed_now("marginLevel", TIERS, 130.0) == {150}
    assert crossed_now("drawdown", [{"level": 5, "label": "warn"}], 2.0) == set()


def test_near_tier():
    assert near_tier("marginLevel", TIERS, 175.0, set())          # 150 within 20% of 150
    assert not near_tier("marginLevel", TIERS, 190.0, set())
    assert near_tier("marginLevel", TIERS, 130.0, {150})          # next unfired is 120
    assert not near_tier("marginLevel", TIERS, 90.0, {150, 120, 100})  # none left
    assert near_tier("openPnl", [{"level": -500, "label": "warn"}], -420.0, set())


def test_headline():
    assert headline("marginLevel", 118.4, 120, "danger", "capital-live:live", "EUR", 4210.0) == \
        "MARGIN LEVEL 118.4% < 120% (danger) · Capital live · equity 4,210 EUR"
    assert headline("drawdown", 6.2, 5, "warn", "ig-live:live", "GBP", None) == \
        "DRAWDOWN 6.2% > 5% (warn) · IG live"
    assert headline("equity", 4980.5, 5000, "warn", "capital:demo", "EUR", 4980.5) == \
        "EQUITY 4,980.50 EUR < 5,000 EUR (warn) · Capital demo"
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_account_alert_kind.py -q`
Expected: ImportError.

- [ ] **Step 3: Implement**

```python
# backend/auto_trader/core/account_alert_kind.py
"""The `account` alert kind: validation, duplicate signature and the tier
state machine. Deliberately NOT registered in `alert_kinds.KINDS`: the price
engine calls bar_resolution/indicator_key on every kind it holds and an
account alert has no bars. The router dispatches on kind == "account" and
`AccountMonitor` is the only evaluator."""
from __future__ import annotations

import json
import math

MONITORABLE_BROKERS = frozenset({"capital", "capital-live", "ig-demo", "ig-live"})
_ACCOUNT_LABELS = {"capital": "Capital demo", "capital-live": "Capital live",
                   "ig-demo": "IG demo", "ig-live": "IG live"}
METRICS = ("marginLevel", "openPnl", "openPnlPct", "equity", "available", "drawdown")
FALLING = frozenset({"marginLevel", "equity", "available", "openPnl", "openPnlPct"})
PCT_METRICS = frozenset({"marginLevel", "openPnlPct", "drawdown"})
TIER_LABELS = ("warn", "danger", "critical")
BASELINES = ("daily", "sinceCreated")
METRIC_LABELS = {"marginLevel": "MARGIN LEVEL", "openPnl": "OPEN P/L", "openPnlPct": "OPEN P/L %",
                 "equity": "EQUITY", "available": "AVAILABLE", "drawdown": "DRAWDOWN"}
NEAR_FRACTION = 0.2


def account_label(key: str) -> str:
    return _ACCOUNT_LABELS.get(key.split(":", 1)[0], key)


def is_monitorable(key: str, env: str) -> bool:
    return key.split(":", 1)[0] in MONITORABLE_BROKERS and env != "paper"


def cash_balance(key: str) -> bool:
    """IG's balance excludes open P/L; Capital's includes it (accountStats.ts:91)."""
    return key.split(":", 1)[0].startswith("ig")


def _finite(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


class AccountAlertKind:
    def validate(self, params: dict) -> None:
        metric = params.get("metric")
        if metric not in METRICS:
            raise ValueError(f"unknown account metric: {metric!r}")
        tiers = params.get("tiers")
        if not isinstance(tiers, list) or not 1 <= len(tiers) <= 3:
            raise ValueError("tiers must hold 1 to 3 entries")
        levels: list[float] = []
        for t in tiers:
            if not isinstance(t, dict) or not _finite(t.get("level")) or t.get("label") not in TIER_LABELS:
                raise ValueError("each tier needs a finite level and a label of warn, danger or critical")
            levels.append(float(t["level"]))
        ordered = levels == sorted(levels, reverse=metric in FALLING) and len(set(levels)) == len(levels)
        if not ordered:
            raise ValueError("tiers must be strictly ordered in the firing direction")
        if metric == "drawdown":
            if params.get("baseline") not in BASELINES:
                raise ValueError("drawdown needs baseline daily or sinceCreated")
            if any(lv <= 0 for lv in levels):
                raise ValueError("drawdown tiers are positive percentages")
        elif "baseline" in params and params["baseline"] is not None:
            raise ValueError("baseline only applies to drawdown")

    def sig(self, params: dict) -> str:
        levels = sorted(float(t["level"]) for t in params["tiers"])
        return json.dumps([params["metric"], params.get("baseline"), levels])


ACCOUNT_KIND = AccountAlertKind()


def hysteresis(metric: str, level: float) -> float:
    return 3.0 if metric in PCT_METRICS else abs(level) * 0.02


def _past(metric: str, value: float, level: float) -> bool:
    return value < level if metric in FALLING else value > level


def _recovered(metric: str, value: float, level: float) -> bool:
    band = hysteresis(metric, level)
    return value >= level + band if metric in FALLING else value <= level - band


def _severity(tiers: list[dict]) -> dict[float, int]:
    return {float(t["level"]): TIER_LABELS.index(t["label"]) for t in tiers}


def crossed_now(metric: str, tiers: list[dict], value: float) -> set[float]:
    return {float(t["level"]) for t in tiers if _past(metric, value, float(t["level"]))}


def evaluate_tiers(
    metric: str, tiers: list[dict], value: float, fired: set[float]
) -> tuple[set[float], float | None]:
    levels = {float(t["level"]) for t in tiers}
    new_fired = {lv for lv in fired if lv in levels and not _recovered(metric, value, lv)}
    newly = [lv for lv in levels if lv not in new_fired and _past(metric, value, lv)]
    new_fired |= set(newly)
    if not newly:
        return new_fired, None
    sev = _severity(tiers)
    return new_fired, max(newly, key=lambda lv: sev[lv])


def near_tier(metric: str, tiers: list[dict], value: float, fired: set[float]) -> bool:
    pending = [float(t["level"]) for t in tiers
               if float(t["level"]) not in fired and not _past(metric, value, float(t["level"]))]
    if not pending:
        return False
    nxt = max(pending) if metric in FALLING else min(pending)
    return abs(value - nxt) <= NEAR_FRACTION * max(abs(nxt), 1e-9)


def tier_label(tiers: list[dict], level: float) -> str:
    return next((t["label"] for t in tiers if float(t["level"]) == level), "warn")


def fmt_value(metric: str, value: float, currency: str | None) -> str:
    if metric in PCT_METRICS:
        return f"{value:.1f}%" if value != int(value) else f"{int(value)}%"
    amount = f"{value:,.2f}" if value != int(value) else f"{int(value):,}"
    return f"{amount} {currency}" if currency else amount


def headline(
    metric: str, value: float, level: float, label: str, key: str,
    currency: str | None, equity: float | None,
) -> str:
    op = "<" if metric in FALLING else ">"
    parts = [f"{METRIC_LABELS[metric]} {fmt_value(metric, value, currency)} {op} "
             f"{fmt_value(metric, level, currency)} ({label})", account_label(key)]
    if metric != "equity" and equity is not None:
        parts.append(f"equity {fmt_value('equity', equity, currency)}")
    return " · ".join(parts)
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && uv run pytest tests/test_account_alert_kind.py -q`
Expected: all passed. If `test_headline`'s equity case differs only in `4,980.50` formatting, adjust `fmt_value`, not the test.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/account_alert_kind.py backend/tests/test_account_alert_kind.py
git commit -m "feat(alerts): account alert kind with tier state machine"
```

---

### Task 3: Store `delete_meta` and engine skips account rows

**Files:**
- Modify: `backend/auto_trader/core/alert_store.py` (after `set_meta`, around line 398)
- Modify: `backend/auto_trader/core/alert_engine.py:199-202`
- Test: `backend/tests/test_alert_store.py`, `backend/tests/test_alert_engine.py`

**Interfaces:**
- Produces: `AlertStore.delete_meta(user_id: str, key: str) -> None`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_alert_store.py`:

```python
def test_delete_meta(tmp_path):
    store = AlertStore(str(tmp_path / "a.db"))
    asyncio.run(store.set_meta(USER, "account:al-1", "{}"))
    asyncio.run(store.delete_meta(USER, "account:al-1"))
    assert asyncio.run(store.get_meta(USER, "account:al-1")) is None
    asyncio.run(store.delete_meta(USER, "account:never"))  # no raise
```

Append to `backend/tests/test_alert_engine.py`:

```python
def test_start_ignores_account_rows(tmp_path):
    async def main():
        eng, store, sent, notified = make_engine(tmp_path)
        await store.create("u1", row(id="al-acct", broker="capital-live:live", epic="", kind="account",
                                     params={"metric": "marginLevel", "tiers": [{"level": 120, "label": "warn"}]}))
        await store.create("u1", row())
        await eng.start()
        try:
            assert eng.feeds_needed() == {("capital", "US100")}
            assert "al-acct" not in eng.statuses("u1")
        finally:
            await eng.stop()
    asyncio.run(main())
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_alert_store.py::test_delete_meta tests/test_alert_engine.py::test_start_ignores_account_rows -q`
Expected: AttributeError `delete_meta`; the engine test fails on `feeds_needed` containing `("capital-live:live", "")`.

- [ ] **Step 3: Implement**

In `alert_store.py` after `_set_meta_sync`:

```python
    async def delete_meta(self, user_id: str, key: str) -> None:
        await asyncio.to_thread(self._delete_meta_sync, user_id, key)

    def _delete_meta_sync(self, user_id: str, key: str) -> None:
        conn = self._connect()
        try:
            conn.execute("DELETE FROM alert_meta WHERE user_id = ? AND key = ?", (user_id, key))
            conn.commit()
        finally:
            conn.close()
```

In `alert_engine.py` `start()`:

```python
        all_rows = await self._store.list_all()
        for user_id, row in all_rows:
            # Account alerts have no price feed; AccountMonitor owns them. Letting
            # one in here would spawn a feed loop for ("capital-live:live", "")
            # that 404s on get_data forever.
            if row.get("kind") == "account":
                continue
            key = (row["broker"], row["epic"])
            self._registry.setdefault(key, []).append((user_id, row))
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && uv run pytest tests/test_alert_store.py tests/test_alert_engine.py -q`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/alert_store.py backend/auto_trader/core/alert_engine.py backend/tests/test_alert_store.py backend/tests/test_alert_engine.py
git commit -m "feat(alerts): store delete_meta; price engine skips account rows"
```

---

### Task 4: AccountMonitor

**Files:**
- Create: `backend/auto_trader/core/account_monitor.py`
- Test: `backend/tests/test_account_monitor.py`

**Interfaces:**
- Consumes: Task 1 `account_metrics`, Task 2 kind functions, Task 3 `delete_meta`.
- Produces:
  ```python
  NORMAL_S = 30.0; FAST_S = 5.0; UNMONITORED_AFTER_S = 120.0; FETCH_TIMEOUT_S = 15.0
  class AccountMonitor:
      def configure(self, store, get_exec: Callable[[str], Any], broadcast, notifiers: list,
                    *, clock: Callable[[], float] = time.time, sleep=asyncio.sleep,
                    today: Callable[[], str] = lambda: date.today().isoformat()) -> None
      async def start(self) -> None; async def stop(self) -> None
      def on_alert_changed(self, user_id: str, row: dict | None, alert_id: str) -> None
      def statuses(self, user_id: str) -> dict[str, dict]   # alert_id -> {current, firedTiers, monitored, unmonitoredReason}
      def account_status(self, account: str) -> dict        # {monitored, unmonitoredReason, metrics: dict | None}
      async def metrics_for(self, account: str) -> dict     # polls once when nothing cached
      async def poll_once(self, account: str) -> float      # one cycle; returns the next delay (test seam)
  ACCOUNT_MONITOR = AccountMonitor()
  ```
  Fire payload keys (consumed by Tasks 6, 7, 9): `id, broker (=account key), epic (""), kind ("account"), price (value), level, condition ("below"|"above"), message, precision (2), notify, time, triggered_id, metric, tierLabel, account, headline, currency, equity, critical (bool)`.
  Monitor payload (`kind: "account_status"`): `id ("monitor:<account>"), broker, epic (""), status ("unmonitored"|"resumed"), reason, headline, notify ({push, telegram, toast, browser, sound: True}), message (""), precision 2, price 0, level 0, condition ""`; broadcast under key `__alerts__:monitor`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_account_monitor.py
"""AccountMonitor: tier firing, re-arm, drawdown, watchdog, expiry, restart."""
from __future__ import annotations

import asyncio
import json

import pytest

from auto_trader.core.account_monitor import FAST_S, NORMAL_S, AccountMonitor
from auto_trader.core.alert_store import AlertStore
from auto_trader.core.models import Position, Side

ACCT = "capital-live:live"
TIERS = [{"level": 150, "label": "warn"}, {"level": 120, "label": "danger"}, {"level": 100, "label": "critical"}]


class FakeExec:
    env = "live"

    def __init__(self):
        self.summary = {"balance": 2000.0, "available": 1000.0, "deposit": 0, "profitLoss": 0.0, "currency": "EUR"}
        self.positions = [Position(epic="US100", side=Side.BUY, quantity=1, open_level=1, deal_id="d", upnl=0.0, margin=1000.0)]
        self.fail: Exception | None = None

    def set_margin_level(self, pct: float):
        # equity = available + margin; margin fixed at 1000 -> available = pct*10 - 1000
        self.summary["available"] = pct * 10 - 1000.0

    async def get_account_summary(self):
        if self.fail:
            raise self.fail
        return dict(self.summary)

    async def get_positions(self, epic=None):
        if self.fail:
            raise self.fail
        return list(self.positions)


class Harness:
    def __init__(self, tmp_path):
        self.store = AlertStore(str(tmp_path / "alerts.db"))
        self.exec = FakeExec()
        self.sent: list[tuple[str, dict]] = []
        self.notified: list[tuple[str, dict]] = []
        self.now = 1_000_000.0
        self.day = "2026-10-30"
        self.mon = AccountMonitor()
        self.mon.configure(
            store=self.store, get_exec=lambda k: self.exec,
            broadcast=self._bcast, notifiers=[self._notify],
            clock=lambda: self.now, sleep=self._sleep, today=lambda: self.day,
        )

    async def _bcast(self, uid, msg): self.sent.append((uid, msg))
    async def _notify(self, uid, p): self.notified.append((uid, p))
    async def _sleep(self, s): await asyncio.sleep(0)

    def fired(self):
        return [p for _, p in self.notified if p.get("kind") == "account"]

    def status_msgs(self):
        return [p for _, p in self.notified if p.get("kind") == "account_status"]

    async def add(self, **kw):
        row = {"id": "al-1", "broker": ACCT, "epic": "", "kind": "account",
               "params": {"metric": "marginLevel", "tiers": TIERS}, "message": "",
               "expires_at": None, "notify": {"push": True, "telegram": True}, "precision": 2, "active": 1}
        row.update(kw)
        created = await self.store.create("u1", row)
        self.mon.on_alert_changed("u1", created, created["id"])
        return created


def run(coro):
    return asyncio.run(coro)


def test_fires_most_severe_tier_once_and_rearms(tmp_path):
    async def main():
        h = Harness(tmp_path)
        h.exec.set_margin_level(200)
        await h.add()
        await h.mon.poll_once(ACCT)          # seeds, nothing fired
        assert h.fired() == []
        h.exec.set_margin_level(110)
        await h.mon.poll_once(ACCT)
        assert [p["level"] for p in h.fired()] == [120]
        assert h.fired()[0]["tierLabel"] == "danger" and h.fired()[0]["condition"] == "below"
        assert "MARGIN LEVEL 110% < 120% (danger)" in h.fired()[0]["headline"]
        await h.mon.poll_once(ACCT)          # still below: no repeat
        assert len(h.fired()) == 1
        h.exec.set_margin_level(124)         # re-arms 120 (3-point band)
        await h.mon.poll_once(ACCT)
        h.exec.set_margin_level(118)
        await h.mon.poll_once(ACCT)
        assert [p["level"] for p in h.fired()] == [120, 120]
        st = h.mon.statuses("u1")["al-1"]
        assert st["firedTiers"] == [150, 120] and st["monitored"] and st["current"] == pytest.approx(118)
        assert [m for _, m in h.sent if m["key"] == "__alerts__:fired"]
        triggered = await h.store.list_triggered("u1")
        assert triggered and triggered[0]["kind"] == "account"
    run(main())


def test_created_past_a_tier_does_not_fire(tmp_path):
    async def main():
        h = Harness(tmp_path)
        h.exec.set_margin_level(130)
        await h.add()
        await h.mon.poll_once(ACCT)
        assert h.fired() == []
        assert h.mon.statuses("u1")["al-1"]["firedTiers"] == [150]
    run(main())


def test_adaptive_delay(tmp_path):
    async def main():
        h = Harness(tmp_path)
        h.exec.set_margin_level(300)
        await h.add()
        assert await h.mon.poll_once(ACCT) == NORMAL_S
        h.exec.set_margin_level(170)
        assert await h.mon.poll_once(ACCT) == FAST_S
    run(main())


def test_no_positions_holds_state_and_stays_monitored(tmp_path):
    async def main():
        h = Harness(tmp_path)
        h.exec.set_margin_level(110)
        await h.add()
        await h.mon.poll_once(ACCT)
        h.exec.positions = []
        await h.mon.poll_once(ACCT)
        st = h.mon.statuses("u1")["al-1"]
        assert st["firedTiers"] == [150, 120] and st["monitored"] and st["current"] is None
        assert h.status_msgs() == []
    run(main())


def test_missing_figure_reports_unmonitored_then_resumed(tmp_path):
    async def main():
        h = Harness(tmp_path)
        await h.add()
        h.exec.summary["available"] = None
        await h.mon.poll_once(ACCT)
        msgs = h.status_msgs()
        assert len(msgs) == 1 and msgs[0]["status"] == "unmonitored" and "missing available" in msgs[0]["reason"]
        assert msgs[0]["notify"]["push"] and msgs[0]["notify"]["telegram"]
        assert h.mon.statuses("u1")["al-1"]["monitored"] is False
        await h.mon.poll_once(ACCT)          # still missing: no repeat
        assert len(h.status_msgs()) == 1
        h.exec.summary["available"] = 1000.0
        await h.mon.poll_once(ACCT)
        assert h.status_msgs()[-1]["status"] == "resumed"
        assert [m for _, m in h.sent if m["key"] == "__alerts__:monitor"]
    run(main())


def test_broker_failure_watchdog_after_120s(tmp_path):
    async def main():
        h = Harness(tmp_path)
        await h.add()
        await h.mon.poll_once(ACCT)
        h.exec.fail = RuntimeError("session dropped")
        h.now += 60
        await h.mon.poll_once(ACCT)
        assert h.status_msgs() == []
        h.now += 61
        await h.mon.poll_once(ACCT)
        assert len(h.status_msgs()) == 1 and "session dropped" in h.status_msgs()[0]["reason"]
        h.now += 30
        await h.mon.poll_once(ACCT)
        assert len(h.status_msgs()) == 1
    run(main())


def test_unknown_account_reported_once(tmp_path):
    async def main():
        h = Harness(tmp_path)
        from fastapi import HTTPException
        def get_exec(k): raise HTTPException(422, "unknown account")
        h.mon.configure(store=h.store, get_exec=get_exec, broadcast=h._bcast, notifiers=[h._notify],
                        clock=lambda: h.now, sleep=h._sleep, today=lambda: h.day)
        await h.add()
        h.now += 200
        await h.mon.poll_once(ACCT)
        await h.mon.poll_once(ACCT)
        assert len(h.status_msgs()) == 1
    run(main())


def test_drawdown_daily_and_since_created(tmp_path):
    async def main():
        h = Harness(tmp_path)
        h.exec.set_margin_level(200)   # equity 2000
        await h.add(id="al-d", params={"metric": "drawdown", "baseline": "daily", "tiers": [{"level": 5, "label": "warn"}]})
        await h.add(id="al-s", params={"metric": "drawdown", "baseline": "sinceCreated", "tiers": [{"level": 5, "label": "warn"}]})
        await h.mon.poll_once(ACCT)                       # seeds peaks at 2000
        h.exec.set_margin_level(188)                      # equity 1880 = 6% down
        await h.mon.poll_once(ACCT)
        assert sorted(p["id"] for p in h.fired()) == ["al-d", "al-s"]
        h.day = "2026-10-31"                              # daily peak resets to first equity of the day
        await h.mon.poll_once(ACCT)
        st = h.mon.statuses("u1")
        assert st["al-d"]["current"] == pytest.approx(0) and st["al-d"]["firedTiers"] == []
        assert st["al-s"]["current"] == pytest.approx(6) and st["al-s"]["firedTiers"] == [5]
    run(main())


def test_patch_tiers_keeps_state_patch_baseline_resets_peak(tmp_path):
    async def main():
        h = Harness(tmp_path)
        h.exec.set_margin_level(110)
        row = await h.add()
        await h.mon.poll_once(ACCT)                       # seeded {150,120}
        patched = await h.store.update("u1", "al-1", {"params": {"tiers": TIERS[1:]}})
        h.mon.on_alert_changed("u1", patched, "al-1")
        await h.mon.poll_once(ACCT)
        assert h.mon.statuses("u1")["al-1"]["firedTiers"] == [120] and h.fired() == []
        h.exec.set_margin_level(200)
        d = await h.add(id="al-d", params={"metric": "drawdown", "baseline": "sinceCreated", "tiers": [{"level": 5, "label": "warn"}]})
        await h.mon.poll_once(ACCT)
        h.exec.set_margin_level(180)
        await h.mon.poll_once(ACCT)
        assert h.mon.statuses("u1")["al-d"]["current"] == pytest.approx(10)
        p2 = await h.store.update("u1", "al-d", {"params": {"baseline": "daily"}})
        h.mon.on_alert_changed("u1", p2, "al-d")
        await h.mon.poll_once(ACCT)
        assert h.mon.statuses("u1")["al-d"]["current"] == pytest.approx(0)
    run(main())


def test_expiry_deletes_and_broadcasts(tmp_path):
    async def main():
        h = Harness(tmp_path)
        await h.add(expires_at=int(h.now * 1000) + 1000)
        await h.mon.poll_once(ACCT)
        h.now += 2
        await h.mon.poll_once(ACCT)
        assert await h.store.list_user("u1") == []
        assert any(m["key"] == "__alerts__:changed" and m["value"]["origin"] == "engine" for _, m in h.sent)
        assert await h.store.get_meta("u1", "account:al-1") is None
    run(main())


def test_delete_stops_task_and_drops_meta(tmp_path):
    async def main():
        h = Harness(tmp_path)
        await h.add()
        await h.mon.start()
        try:
            await asyncio.sleep(0)
            assert ACCT in h.mon._tasks
            await h.store.delete("u1", "al-1")
            h.mon.on_alert_changed("u1", None, "al-1")
            await asyncio.sleep(0)
            assert ACCT not in h.mon._tasks
            assert await h.store.get_meta("u1", "account:al-1") is None
        finally:
            await h.mon.stop()
    run(main())


def test_restart_keeps_fired_state(tmp_path):
    async def main():
        h = Harness(tmp_path)
        h.exec.set_margin_level(110)
        await h.add()
        await h.mon.poll_once(ACCT)
        h.exec.set_margin_level(118)
        await h.mon.poll_once(ACCT)
        assert len(h.fired()) == 0          # seeded past 120, never fired
        h.exec.set_margin_level(130)
        await h.mon.poll_once(ACCT)
        h.exec.set_margin_level(110)
        await h.mon.poll_once(ACCT)
        assert len(h.fired()) == 1
        # new monitor over the same store: state comes from alert_meta
        h2 = Harness(tmp_path)
        h2.exec.set_margin_level(110)
        await h2.mon.start()
        try:
            await asyncio.sleep(0.05)
            assert h2.fired() == []
            assert h2.mon.statuses("u1")["al-1"]["firedTiers"] == [150, 120]
        finally:
            await h2.mon.stop()
    run(main())


def test_raising_cycle_does_not_kill_loop(tmp_path):
    async def main():
        h = Harness(tmp_path)
        await h.add()
        calls = {"n": 0}
        orig = h.mon.poll_once
        async def boom(acct):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("bug")
            return await orig(acct)
        h.mon.poll_once = boom  # type: ignore[method-assign]
        await h.mon.start()
        try:
            await asyncio.sleep(0.05)
            assert calls["n"] >= 2
        finally:
            await h.mon.stop()
    run(main())


def test_metrics_for_polls_once(tmp_path):
    async def main():
        h = Harness(tmp_path)
        h.exec.set_margin_level(150)
        m = await h.mon.metrics_for(ACCT)
        assert m["marginLevel"] == pytest.approx(150) and m["currency"] == "EUR"
    run(main())
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_account_monitor.py -q`
Expected: ImportError.

- [ ] **Step 3: Implement**

```python
# backend/auto_trader/core/account_monitor.py
"""Server-side evaluation of `account` alerts: one poll loop per monitorable
account with at least one active alert, independent of any browser tab and of
which account the app has selected. Reads broker figures through the account's
ExecutionBroker (which already shares the broker's rate limiter), judges tiers
with account_alert_kind, writes triggered history and fans out through the same
broadcast + notifiers as the price engine. Never touches positions."""
from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Awaitable, Callable
from datetime import date
from typing import Any

from auto_trader.core.account_alert_kind import (
    account_label, cash_balance, crossed_now, evaluate_tiers, headline, near_tier, tier_label,
)
from auto_trader.core.account_metrics import AccountMetrics, account_metrics
from auto_trader.core.alert_store import AlertStore

log = logging.getLogger(__name__)

NORMAL_S = 30.0
FAST_S = 5.0
UNMONITORED_AFTER_S = 120.0
FETCH_TIMEOUT_S = 15.0
ALL_CHANNELS = {"toast": True, "browser": True, "sound": True, "push": True, "telegram": True}

Notifier = Callable[[str, dict], Awaitable[None]]


def _meta_key(alert_id: str) -> str:
    return f"account:{alert_id}"


class AccountMonitor:
    def __init__(self) -> None:
        self._store: AlertStore | None = None
        self._get_exec: Callable[[str], Any] | None = None
        self._broadcast: Callable[[str, dict], Awaitable[None]] | None = None
        self._notifiers: list[Notifier] = []
        self._clock: Callable[[], float] = time.time
        self._sleep = asyncio.sleep
        self._today: Callable[[], str] = lambda: date.today().isoformat()
        # account -> [(user_id, row)]
        self._alerts: dict[str, list[tuple[str, dict]]] = {}
        # (user_id, alert_id) -> {"fired": [..], "seeded": bool, "peak": float|None, "peakDay": str|None}
        self._state: dict[tuple[str, str], dict] = {}
        self._tasks: dict[str, asyncio.Task] = {}
        self._latest: dict[str, AccountMetrics] = {}
        self._last_ok: dict[str, float] = {}
        self._first_fail: dict[str, float] = {}
        self._unmonitored: dict[str, str] = {}

    def configure(
        self, store: AlertStore, get_exec: Callable[[str], Any],
        broadcast: Callable[[str, dict], Awaitable[None]], notifiers: list[Notifier] | None = None,
        *, clock: Callable[[], float] = time.time, sleep=asyncio.sleep,
        today: Callable[[], str] | None = None,
    ) -> None:
        self._store = store
        self._get_exec = get_exec
        self._broadcast = broadcast
        self._notifiers = notifiers if notifiers is not None else []
        self._clock = clock
        self._sleep = sleep
        if today is not None:
            self._today = today

    # ---- lifecycle ----

    async def start(self) -> None:
        assert self._store is not None
        self._alerts.clear()
        self._state.clear()
        self._latest.clear()
        self._last_ok.clear()
        self._first_fail.clear()
        self._unmonitored.clear()
        for user_id, row in await self._store.list_all():
            if row.get("kind") == "account":
                self._alerts.setdefault(row["broker"], []).append((user_id, row))
                await self._load_state(user_id, row["id"])
        self._reconcile()

    async def stop(self) -> None:
        tasks = list(self._tasks.values())
        self._tasks = {}
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    def _reconcile(self) -> None:
        needed = {acct for acct, rows in self._alerts.items() if any(r.get("active", 1) for _, r in rows)}
        for acct in list(self._tasks):
            if acct not in needed:
                self._tasks.pop(acct).cancel()
        for acct in needed - set(self._tasks):
            self._tasks[acct] = asyncio.create_task(self._loop(acct))

    async def _loop(self, account: str) -> None:
        while True:
            try:
                delay = await self.poll_once(account)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("account monitor: cycle failed for %s", account)
                delay = NORMAL_S
            await self._sleep(delay)

    # ---- registry ----

    def on_alert_changed(self, user_id: str, row: dict | None, alert_id: str) -> None:
        prev: dict | None = None
        for acct, entries in list(self._alerts.items()):
            for u, r in entries:
                if u == user_id and r["id"] == alert_id:
                    prev = r
            kept = [(u, r) for (u, r) in entries if not (u == user_id and r["id"] == alert_id)]
            if kept:
                self._alerts[acct] = kept
            else:
                del self._alerts[acct]
        key = (user_id, alert_id)
        if row is None:
            self._state.pop(key, None)
            asyncio.get_event_loop().create_task(self._store.delete_meta(user_id, _meta_key(alert_id)))  # type: ignore[union-attr]
        else:
            self._alerts.setdefault(row["broker"], []).append((user_id, row))
            st = self._state.get(key)
            if st is not None and prev is not None:
                new_levels = {float(t["level"]) for t in row["params"]["tiers"]}
                st["fired"] = [lv for lv in st["fired"] if lv in new_levels]
                if row["params"].get("baseline") != prev["params"].get("baseline"):
                    st["peak"] = None
                    st["peakDay"] = None
                asyncio.get_event_loop().create_task(self._save_state(user_id, alert_id))
        try:
            self._reconcile()
        except RuntimeError:
            pass  # no running loop (router unit tests); start() reconciles

    # ---- state ----

    async def _load_state(self, user_id: str, alert_id: str) -> dict:
        key = (user_id, alert_id)
        if key not in self._state:
            raw = await self._store.get_meta(user_id, _meta_key(alert_id))  # type: ignore[union-attr]
            self._state[key] = json.loads(raw) if raw else {"fired": [], "seeded": False, "peak": None, "peakDay": None}
        return self._state[key]

    async def _save_state(self, user_id: str, alert_id: str) -> None:
        st = self._state.get((user_id, alert_id))
        if st is not None:
            await self._store.set_meta(user_id, _meta_key(alert_id), json.dumps(st))  # type: ignore[union-attr]

    # ---- status for the API ----

    def account_status(self, account: str) -> dict:
        reason = self._unmonitored.get(account)
        m = self._latest.get(account)
        return {"monitored": reason is None, "unmonitoredReason": reason, "metrics": _metrics_dict(m) if m else None}

    def statuses(self, user_id: str) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for acct, entries in self._alerts.items():
            reason = self._unmonitored.get(acct)
            for u, row in entries:
                if u != user_id:
                    continue
                st = self._state.get((u, row["id"]), {})
                out[row["id"]] = {
                    "current": self._current(acct, row, st),
                    "firedTiers": list(st.get("fired", [])),
                    "monitored": reason is None,
                    "unmonitoredReason": reason,
                }
        return out

    def _current(self, account: str, row: dict, st: dict) -> float | None:
        m = self._latest.get(account)
        if m is None:
            return None
        metric = row["params"]["metric"]
        if metric == "drawdown":
            peak = st.get("peak")
            return None if not peak or m.equity is None else (peak - m.equity) / peak * 100
        return m.value_of(metric)

    async def metrics_for(self, account: str) -> dict:
        if account not in self._latest:
            await self.poll_once(account)
        m = self._latest.get(account)
        return _metrics_dict(m) if m else {}

    # ---- one cycle ----

    async def poll_once(self, account: str) -> float:
        assert self._store is not None and self._get_exec is not None
        now = self._clock()
        try:
            exec_broker = self._get_exec(account)
            summary, positions = await asyncio.wait_for(
                asyncio.gather(exec_broker.get_account_summary(), exec_broker.get_positions()),
                timeout=FETCH_TIMEOUT_S,
            )
        except Exception as exc:
            await self._note_failure(account, str(exc) or exc.__class__.__name__, now)
            return NORMAL_S
        metrics = account_metrics(summary, positions, cash_balance=cash_balance(account))
        if metrics.missing:
            self._latest[account] = metrics
            await self._note_failure(account, "missing " + ", ".join(metrics.missing), now, immediate=True)
            return NORMAL_S
        self._latest[account] = metrics
        self._last_ok[account] = now
        self._first_fail.pop(account, None)
        if account in self._unmonitored:
            del self._unmonitored[account]
            await self._status_message(account, "resumed", "")

        fast = False
        for user_id, row in list(self._alerts.get(account, [])):
            if not row.get("active", 1):
                continue
            expires_at = row.get("expires_at")
            if expires_at is not None and expires_at <= now * 1000:
                await self._expire(user_id, row)
                continue
            st = await self._load_state(user_id, row["id"])
            params = row["params"]
            metric, tiers = params["metric"], params["tiers"]
            value = self._value(metric, params, metrics, st)
            if value is None:
                continue
            fired = set(st["fired"])
            if not st.get("seeded"):
                fired = crossed_now(metric, tiers, value)
                st.update(seeded=True, fired=sorted(fired, reverse=True))
                await self._save_state(user_id, row["id"])
            else:
                new_fired, newly = evaluate_tiers(metric, tiers, value, fired)
                if new_fired != fired:
                    st["fired"] = sorted(new_fired, reverse=True)
                    await self._save_state(user_id, row["id"])
                if newly is not None:
                    await self._fire(user_id, row, value, newly, metrics)
                fired = new_fired
            if near_tier(metric, tiers, value, fired):
                fast = True
        return FAST_S if fast else NORMAL_S

    def _value(self, metric: str, params: dict, m: AccountMetrics, st: dict) -> float | None:
        if metric != "drawdown":
            return m.value_of(metric)
        if m.equity is None:
            return None
        today = self._today()
        if params.get("baseline") == "daily" and st.get("peakDay") != today:
            st["peak"], st["peakDay"] = m.equity, today
        if st.get("peak") is None or m.equity > st["peak"]:
            st["peak"] = m.equity
        return (st["peak"] - m.equity) / st["peak"] * 100 if st["peak"] else None

    # ---- failure / watchdog ----

    async def _note_failure(self, account: str, reason: str, now: float, *, immediate: bool = False) -> None:
        if account in self._unmonitored:
            return
        if not immediate:
            self._first_fail.setdefault(account, now)
            last_ok = self._last_ok.get(account, self._first_fail[account])
            if now - last_ok < UNMONITORED_AFTER_S:
                return
        self._unmonitored[account] = reason
        await self._status_message(account, "unmonitored", reason)

    async def _status_message(self, account: str, status: str, reason: str) -> None:
        label = account_label(account)
        text = (f"{label} is not being monitored: {reason}" if status == "unmonitored"
                else f"{label}: monitoring resumed")
        payload = {
            "id": f"monitor:{account}", "broker": account, "epic": "", "kind": "account_status",
            "status": status, "reason": reason, "headline": text, "notify": dict(ALL_CHANNELS),
            "message": "", "precision": 2, "price": 0, "level": 0, "condition": "",
            "time": int(self._clock() * 1000),
        }
        for user_id in {u for u, _ in self._alerts.get(account, [])}:
            await self._broadcast(user_id, {"key": "__alerts__:monitor", "value": payload})  # type: ignore[misc]
            for n in self._notifiers:
                try:
                    await n(user_id, payload)
                except Exception:
                    log.warning("account monitor: notifier failed for %s", account, exc_info=True)

    # ---- fire / expire ----

    async def _fire(self, user_id: str, row: dict, value: float, level: float, m: AccountMetrics) -> None:
        assert self._store is not None and self._broadcast is not None
        params = row["params"]
        metric, tiers = params["metric"], params["tiers"]
        label = tier_label(tiers, level)
        condition = "above" if metric == "drawdown" else "below"
        now_ms = int(self._clock() * 1000)
        text = headline(metric, value, level, label, row["broker"], m.currency, m.equity)
        triggered_id = await self._store.add_triggered(user_id, {
            "time": now_ms, "alert_id": row["id"], "broker": row["broker"], "epic": "",
            "kind": "account", "price": value, "level": level, "condition": condition,
            "message": row.get("message", ""), "precision": 2, "alert_json": json.dumps(row),
        })
        payload = {
            "id": row["id"], "broker": row["broker"], "epic": "", "kind": "account",
            "price": value, "level": level, "condition": condition,
            "message": row.get("message", ""), "precision": 2, "notify": row.get("notify", {}),
            "time": now_ms, "triggered_id": triggered_id, "metric": metric, "tierLabel": label,
            "account": row["broker"], "headline": text, "currency": m.currency, "equity": m.equity,
            "critical": label == "critical",
        }
        await self._broadcast(user_id, {"key": "__alerts__:fired", "value": payload})
        for n in self._notifiers:
            try:
                await n(user_id, payload)
            except Exception:
                log.warning("account alert notifier failed user=%s alert=%s", user_id, row["id"], exc_info=True)

    async def _expire(self, user_id: str, row: dict) -> None:
        assert self._store is not None and self._broadcast is not None
        await self._store.delete(user_id, row["id"])
        await self._store.delete_meta(user_id, _meta_key(row["id"]))
        self._state.pop((user_id, row["id"]), None)
        entries = [(u, r) for (u, r) in self._alerts.get(row["broker"], []) if not (u == user_id and r["id"] == row["id"])]
        if entries:
            self._alerts[row["broker"]] = entries
        else:
            self._alerts.pop(row["broker"], None)
        await self._broadcast(user_id, {"key": "__alerts__:changed",
                                        "value": {"broker": row["broker"], "epic": "", "origin": "engine"}})
        try:
            self._reconcile()
        except RuntimeError:
            pass


def _metrics_dict(m: AccountMetrics) -> dict:
    return {
        "balance": m.balance, "equity": m.equity, "margin": m.margin, "available": m.available,
        "openPnl": m.open_pnl, "marginLevel": m.margin_level, "openPnlPct": m.open_pnl_pct,
        "currency": m.currency,
    }


ACCOUNT_MONITOR = AccountMonitor()
```

Note for `test_delete_stops_task_and_drops_meta`: `on_alert_changed` with `row=None` is called from the running loop, so `create_task` works; in `_reconcile` the cancelled task is removed synchronously, which the test checks after one `sleep(0)`.

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && uv run pytest tests/test_account_monitor.py -q`
Expected: 14 passed. If `test_restart_keeps_fired_state` is flaky on the 0.05 s sleep, raise it to 0.2 s; nothing else.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/account_monitor.py backend/tests/test_account_monitor.py
git commit -m "feat(alerts): AccountMonitor polls accounts and fires tiered account alerts"
```

---

### Task 5: Router: account kind, admin gate, monitor routing, status, metrics endpoint

**Files:**
- Modify: `backend/auto_trader/api/routers/alerts.py`
- Test: `backend/tests/test_alerts_api.py`

**Interfaces:**
- Consumes: `ACCOUNT_KIND`, `is_monitorable`, `ACCOUNT_MONITOR` (`on_alert_changed`, `statuses`, `account_status`, `metrics_for`), `deps.require_admin`, `deps._registry.exec`.
- Produces: `GET /api/alerts/account-metrics?account=KEY` → `{account, monitored, unmonitoredReason, metrics: {balance, equity, margin, available, openPnl, marginLevel, openPnlPct, currency}}`; account rows in `GET /api/alerts` carry `current`, `firedTiers`, `monitored`, `unmonitoredReason`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_alerts_api.py`:

```python
# ---- account alerts -------------------------------------------------------

class _FakeExec:
    env = "live"
    is_real_money = True

    async def get_account_summary(self):
        return {"balance": 2000.0, "available": 500.0, "deposit": 0, "profitLoss": 0.0, "currency": "EUR"}

    async def get_positions(self, epic=None):
        from auto_trader.core.models import Position, Side
        return [Position(epic="US100", side=Side.BUY, quantity=1, open_level=1, deal_id="d", upnl=0.0, margin=1500.0)]


@pytest.fixture
def account_registry(monkeypatch):
    from auto_trader.brokers.registry import BrokerRegistry
    reg = BrokerRegistry()
    reg.exec["capital-live:live"] = _FakeExec()
    paper = _FakeExec(); paper.env = "paper"
    reg.exec["capital:paper"] = paper
    monkeypatch.setattr(deps_mod, "_registry", reg)
    return reg


@pytest.fixture
def admin(monkeypatch, clerk):
    from auto_trader.api import auth
    monkeypatch.setenv(auth.ADMIN_USER_IDS_ENV, "root")
    return _auth("root")


def _acct_body(**over):
    body = {"id": "al-acct", "broker": "capital-live:live", "epic": "", "kind": "account",
            "params": {"metric": "marginLevel", "tiers": [{"level": 150, "label": "warn"}, {"level": 120, "label": "danger"}]}}
    body.update(over)
    return body


def test_account_alert_requires_admin(clerk, account_registry):
    r = client.post("/api/alerts", json=_acct_body(), headers=_auth("alice"))
    assert r.status_code == 403


def test_account_alert_create_patch_list_delete(admin, account_registry):
    r = client.post("/api/alerts", json=_acct_body(), headers=admin)
    assert r.status_code == 200, r.text
    r = client.post("/api/alerts", json=_acct_body(id="al-dup"), headers=admin)
    assert r.status_code == 409
    r = client.get("/api/alerts", headers=admin)
    row = next(a for a in r.json()["alerts"] if a["id"] == "al-acct")
    assert row["monitored"] is True and row["firedTiers"] == [] and "current" in row
    r = client.patch("/api/alerts/al-acct", json={"params": {"tiers": [{"level": 110, "label": "critical"}]}}, headers=admin)
    assert r.status_code == 200 and r.json()["params"]["tiers"][0]["level"] == 110
    r = client.patch("/api/alerts/al-acct", json={"params": {"tiers": []}}, headers=admin)
    assert r.status_code == 422
    r = client.delete("/api/alerts/al-acct", headers=admin)
    assert r.status_code == 204


def test_account_alert_refuses_paper_and_unknown(admin, account_registry):
    r = client.post("/api/alerts", json=_acct_body(broker="capital:paper"), headers=admin)
    assert r.status_code == 422 and "account_not_monitorable" in r.text
    r = client.post("/api/alerts", json=_acct_body(broker="mt5:live"), headers=admin)
    assert r.status_code == 422


def test_account_metrics_endpoint(admin, account_registry):
    r = client.get("/api/alerts/account-metrics", params={"account": "capital-live:live"}, headers=admin)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["metrics"]["marginLevel"] == pytest.approx(2000 / 1500 * 100)
    assert body["metrics"]["currency"] == "EUR" and body["monitored"] is True
    r = client.get("/api/alerts/account-metrics", params={"account": "capital:paper"}, headers=admin)
    assert r.status_code == 422
    r = client.get("/api/alerts/account-metrics", params={"account": "capital-live:live"}, headers=_auth("alice"))
    assert r.status_code == 403
```

Also add `import pytest` at the top if missing (it is already imported).

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_alerts_api.py -k account -q`
Expected: `_validate_kind` 422s on `account` (first test gets 422 instead of 403), metrics endpoint 404s.

- [ ] **Step 3: Implement**

In `api/routers/alerts.py`:

Imports:

```python
from auto_trader.core.account_alert_kind import ACCOUNT_KIND, is_monitorable
from auto_trader.core.account_monitor import ACCOUNT_MONITOR
```

Replace `_decorate`, `_validate_kind`, `_validate_params`, `_check_duplicate`, `_notify`:

```python
def _decorate(row: dict) -> dict:
    if row.get("kind") == "indicator":
        try:
            row["label"] = INDICATOR.label(row["params"])
        except (KeyError, TypeError, ValueError):
            pass
    return row


def _validate_kind(kind: str) -> None:
    if kind not in KINDS and kind != "account":
        raise HTTPException(422, f"unknown alert kind: {kind!r}")


def _check_account(account: str) -> None:
    """An account alert's `broker` is an exec key the monitor can poll: a
    registered Capital/IG dealing account (never paper, never MT5)."""
    registry = deps._registry
    exec_broker = registry.exec.get(account) if registry is not None else None
    if exec_broker is None or not is_monitorable(account, exec_broker.env):
        raise HTTPException(422, "account_not_monitorable")


def _validate_params(kind: str, params: dict[str, Any], broker: str) -> None:
    try:
        if kind == "account":
            ACCOUNT_KIND.validate(params)
            _check_account(broker)
        else:
            KINDS[kind].validate(params, _streams(broker))
    except ValueError as e:
        raise HTTPException(422, str(e)) from None


def _sig(kind: str, params: dict[str, Any]) -> str:
    return ACCOUNT_KIND.sig(params) if kind == "account" else KINDS[kind].sig(params)


async def _check_duplicate(
    user: str, broker: str, epic: str, kind: str, params: dict[str, Any], *, skip_id: str | None = None,
) -> None:
    """(docstring unchanged)"""
    sig = _sig(kind, params)
    existing = await ALERT_STORE.list_user(user)
    for row in existing:
        if row["id"] == skip_id:
            continue
        if row["broker"] == broker and row["epic"] == epic and row["kind"] == kind:
            if _sig(kind, row["params"]) == sig:
                raise HTTPException(409, "An identical alert already exists")


async def _notify(
    request: Request, row: dict | None, alert_id: str, broker: str, epic: str, origin: str, kind: str,
) -> None:
    user = current_user(request)
    # Account alerts belong to the monitor; the price engine must never see them.
    if kind == "account":
        ACCOUNT_MONITOR.on_alert_changed(user, row, alert_id)
    else:
        ALERT_ENGINE.on_alert_changed(user, row, alert_id)
    await broadcast_to_user(
        user, {"key": "__alerts__:changed", "value": {"broker": broker, "epic": epic, "origin": origin}}
    )
```

`list_alerts`: after the engine statuses loop add

```python
    acct = ACCOUNT_MONITOR.statuses(user)
    for r in rows:
        if r.get("kind") == "account":
            r.update(acct.get(r["id"], {"current": None, "firedTiers": [], "monitored": False,
                                        "unmonitoredReason": "not started"}))
```

`create_alert`: after `_validate_kind(body.kind)` add `if body.kind == "account": deps.require_admin(request)`; change the final `_notify` call to pass `saved["kind"]`.

`patch_alert`: when `"params" in patch`, after finding `current`, add `if current.get("kind") == "account": deps.require_admin(request)`. The existing `merged = {**current["params"], **patch["params"]}` is right for tiers (a list replaces). Pass `saved["kind"]` to `_notify`. Also when `"params"` is NOT in the patch but the row is an account row, the admin gate must still apply: fetch `current` unconditionally at the top of `patch_alert` (one `list_user` call) and gate before any write.

`delete_alert`: pass `row["kind"]` to `_notify`.

New route, placed BEFORE `@router.get("/api/alerts/{alert_id}")`-style routes (put it right after `get_triggered`):

```python
@router.get("/api/alerts/account-metrics")
async def account_metrics_route(request: Request, account: str = Query(...)) -> dict[str, Any]:
    """The server's current figures for the create dialog: the value the
    monitor will actually judge, which can differ from the dock's estimate."""
    deps.require_admin(request)
    _check_account(account)
    metrics = await ACCOUNT_MONITOR.metrics_for(account)
    status = ACCOUNT_MONITOR.account_status(account)
    return {"account": account, "monitored": status["monitored"],
            "unmonitoredReason": status["unmonitoredReason"], "metrics": metrics}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && uv run pytest tests/test_alerts_api.py -q`
Expected: all passed (existing tests included).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/routers/alerts.py backend/tests/test_alerts_api.py
git commit -m "feat(alerts): account kind on /api/alerts with admin gate and metrics endpoint"
```

---

### Task 6: Lifespan wiring and notifier branches (Telegram, push)

**Files:**
- Modify: `backend/auto_trader/api/app.py:158-200`
- Modify: `backend/auto_trader/core/telegram_notify.py:271-315`
- Modify: `backend/auto_trader/core/push_notify.py:98-120`
- Test: `backend/tests/test_telegram_rich_alerts.py`, `backend/tests/test_account_monitor.py` (none), `backend/tests/test_push_notify.py` if it exists (check with `ls backend/tests | grep push`); otherwise add the push assertion to `test_telegram_rich_alerts.py`'s neighbour file `tests/test_account_notifiers.py` (create it).

**Interfaces:**
- Consumes: the fire and monitor payloads from Task 4.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_account_notifiers.py`:

```python
"""Telegram and push branches for account alerts: text only, siren on
critical, no chart snapshot, no position lines, no buttons."""
from __future__ import annotations

import asyncio
import json

import httpx
import respx

from auto_trader.core.alert_store import AlertStore
from auto_trader.core.push_notify import PUSH
from auto_trader.core.telegram_notify import TELEGRAM

TOKEN = "123:ABC-token"


def _acct_payload(**kw):
    base = {"id": "al-1", "broker": "capital-live:live", "epic": "", "kind": "account",
            "price": 118.4, "level": 120, "condition": "below", "message": "", "precision": 2,
            "notify": {"telegram": True, "push": True}, "metric": "marginLevel", "tierLabel": "danger",
            "account": "capital-live:live", "critical": False, "time": 1_700_000_000_000,
            "headline": "MARGIN LEVEL 118.4% < 120% (danger) · Capital live · equity 4,210 EUR"}
    base.update(kw)
    return base


def _with_telegram(tmp_path):
    store = AlertStore(str(tmp_path / "a.db"))
    asyncio.run(store.set_telegram("u1", "chat-9"))
    TELEGRAM.configure(TOKEN, store, hooks=None)
    return store


@respx.mock
def test_telegram_account_fire_is_text_only(tmp_path):
    _with_telegram(tmp_path)
    send = respx.post(f"https://api.telegram.org/bot{TOKEN}/sendMessage").mock(
        return_value=httpx.Response(200, json={"ok": True}))
    photo = respx.post(f"https://api.telegram.org/bot{TOKEN}/sendPhoto")
    try:
        asyncio.run(TELEGRAM.notifier("u1", _acct_payload()))
    finally:
        TELEGRAM.configure(None, None)
    assert send.called and not photo.called
    body = json.loads(send.calls[0].request.content)
    assert body["text"].startswith("🔔 MARGIN LEVEL 118.4% < 120% (danger)")
    assert "reply_markup" not in body


@respx.mock
def test_telegram_critical_gets_siren_and_status_message_sends(tmp_path):
    _with_telegram(tmp_path)
    send = respx.post(f"https://api.telegram.org/bot{TOKEN}/sendMessage").mock(
        return_value=httpx.Response(200, json={"ok": True}))
    try:
        asyncio.run(TELEGRAM.notifier("u1", _acct_payload(tierLabel="critical", critical=True)))
        asyncio.run(TELEGRAM.notifier("u1", {
            "kind": "account_status", "status": "unmonitored", "notify": {"telegram": True},
            "headline": "Capital live is not being monitored: session dropped", "broker": "capital-live:live"}))
    finally:
        TELEGRAM.configure(None, None)
    texts = [json.loads(c.request.content)["text"] for c in send.calls]
    assert texts[0].startswith("🚨")
    assert "not being monitored" in texts[1]


def test_push_body_carries_headline(tmp_path, monkeypatch):
    store = AlertStore(str(tmp_path / "a.db"))
    asyncio.run(store.add_push_sub("u1", "https://push.example/ep", {"p256dh": "k", "auth": "a"}))
    PUSH.configure(store)
    sent: list[str] = []

    async def fake_send(self, store_, user_id, sub, body, pem):
        sent.append(body)

    monkeypatch.setattr(type(PUSH), "_send", fake_send)
    monkeypatch.setattr(type(PUSH), "_keys", lambda self: _keys())
    asyncio.run(PUSH.notifier("u1", _acct_payload(critical=True)))
    body = json.loads(sent[0])
    assert body["kind"] == "account" and body["headline"].startswith("MARGIN LEVEL")
    assert body["critical"] is True and body["account"] == "capital-live:live"


async def _keys():
    return "pem", "pub"
```

If `PUSH._keys` or `PUSH._send` have different names in `push_notify.py`, adapt the monkeypatch targets to the real names (read lines 60-130 of that file first); do not change the asserted body.

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_account_notifiers.py -q`
Expected: Telegram test fails on `_headline` formatting `epic ""` / `price:.2f` or on `sendPhoto` path; push test fails on missing `headline`.

- [ ] **Step 3: Implement**

`telegram_notify.py`, at the top of `notifier` after the chat-id lookup:

```python
        if payload.get("kind") in ("account", "account_status"):
            # Account alerts have no chart and no epic: text only, no buttons.
            await self.send(chat_id, _account_text(payload))
            return
```

Module-level helper (near `_headline`):

```python
def _account_text(payload: dict) -> str:
    head = payload.get("headline") or ""
    if payload.get("kind") == "account_status":
        icon = "⚠️" if payload.get("status") == "unmonitored" else "✅"
        return f"{icon} {head}"
    icon = "🚨" if payload.get("critical") else "🔔"
    lines = [f"{icon} {head}", f"🕒 {_format_fired_time(payload)}"]
    if payload.get("message"):
        lines.append(str(payload["message"]))
    return "\n".join(lines)
```

`push_notify.py` `notifier`: extend the body dict with

```python
                "headline": payload.get("headline"),
                "account": payload.get("account") or (payload.get("broker") if payload.get("kind") in ("account", "account_status") else None),
                "critical": bool(payload.get("critical")),
                "status": payload.get("status"),
```

`api/app.py`: after `ALERT_ENGINE.configure(...)` add

```python
    from auto_trader.core.account_monitor import ACCOUNT_MONITOR
    ACCOUNT_MONITOR.configure(
        store=ALERT_STORE,
        get_exec=deps.get_exec,
        broadcast=state_router.broadcast_to_user,
        notifiers=[TELEGRAM.notifier, PUSH.notifier],
    )
```

After `await ALERT_ENGINE.start()` add `await ACCOUNT_MONITOR.start()`; in the `finally`, before the engine stop:

```python
        with suppress(Exception):
            await ACCOUNT_MONITOR.stop()
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && uv run pytest tests/test_account_notifiers.py tests/test_telegram_rich_alerts.py tests/test_api_admin_gate.py -q`
Expected: all passed (the admin-gate tests exercise the lifespan).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/app.py backend/auto_trader/core/telegram_notify.py backend/auto_trader/core/push_notify.py backend/tests/test_account_notifiers.py
git commit -m "feat(alerts): start AccountMonitor in lifespan; Telegram and push account branches"
```

---

### Task 7: Probe `--account`

**Files:**
- Modify: `backend/scripts/alert_probe.py`

No unit test (it is an end-to-end script against a running backend); verify by running it.

- [ ] **Step 1: Implement**

Add `--account KEY` (default `None`) to the argparser and pass it to `main(..., account=None)`. In `main`, before the existing branches:

```python
        if account:
            r = client.get("/api/alerts/account-metrics", params={"account": account})
            try:
                r.raise_for_status()
            except httpx.HTTPStatusError as e:
                print(f"FAIL: account-metrics failed: {e}\n{r.text}")
                return 1
            equity = r.json()["metrics"].get("equity")
            if equity is None:
                print("FAIL: no equity figure for this account")
                return 1
            # Create NOT yet crossed (a tier already past the value is seeded
            # silently), then patch the tier just above equity so the next poll
            # crosses it: that exercises the real fire path.
            body = {"id": alert_id, "broker": account, "epic": "", "kind": "account",
                    "params": {"metric": "equity", "tiers": [{"level": equity * 0.5, "label": "warn"}]},
                    "message": "alert_probe e2e check"}
            print(f"{account} equity={equity} -> tier at 50%, then raised above equity")
```

After the create succeeds and when `account` is set:

```python
        if account:
            time.sleep(6.0)  # one fast poll seeds the state
            pr = client.patch(f"/api/alerts/{alert_id}", json={"params": {"tiers": [{"level": equity * 1.01, "label": "warn"}]}})
            pr.raise_for_status()
            print("raised tier above equity; waiting for the fire")
```

The rest of the polling/cleanup loop is unchanged. Use `--timeout 60` for the account case (polls are 5 to 30 s apart).

- [ ] **Step 2: Run against the dev backend**

Run: `cd backend && python3 -m scripts.alert_probe --account capital:demo --timeout 60`
Expected: `PASS: alert ... triggered within 60s`. Ask the user before running if the backend is not already up (it needs real Capital demo credentials).

- [ ] **Step 3: Commit**

```bash
git add backend/scripts/alert_probe.py
git commit -m "feat(alerts): alert_probe --account exercises an account alert end to end"
```

---

### Task 8: Frontend alerts client: AccountAlert type, cache, CRUD, events

**Files:**
- Modify: `frontend/src/lib/alertsApi.ts`
- Modify: `frontend/src/lib/signals.ts` (near `indicatorAlertRequest`, line 79)
- Test: `frontend/src/lib/alertsApi.account.test.ts` (create)

**Interfaces:**
- Produces (all exported from `lib/alertsApi.ts`):
  ```ts
  export type AccountMetric = "marginLevel" | "openPnl" | "openPnlPct" | "equity" | "available" | "drawdown";
  export type TierLabel = "warn" | "danger" | "critical";
  export interface AccountTier { level: number; label: TierLabel }
  export interface AccountAlert {
    kind: "account"; id: string; account: string; metric: AccountMetric; tiers: AccountTier[];
    baseline?: "daily" | "sinceCreated"; message: string; expiresAt: number | null;
    notify: AlertNotifyChannels; createdAt?: number; precision: number;
    current?: number | null; firedTiers?: number[]; monitored?: boolean; unmonitoredReason?: string | null;
  }
  export const METRIC_LABELS: Record<AccountMetric, string>;   // "Margin level", "Open P/L", "Open P/L %", "Equity", "Available", "Drawdown"
  export const MONITORABLE_BROKERS: ReadonlySet<string>;        // capital, capital-live, ig-demo, ig-live
  export function isAccountMonitorable(account: string): boolean;  // broker in set AND env !== "paper"
  export function accountLabel(account: string): string;        // "Capital live"
  export function fmtMetric(metric: AccountMetric, v: number, currency: string | null): string;
  export function loadAccountAlerts(account?: string): AccountAlert[];
  export function findAccountAlert(id: string): AccountAlert | undefined;
  export async function addAccountAlert(a: AccountAlert): Promise<boolean>;
  export async function patchAccountAlert(id: string, patch: { tiers?: AccountTier[]; baseline?: "daily"|"sinceCreated"; message?: string; expiresAt?: number | null; notify?: AlertNotifyChannels }): Promise<boolean>;
  export function deleteAccountAlert(id: string): void;
  export interface AccountMetricsResponse { account: string; monitored: boolean; unmonitoredReason: string | null; metrics: Record<string, number | string | null> }
  export async function fetchAccountMetrics(account: string): Promise<AccountMetricsResponse | null>;
  export function setOnAccountMonitor(fn: ((p: MonitorPayload) => void) | null): void;
  export interface MonitorPayload { broker: string; status: "unmonitored" | "resumed"; reason: string; headline: string }
  ```
  `FiredPayload` gains `kind?: string; headline?: string; account?: string; metric?: AccountMetric; tierLabel?: TierLabel; critical?: boolean`.
  `TriggeredAlert` gains `kind?: string; headline?: string`.
  `lib/signals.ts`: `export type AccountAlertRequest = { mode: "create"; account: string; metric: AccountMetric } | { mode: "edit"; id: string }; export const accountAlertRequest = new Signal<AccountAlertRequest | null>(null);`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/lib/alertsApi.account.test.ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { installMemStorage } from "./testMemStorage";

installMemStorage();

const fetchMock = vi.fn();
vi.mock("./http", async (orig) => ({
  ...(await orig<typeof import("./http")>()),
  apiFetch: (...a: unknown[]) => fetchMock(...a),
  apiFetchPatient: (...a: unknown[]) => fetchMock(...a),
}));

const api = await import("./alertsApi");

const row = {
  id: "al-a1", broker: "capital-live:live", epic: "", kind: "account",
  params: { metric: "marginLevel", tiers: [{ level: 150, label: "warn" }] },
  message: "", expires_at: null, notify: { toast: true, browser: true, sound: true, push: true, telegram: true },
  precision: 2, active: 1, created_at: 1, updated_at: 1,
  current: 177.2, firedTiers: [], monitored: true, unmonitoredReason: null,
};

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

beforeEach(() => fetchMock.mockReset());

describe("account alerts client", () => {
  it("hydrates account rows into their own cache, not the price cache", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/triggered") ? ok({ entries: [], seen: 0 }) : ok({ alerts: [row] }));
    await api.hydrateAlerts();
    expect(api.loadAccountAlerts()).toHaveLength(1);
    expect(api.loadAccountAlerts("capital-live:live")[0]).toMatchObject({ metric: "marginLevel", current: 177.2, monitored: true });
    expect(api.loadAlerts("", "capital-live:live")).toEqual([]);
  });

  it("isAccountMonitorable and labels", () => {
    expect(api.isAccountMonitorable("capital-live:live")).toBe(true);
    expect(api.isAccountMonitorable("capital:paper")).toBe(false);
    expect(api.isAccountMonitorable("mt5:live")).toBe(false);
    expect(api.accountLabel("ig-demo:demo")).toBe("IG demo");
    expect(api.fmtMetric("marginLevel", 118.4, "EUR")).toBe("118.4%");
    expect(api.fmtMetric("equity", 4210, "EUR")).toBe("4,210 EUR");
  });

  it("addAccountAlert posts the wire shape and keeps the server row", async () => {
    fetchMock.mockResolvedValue(ok(row));
    const okk = await api.addAccountAlert({
      kind: "account", id: "al-a1", account: "capital-live:live", metric: "marginLevel",
      tiers: [{ level: 150, label: "warn" }], message: "", expiresAt: null, precision: 2,
      notify: { toast: true, browser: true, sound: true, push: true, telegram: true },
    });
    expect(okk).toBe(true);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ kind: "account", broker: "capital-live:live", epic: "", params: { metric: "marginLevel" } });
    expect(api.findAccountAlert("al-a1")?.current).toBe(177.2);
  });

  it("a fired account payload lands in history with its headline and no epic nav", () => {
    const seen: unknown[] = [];
    api.setOnAlertFired((p) => seen.push(p));
    api.applyAlertEvent("__alerts__:fired", {
      id: "al-a1", broker: "capital-live:live", epic: "", kind: "account", price: 118.4, level: 120,
      condition: "below", message: "", precision: 2, notify: {}, headline: "MARGIN LEVEL 118.4% < 120% (danger) · Capital live",
    });
    expect(api.loadTriggered()[0]).toMatchObject({ kind: "account", headline: expect.stringContaining("MARGIN LEVEL") });
    expect(seen).toHaveLength(1);
  });

  it("a monitor event reaches the monitor hook", () => {
    const seen: unknown[] = [];
    api.setOnAccountMonitor((p) => seen.push(p));
    expect(api.applyAlertEvent("__alerts__:monitor", { broker: "capital-live:live", status: "unmonitored", reason: "x", headline: "h" })).toBe(true);
    expect(seen).toHaveLength(1);
  });
});
```

Check `setOnAlertFired` is exported from `alertsApi.ts` (it is re-exported through `lib/persist`; if `alertsApi` exports it under another name, use that name in the test).

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/lib/alertsApi.account.test.ts`
Expected: fails on missing exports.

- [ ] **Step 3: Implement**

In `alertsApi.ts`:

Types (after `LineAlert`):

```ts
export type AccountMetric = "marginLevel" | "openPnl" | "openPnlPct" | "equity" | "available" | "drawdown";
export type TierLabel = "warn" | "danger" | "critical";
export interface AccountTier { level: number; label: TierLabel }
/** A server-evaluated alert on an account figure; `account` is the exec key. */
export interface AccountAlert {
  kind: "account";
  id: string;
  account: string;
  metric: AccountMetric;
  tiers: AccountTier[];
  baseline?: "daily" | "sinceCreated";
  message: string;
  expiresAt: number | null;
  notify: AlertNotifyChannels;
  createdAt?: number;
  precision: number;
  current?: number | null;
  firedTiers?: number[];
  monitored?: boolean;
  unmonitoredReason?: string | null;
}
export const METRIC_LABELS: Record<AccountMetric, string> = {
  marginLevel: "Margin level", openPnl: "Open P/L", openPnlPct: "Open P/L %",
  equity: "Equity", available: "Available", drawdown: "Drawdown",
};
export const MONITORABLE_BROKERS: ReadonlySet<string> = new Set(["capital", "capital-live", "ig-demo", "ig-live"]);
const ACCOUNT_LABELS: Record<string, string> = {
  capital: "Capital demo", "capital-live": "Capital live", "ig-demo": "IG demo", "ig-live": "IG live",
};
export function isAccountMonitorable(account: string): boolean {
  const [broker, env] = account.split(":");
  return MONITORABLE_BROKERS.has(broker) && env !== "paper";
}
export function accountLabel(account: string): string {
  return ACCOUNT_LABELS[account.split(":")[0]] ?? account;
}
const PCT_METRICS: ReadonlySet<AccountMetric> = new Set(["marginLevel", "openPnlPct", "drawdown"]);
export function fmtMetric(metric: AccountMetric, v: number, currency: string | null): string {
  if (PCT_METRICS.has(metric)) return `${Number.isInteger(v) ? v : v.toFixed(1)}%`;
  const amount = v.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 });
  return currency ? `${amount} ${currency}` : amount;
}
```

Extend `FiredPayload` and `TriggeredAlert` with the optional fields listed in Interfaces. Extend `AlertRow` with `current?: number | null; firedTiers?: number[]; monitored?: boolean; unmonitoredReason?: string | null;` and `TriggeredRow` with `kind?: string` (present) and read `row.alert?.headline` is NOT stored; derive the history label for account rows in `triggeredRowToClient`:

```ts
    kind: row.kind,
    headline: row.kind === "account" && row.alert?.params
      ? `${METRIC_LABELS[(row.alert.params.metric as AccountMetric)] ?? "Account"} ${row.condition === "above" ? ">" : "<"} ${row.level}`
      : undefined,
```

Cache + mapping (next to `indicatorCache`):

```ts
let accountCache = new Map<string, AccountAlert>();

function rowToAccountAlert(row: AlertRow): AccountAlert {
  const p = row.params as { metric: AccountMetric; tiers: AccountTier[]; baseline?: "daily" | "sinceCreated" };
  return {
    kind: "account", id: row.id, account: row.broker, metric: p.metric, tiers: p.tiers, baseline: p.baseline,
    message: row.message, expiresAt: row.expires_at, notify: { ...ALL_ON_CHANNELS, ...(row.notify ?? {}) },
    createdAt: row.created_at, precision: row.precision,
    current: row.current, firedTiers: row.firedTiers, monitored: row.monitored, unmonitoredReason: row.unmonitoredReason,
  };
}
```

(`ALL_ON_CHANNELS`: define a local `const ALL_ON_CHANNELS: AlertNotifyChannels = { toast: true, browser: true, sound: true, push: true, telegram: true }` if the module does not already have one; do not import from `components/`.)

In `hydrateAlerts` the row loop gains a first branch:

```ts
          if (row.kind === "account") {
            nextAcct.set(row.id, rowToAccountAlert(row));
          } else if (row.kind === "indicator") {
```

with `const nextAcct = new Map<string, AccountAlert>();` declared beside `nextInd` and `accountCache = nextAcct;` assigned where `alertsCache = next;` is.

Reads and writes:

```ts
export function loadAccountAlerts(account?: string): AccountAlert[] {
  const all = [...accountCache.values()];
  return account ? all.filter((a) => a.account === account) : all;
}
export function findAccountAlert(id: string): AccountAlert | undefined {
  return accountCache.get(id);
}
function accountWire(a: Pick<AccountAlert, "metric" | "tiers" | "baseline">) {
  return a.metric === "drawdown" ? { metric: a.metric, tiers: a.tiers, baseline: a.baseline ?? "daily" } : { metric: a.metric, tiers: a.tiers };
}
export async function addAccountAlert(a: AccountAlert): Promise<boolean> {
  if (accountCache.has(a.id)) return true;
  accountCache.set(a.id, a);
  bumpAlerts();
  const res = await sendJson("/api/alerts", "POST", {
    id: a.id, broker: a.account, epic: "", kind: "account", params: accountWire(a),
    message: a.message, expires_at: a.expiresAt, notify: a.notify, precision: a.precision,
  });
  if (res?.ok) {
    try { accountCache.set(a.id, rowToAccountAlert((await res.json()) as AlertRow)); bumpAlerts(); } catch { /* keep optimistic */ }
    return true;
  }
  accountCache.delete(a.id);
  bumpAlerts();
  await reportFailure(res, "Alert save failed");
  return false;
}
export async function patchAccountAlert(
  id: string,
  patch: { tiers?: AccountTier[]; baseline?: "daily" | "sinceCreated"; message?: string; expiresAt?: number | null; notify?: AlertNotifyChannels },
): Promise<boolean> {
  const prev = accountCache.get(id);
  if (!prev) return false;
  const params = patch.tiers || patch.baseline ? accountWire({ metric: prev.metric, tiers: patch.tiers ?? prev.tiers, baseline: patch.baseline ?? prev.baseline }) : undefined;
  const res = await sendJson(`/api/alerts/${encodeURIComponent(id)}`, "PATCH", {
    params, message: patch.message, expires_at: patch.expiresAt, notify: patch.notify,
  });
  if (res?.ok) {
    try { accountCache.set(id, rowToAccountAlert((await res.json()) as AlertRow)); } catch { /* resync will fix */ }
    bumpAlerts();
    return true;
  }
  await reportFailure(res, "Alert update failed");
  return false;
}
export function deleteAccountAlert(id: string): void {
  if (!accountCache.delete(id)) return;
  bumpAlerts();
  void sendJson(`/api/alerts/${encodeURIComponent(id)}`, "DELETE", undefined).then((res) => {
    if (res && !res.ok && res.status !== 404) void resyncAlerts();
  });
}
export interface AccountMetricsResponse {
  account: string; monitored: boolean; unmonitoredReason: string | null;
  metrics: Record<string, number | string | null>;
}
export async function fetchAccountMetrics(account: string): Promise<AccountMetricsResponse | null> {
  try {
    const res = await apiFetch(url(`/api/alerts/account-metrics?account=${encodeURIComponent(account)}`));
    return res.ok ? ((await res.json()) as AccountMetricsResponse) : null;
  } catch { return null; }
}
```

Check how `sendJson` serialises `undefined` body for DELETE: it calls `JSON.stringify(undefined)` which is `undefined`, fine. Look at how `deleteIndicatorAlert` (line 893) does it and mirror that if it differs.

Events: in `applyAlertEvent`, the `fired` branch adds `kind: payload.kind, headline: payload.headline` to the triggered entry; add before the final fallthrough:

```ts
  if (kind === "monitor") {
    onMonitor?.(value as MonitorPayload);
    return true;
  }
```

with

```ts
export interface MonitorPayload { broker: string; status: "unmonitored" | "resumed"; reason: string; headline: string }
let onMonitor: ((p: MonitorPayload) => void) | null = null;
export function setOnAccountMonitor(fn: ((p: MonitorPayload) => void) | null): void { onMonitor = fn; }
```

`lib/signals.ts` after `indicatorAlertRequest`:

```ts
export type AccountAlertRequest =
  | { mode: "create"; account: string; metric: AccountMetric }
  | { mode: "edit"; id: string };
export const accountAlertRequest = new Signal<AccountAlertRequest | null>(null);
```

importing `type AccountMetric` from `./alertsApi` (type-only import, so no module-init edge).

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/lib/alertsApi.account.test.ts && npx tsc -b`
Expected: 5 passed; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/alertsApi.ts frontend/src/lib/signals.ts frontend/src/lib/alertsApi.account.test.ts
git commit -m "feat(alerts): account alert client type, cache, CRUD and events"
```

---

### Task 9: Fired toast, monitor toast, service worker

**Files:**
- Modify: `frontend/src/app/useAlertFiredNotices.ts`
- Modify: `frontend/public/alert-sw.js`
- Test: `frontend/src/app/useAlertFiredNotices.test.tsx` (create; check whether a test file already exists with `ls frontend/src/app | grep -i fired` and extend it instead)

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/app/useAlertFiredNotices.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const toast = vi.fn();
const notify = vi.fn();
vi.mock("../lib/notify", () => ({ toast: (...a: unknown[]) => toast(...a), notify: (...a: unknown[]) => notify(...a), playPing: () => {} }));
const toggleSidePanel = vi.fn();
vi.mock("../lib/signals", async (orig) => ({
  ...(await orig<typeof import("../lib/signals")>()),
  toggleSidePanel: (...a: unknown[]) => toggleSidePanel(...a),
}));

let fired: ((p: unknown) => void) | null = null;
let monitor: ((p: unknown) => void) | null = null;
vi.mock("../lib/persist", () => ({ setOnAlertFired: (fn: typeof fired) => { fired = fn; } }));
vi.mock("../lib/alertsApi", async (orig) => ({
  ...(await orig<typeof import("../lib/alertsApi")>()),
  setOnAccountMonitor: (fn: typeof monitor) => { monitor = fn; },
}));

const { useAlertFiredNotices, firedDetail } = await import("./useAlertFiredNotices");

describe("account alert notices", () => {
  it("toasts the headline, opens the trade list on click, never navigates to a chart", () => {
    renderHook(() => useAlertFiredNotices());
    fired!({ id: "al-a1", broker: "capital-live:live", epic: "", kind: "account", price: 118.4, level: 120,
      condition: "below", message: "", precision: 2, notify: {}, headline: "MARGIN LEVEL 118.4% < 120% (danger) · Capital live", critical: false });
    expect(toast).toHaveBeenCalledTimes(1);
    const [text, opts] = toast.mock.calls[0] as [string, { onClick?: () => void }];
    expect(text).toContain("MARGIN LEVEL 118.4%");
    opts.onClick?.();
    expect(toggleSidePanel).toHaveBeenCalledWith("tradeList");
  });

  it("monitor events toast without channel gates", () => {
    renderHook(() => useAlertFiredNotices());
    monitor!({ broker: "capital-live:live", status: "unmonitored", reason: "session dropped", headline: "Capital live is not being monitored: session dropped" });
    expect(toast.mock.calls.at(-1)![0]).toContain("not being monitored");
  });

  it("firedDetail still formats price alerts", () => {
    expect(firedDetail({ id: "x", broker: "b", epic: "E", price: 1, level: 2, condition: "crossing", message: "", precision: 2, notify: {} }, 2)).toBe("@ 2.00");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/app/useAlertFiredNotices.test.tsx`
Expected: first test fails (toast text is `"" @ 120.00"`-style, click calls `alertNavHandler`).

- [ ] **Step 3: Implement**

In `useAlertFiredNotices.ts`, import `setOnAccountMonitor` from `../lib/alertsApi` and `toggleSidePanel` from `../lib/signals`. Inside the `setOnAlertFired` callback, first thing:

```ts
      if (p.kind === "account") {
        // No epic and no chart: the headline IS the message; click opens the
        // trade list, where the account strip shows the live figures.
        const text = p.message ? `${p.headline} · ${p.message}` : p.headline ?? "Account alert";
        const open = () => toggleSidePanel("tradeList");
        const key = `account|${p.id}`;
        const icon = p.critical ? "\u{1F6A8}" : "\u{1F514}";
        if (p.notify?.toast ?? true) toast(`${icon} ${text}`, { onClick: open, duration: null, key });
        if (p.notify?.browser ?? true) notify(accountLabel(p.account ?? p.broker), text, open, key);
        if (p.notify?.sound ?? true) playPing();
        bumpAlerts();
        return;
      }
```

(`accountLabel` imported from `../lib/alertsApi`.) After the `setOnAlertFired` registration, add:

```ts
    setOnAccountMonitor((m) => {
      const icon = m.status === "unmonitored" ? "⚠️" : "✅";
      toast(`${icon} ${m.headline}`, { duration: null, key: `monitor|${m.broker}` });
      notify(accountLabel(m.broker), m.headline, undefined, `monitor|${m.broker}`);
      bumpAlerts();
    });
```

and in the cleanup `setOnAccountMonitor(null)`. Check `toggleSidePanel` accepts `"tradeList"` (`lib/signals.ts:824` lists it).

`alert-sw.js` push handler, before `const prec = ...`:

```js
    if (p.kind === "account" || p.kind === "account_status") {
      const icon = p.kind === "account_status" ? (p.status === "unmonitored" ? "⚠️" : "✅") : p.critical ? "🚨" : "🔔";
      await self.registration.showNotification(`${icon} ${p.account ?? p.broker ?? "Account"}`, {
        body: p.message ? `${p.headline} · ${p.message}` : p.headline,
        tag: `account|${p.id}`,
        requireInteraction: !!p.critical,
        data: { id: p.id },
      });
      return;
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/app/useAlertFiredNotices.test.tsx && npx tsc -b`
Expected: 3 passed; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/useAlertFiredNotices.ts frontend/src/app/useAlertFiredNotices.test.tsx frontend/public/alert-sw.js
git commit -m "feat(alerts): account alert toasts, monitor notices and push text"
```

---

### Task 10: AccountAlertModal

**Files:**
- Create: `frontend/src/AccountAlertModal.tsx`
- Test: `frontend/src/AccountAlertModal.test.tsx`
- Modify: `frontend/src/App.tsx` (mount beside `IndicatorAlertModal`, line 1253)

**Interfaces:**
- Consumes: Task 8 client functions and `accountAlertRequest`; `FloatingModal`, `InfoTip`, `CHANNELS` from `components/AlertCommonFields`.
- Produces: `export default function AccountAlertModal({ request, now, onClose }: { request: AccountAlertRequest; now: number; onClose: () => void })`.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/AccountAlertModal.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { installMemStorage } from "./lib/testMemStorage";

installMemStorage();
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const add = vi.fn(async () => true);
const patch = vi.fn(async () => true);
vi.mock("./lib/alertsApi", async (orig) => ({
  ...(await orig<typeof import("./lib/alertsApi")>()),
  fetchAccountMetrics: async () => ({ account: "capital-live:live", monitored: true, unmonitoredReason: null,
    metrics: { marginLevel: 177.2, equity: 4210, currency: "EUR", openPnl: -90, openPnlPct: -2.1, available: 3010 } }),
  addAccountAlert: (...a: unknown[]) => add(...a),
  patchAccountAlert: (...a: unknown[]) => patch(...a),
  findAccountAlert: (id: string) => id === "al-e" ? {
    kind: "account", id: "al-e", account: "capital-live:live", metric: "drawdown", baseline: "sinceCreated",
    tiers: [{ level: 5, label: "warn" }], message: "", expiresAt: null, precision: 2,
    notify: { toast: true, browser: true, sound: true, push: true, telegram: true },
  } : undefined,
}));

const { default: AccountAlertModal } = await import("./AccountAlertModal");

afterEach(cleanup);

describe("AccountAlertModal", () => {
  it("creates a margin-level alert with the default tiers and shows the server value", async () => {
    render(<AccountAlertModal request={{ mode: "create", account: "capital-live:live", metric: "marginLevel" }} now={0} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/now 177\.2%/)).toBeTruthy());
    expect((screen.getByLabelText("Tier 1 level") as HTMLInputElement).value).toBe("150");
    expect((screen.getByLabelText("Tier 3 level") as HTMLInputElement).value).toBe("100");
    fireEvent.click(screen.getByText("Create"));
    await waitFor(() => expect(add).toHaveBeenCalled());
    const a = add.mock.calls[0][0] as { metric: string; tiers: { level: number; label: string }[]; account: string };
    expect(a.account).toBe("capital-live:live");
    expect(a.tiers.map((t) => t.level)).toEqual([150, 120, 100]);
  });

  it("refuses unordered tiers before sending", async () => {
    render(<AccountAlertModal request={{ mode: "create", account: "capital-live:live", metric: "marginLevel" }} now={0} onClose={() => {}} />);
    await screen.findByText(/now 177\.2%/);
    fireEvent.change(screen.getByLabelText("Tier 2 level"), { target: { value: "160" } });
    expect((screen.getByText("Create") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/must fall from one tier to the next/)).toBeTruthy();
  });

  it("edits a drawdown alert and sends the baseline", async () => {
    render(<AccountAlertModal request={{ mode: "edit", id: "al-e" }} now={0} onClose={() => {}} />);
    await screen.findByText(/Drawdown/);
    fireEvent.click(screen.getByLabelText("Since midnight"));
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("al-e", expect.objectContaining({ baseline: "daily" })));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/AccountAlertModal.test.tsx`
Expected: module not found.

- [ ] **Step 3: Implement**

```tsx
// frontend/src/AccountAlertModal.tsx
// Create / edit an account alert: a metric on one dealing account with 1 to 3
// tiers (warn, danger, critical). The server evaluates it; this dialog shows
// the SERVER's current value, which is the figure the tiers are judged against.
import { useEffect, useMemo, useState } from "react";
import FloatingModal from "./components/FloatingModal";
import InfoTip from "./components/InfoTip";
import { CHANNELS } from "./components/AlertCommonFields";
import {
  METRIC_LABELS, accountLabel, addAccountAlert, fetchAccountMetrics, findAccountAlert, fmtMetric,
  patchAccountAlert, type AccountAlert, type AccountMetric, type AccountMetricsResponse, type AccountTier,
  type AlertNotifyChannels, type TierLabel,
} from "./lib/alertsApi";
import { requestConfirm, type AccountAlertRequest } from "./lib/signals";
import { deleteAccountAlert } from "./lib/alertsApi";

const TIER_LABELS: TierLabel[] = ["warn", "danger", "critical"];
const FALLING: ReadonlySet<AccountMetric> = new Set(["marginLevel", "equity", "available", "openPnl", "openPnlPct"]);
const ALL_ON: AlertNotifyChannels = { toast: true, browser: true, sound: true, push: true, telegram: true };
const newId = () => `al-${crypto.randomUUID()}`;

/** Default tiers: margin level gets Capital's three steps; anything else one
 *  tier 10% worse than the current value (falls back to 0 with no value). */
function defaultTiers(metric: AccountMetric, current: number | null): AccountTier[] {
  if (metric === "marginLevel") return [{ level: 150, label: "warn" }, { level: 120, label: "danger" }, { level: 100, label: "critical" }];
  if (metric === "drawdown") return [{ level: 5, label: "warn" }];
  const base = current ?? 0;
  const worse = FALLING.has(metric) ? base - Math.abs(base) * 0.1 : base + Math.abs(base) * 0.1;
  return [{ level: Number(worse.toFixed(2)), label: "warn" }];
}

function orderError(metric: AccountMetric, tiers: AccountTier[]): string | null {
  const levels = tiers.map((t) => t.level);
  if (levels.some((l) => !Number.isFinite(l))) return "Every tier needs a number";
  for (let i = 1; i < levels.length; i++) {
    const ok = FALLING.has(metric) ? levels[i] < levels[i - 1] : levels[i] > levels[i - 1];
    if (!ok) return FALLING.has(metric) ? "Levels must fall from one tier to the next" : "Levels must rise from one tier to the next";
  }
  return null;
}

interface Props { request: AccountAlertRequest; now: number; onClose: () => void }

export default function AccountAlertModal({ request, onClose }: Props) {
  const existing = request.mode === "edit" ? findAccountAlert(request.id) : undefined;
  useEffect(() => { if (request.mode === "edit" && !existing) onClose(); }, [request, existing, onClose]);
  if (request.mode === "edit" && !existing) return null;
  const account = request.mode === "edit" ? existing!.account : request.account;
  const metric = request.mode === "edit" ? existing!.metric : request.metric;
  return <Body key={`${account}|${metric}|${existing?.id ?? "new"}`} {...{ account, metric, existing, onClose }} />;
}

function Body({ account, metric, existing, onClose }: {
  account: string; metric: AccountMetric; existing?: AccountAlert; onClose: () => void;
}) {
  const isEdit = !!existing;
  const [live, setLive] = useState<AccountMetricsResponse | null>(null);
  const currency = (live?.metrics.currency as string | null) ?? null;
  const current = metric === "drawdown" ? (existing?.current ?? null) : ((live?.metrics[metric] as number | null) ?? null);
  const [tiers, setTiers] = useState<AccountTier[]>(existing?.tiers ?? []);
  const [baseline, setBaseline] = useState<"daily" | "sinceCreated">(existing?.baseline ?? "sinceCreated");
  const [message, setMessage] = useState(existing?.message ?? "");
  const [notify, setNotify] = useState<AlertNotifyChannels>(existing?.notify ?? ALL_ON);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void fetchAccountMetrics(account).then((r) => {
      if (!alive) return;
      setLive(r);
      if (!isEdit) setTiers((t) => (t.length ? t : defaultTiers(metric, (r?.metrics[metric] as number | null) ?? null)));
    });
    return () => { alive = false; };
  }, [account, metric, isEdit]);

  const error = useMemo(() => (tiers.length ? orderError(metric, tiers) : "Add at least one tier"), [metric, tiers]);
  const setTier = (i: number, patch: Partial<AccountTier>) => setTiers((t) => t.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  async function save() {
    if (error || busy) return;
    setBusy(true);
    const ok = isEdit
      ? await patchAccountAlert(existing!.id, { tiers, baseline: metric === "drawdown" ? baseline : undefined, message, notify })
      : await addAccountAlert({
          kind: "account", id: newId(), account, metric, tiers, baseline: metric === "drawdown" ? baseline : undefined,
          message, expiresAt: null, notify, precision: 2, createdAt: Date.now(),
        });
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <FloatingModal
      className="alert-modal"
      title={<span>{isEdit ? "Edit account alert" : "Account alert"} · <strong>{accountLabel(account)}</strong></span>}
      onClose={onClose}
      footer={
        <>
          {isEdit && (
            <button className="ghost" onClick={() => requestConfirm({
              message: `Delete this ${METRIC_LABELS[metric]} alert on ${accountLabel(account)}?`,
              onConfirm: () => { deleteAccountAlert(existing!.id); onClose(); },
            })}>Delete</button>
          )}
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!!error || busy} onClick={save}>{isEdit ? "Save" : "Create"}</button>
        </>
      }
    >
      <div className="al-row">
        <span>{METRIC_LABELS[metric]}</span>
        <span className="num">{current == null ? (live ? "no value yet" : "loading") : `now ${fmtMetric(metric, current, currency)}`}</span>
        <InfoTip title="Server value" text={["This is the figure the alert is judged on.", "It can differ a little from the dock when resting orders reserve margin."]} />
      </div>
      {live && !live.monitored && <div className="al-row al-warn">Not monitored: {live.unmonitoredReason}</div>}
      {metric === "drawdown" && (
        <div className="al-row">
          <span>Peak</span>
          <label><input type="radio" name="baseline" aria-label="Since midnight" checked={baseline === "daily"} onChange={() => setBaseline("daily")} /> Since midnight</label>
          <label><input type="radio" name="baseline" aria-label="Since created" checked={baseline === "sinceCreated"} onChange={() => setBaseline("sinceCreated")} /> Since created</label>
        </div>
      )}
      <div className="al-row al-tiers">
        <span>Tiers</span>
        {tiers.map((t, i) => (
          <div key={i} className="al-tier">
            <input type="number" step="any" aria-label={`Tier ${i + 1} level`} value={Number.isFinite(t.level) ? t.level : ""}
              onChange={(e) => setTier(i, { level: e.target.value === "" ? NaN : Number(e.target.value) })} />
            <select aria-label={`Tier ${i + 1} label`} value={t.label} onChange={(e) => setTier(i, { label: e.target.value as TierLabel })}>
              {TIER_LABELS.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
            <button className="ghost" aria-label={`Remove tier ${i + 1}`} onClick={() => setTiers((x) => x.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        {tiers.length < 3 && (
          <button className="ghost" onClick={() => setTiers((x) => [...x, { level: x.at(-1)?.level ?? 0, label: TIER_LABELS[Math.min(x.length, 2)] }])}>Add tier</button>
        )}
        {error && <div className="al-error">{error}</div>}
      </div>
      <div className="al-row">
        <span>Message</span>
        <input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Optional" />
      </div>
      <div className="al-row al-channels">
        <span>Notify</span>
        {CHANNELS.map(([key, label]) => (
          <label key={key}><input type="checkbox" checked={notify[key]} onChange={(e) => setNotify({ ...notify, [key]: e.target.checked })} /> {label}</label>
        ))}
      </div>
    </FloatingModal>
  );
}
```

Match the `al-row`/`ghost`/`primary` class names to what `IndicatorAlertModal.tsx` uses (read its JSX once); add `.al-tier { display: flex; gap: 6px; align-items: center; }` and `.al-error { color: var(--neg); font-size: 12px; }` to `App.css` next to the other `.al-` rules if they don't exist.

`App.tsx`: import `AccountAlertModal` and `accountAlertRequest`; read it the way `indAlertReq` is read in the `useSignals`-style destructure at line 200 (add `acctAlertReq` from `accountAlertRequest`), include it in the Escape-guard list at lines 210 and 219, and render:

```tsx
      {!isDemoMode() && acctAlertReq && (
        <AccountAlertModal request={acctAlertReq} now={Date.now()} onClose={() => accountAlertRequest.set(null)} />
      )}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/AccountAlertModal.test.tsx && npx tsc -b`
Expected: 3 passed; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/AccountAlertModal.tsx frontend/src/AccountAlertModal.test.tsx frontend/src/App.tsx frontend/src/App.css
git commit -m "feat(alerts): account alert create/edit modal"
```

---

### Task 11: Bell on the dock stats (desktop and mobile)

**Files:**
- Modify: `frontend/src/PositionsPanel.tsx` (`Stat` at line 708, the four `<Stat>` uses for P&L, Equity, Available, Margin level)
- Modify: `frontend/src/mobile/MobilePositionsView.tsx` (`Stat` at line 109 and its uses)
- Modify: `frontend/src/App.css` (after `.pp-acct-tab` rules around line 5308)
- Test: `frontend/src/PositionsPanel.stat.test.tsx` (create)

**Interfaces:**
- `Stat` gains `onAlert?: () => void; hasAlert?: boolean; alertLabel?: string`.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/PositionsPanel.stat.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { installMemStorage } from "./lib/testMemStorage";

installMemStorage();
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("klinecharts", () => ({ registerIndicator: () => {}, registerOverlay: () => {}, registerYAxis: () => {}, getSupportedIndicators: () => [] }));

const { Stat } = await import("./PositionsPanel");

afterEach(cleanup);

describe("dock Stat bell", () => {
  it("renders no bell without onAlert", () => {
    render(<Stat label="Balance" value="1" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("renders a bell that calls onAlert and marks an existing alert", () => {
    const onAlert = vi.fn();
    render(<Stat label="Margin level" value="77.78%" onAlert={onAlert} hasAlert alertLabel="Alert on margin level" />);
    const btn = screen.getByRole("button", { name: "Alert on margin level" });
    expect(btn.className).toContain("on");
    fireEvent.click(btn);
    expect(onAlert).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/PositionsPanel.stat.test.tsx`
Expected: second test fails (no button).

- [ ] **Step 3: Implement**

`PositionsPanel.tsx` `Stat`:

```tsx
export function Stat({ label, value, tone, title, onAlert, hasAlert, alertLabel }: {
  label: string; value: string; tone?: "pos" | "neg"; title?: string;
  onAlert?: () => void; hasAlert?: boolean; alertLabel?: string;
}) {
  return (
    <Tooltip content={title}>
      <div className="pp-stat">
        <span className="pp-stat-label">
          {label}
          {onAlert && (
            <Tooltip content={hasAlert ? "Edit account alert" : "Add account alert"}>
              <button
                type="button"
                className={`pp-stat-bell${hasAlert ? " on" : ""}`}
                aria-label={alertLabel ?? `Alert on ${label.toLowerCase()}`}
                onClick={(e) => { e.stopPropagation(); onAlert(); }}
              >
                <BellIcon />
              </button>
            </Tooltip>
          )}
        </span>
        <span className={`pp-stat-val num${tone ? ` pp-${tone}` : ""}`}>{value}</span>
      </div>
    </Tooltip>
  );
}

function BellIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  );
}
```

In the panel body, after `const stats = ...`:

```tsx
  // Account alerts: a bell on the figures the server can watch. Only real
  // Capital/IG accounts are monitorable (paper has no broker summary; MT5 is
  // excluded so polling never keeps the MetaApi account deployed).
  const canAlert = isAccountMonitorable(account) && isAdminAccount();
  const alertsVersion = useSyncExternalStore(subscribeAlerts, () => alertsSignalValue());
  void alertsVersion;
  const acctAlerts = canAlert ? loadAccountAlerts(account) : [];
  const bell = (metric: AccountMetric) => {
    if (!canAlert) return {};
    const existing = acctAlerts.find((a) => a.metric === metric);
    return {
      hasAlert: !!existing,
      alertLabel: `Alert on ${METRIC_LABELS[metric].toLowerCase()}`,
      onAlert: () => accountAlertRequest.set(existing ? { mode: "edit", id: existing.id } : { mode: "create", account, metric }),
    };
  };
```

Find how other components subscribe to alert changes (grep `alertsVersion` or `useAlertsVersion` in `AlertsSidebar.tsx`) and use that same hook instead of the `useSyncExternalStore` sketch above. Then pass `{...bell("openPnl")}` on the Unrealized P&L stat, `{...bell("equity")}`, `{...bell("available")}`, `{...bell("marginLevel")}` on their stats. Imports: `isAccountMonitorable, loadAccountAlerts, METRIC_LABELS, type AccountMetric` from `./lib/alertsApi`, `isAdminAccount` from `./lib/trading`, `accountAlertRequest` from `./lib/signals`.

`MobilePositionsView.tsx`: replace its local `Stat` with `import { Stat } from "../PositionsPanel"` ONLY if that import does not pull chart code into the mobile bundle (check `PositionsPanel.tsx` imports: it imports `HistoryPane`, `Mt5DeployButton`, which is fine for a web bundle). Otherwise copy the bell markup into the mobile `Stat`. Compute the same `bell()` on `mobileAccount.value` and pass it on the four stats. The bell is always visible on mobile (no hover): add `.m-positions .pp-stat-bell { opacity: 1; }`.

`App.css`:

```css
.pp-stat-label { display: inline-flex; align-items: center; gap: 4px; }
.pp-stat-bell {
  background: none; border: 0; padding: 0; margin: 0; cursor: pointer;
  color: var(--text-dim); opacity: 0; display: inline-flex; line-height: 0;
}
.pp-stat:hover .pp-stat-bell, .pp-stat-bell:focus-visible, .pp-stat-bell.on { opacity: 1; }
.pp-stat-bell.on { color: var(--text); }
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/PositionsPanel.stat.test.tsx && npx tsc -b`
Expected: 2 passed; tsc clean. Then open the app and hover Margin level on a Capital demo account: the bell appears, click opens the modal pre-filled 150/120/100 with "now NN%".

- [ ] **Step 5: Commit**

```bash
git add frontend/src/PositionsPanel.tsx frontend/src/PositionsPanel.stat.test.tsx frontend/src/mobile/MobilePositionsView.tsx frontend/src/App.css
git commit -m "feat(alerts): bell on dock stats opens the account alert dialog"
```

---

### Task 12: "Account" group in the alerts panel

**Files:**
- Modify: `frontend/src/AlertsSidebar.tsx`
- Test: `frontend/src/AlertsSidebar.test.tsx`

- [ ] **Step 1: Write the failing test**

Append to the existing mock in `AlertsSidebar.test.tsx` a `loadAccountAlerts` entry and a new describe:

```tsx
const acctAlert = {
  kind: "account" as const, id: "al-a1", account: "capital-live:live", metric: "marginLevel" as const,
  tiers: [{ level: 150, label: "warn" as const }, { level: 120, label: "danger" as const }],
  message: "", expiresAt: null, precision: 2,
  notify: { toast: true, browser: true, sound: true, push: true, telegram: true },
  current: 118.4, firedTiers: [150, 120], monitored: false, unmonitoredReason: "session dropped",
};
// add to the vi.mock("./lib/alertsApi") factory:
//   loadAccountAlerts: () => [acctAlert],

describe("AlertsSidebar account group", () => {
  it("lists account alerts with value, fired tiers and an unmonitored badge", () => {
    render(<AlertsSidebar controller={null} epic="US100" precision={2} tabs={[]} visibleCells={[]} brokerId="capital" onOpenAlert={() => {}} />);
    expect(screen.getByText("Account")).toBeTruthy();
    expect(screen.getByText("Capital live")).toBeTruthy();
    expect(screen.getByText(/Margin level/)).toBeTruthy();
    expect(screen.getByText(/now 118\.4%/)).toBeTruthy();
    expect(screen.getByText("Unmonitored")).toBeTruthy();
    const danger = screen.getByText("120%");
    expect(danger.className).toContain("fired");
  });
});
```

(Keep the existing render call's props identical to the file's first test; copy them.)

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/AlertsSidebar.test.tsx`
Expected: the new test fails on "Account".

- [ ] **Step 3: Implement**

In `AlertsSidebar.tsx` add a row component beside `IndicatorAlertRow`:

```tsx
function AccountAlertRow({ a }: { a: AccountAlert }) {
  const edit = () => accountAlertRequest.set({ mode: "edit", id: a.id });
  const fired = new Set(a.firedTiers ?? []);
  return (
    <div className="ap-row" onDoubleClick={edit}>
      <div className="ap-row-main">
        <span className="ap-sym">{accountLabel(a.account)}</span>
        <span className="ap-cond">
          {METRIC_LABELS[a.metric]}
          {a.current != null && <> · now {fmtMetric(a.metric, a.current, null)}</>}
        </span>
      </div>
      {a.message && <div className="ap-msg">{a.message}</div>}
      <div className="ap-row-meta">
        <span className="ap-row-badges">
          {a.tiers.map((t) => (
            <Tooltip key={t.level} content={`${t.label}${fired.has(t.level) ? " · fired" : ""}`}>
              <span className={`ap-badge ap-tier${fired.has(t.level) ? " fired" : ""}`}>{fmtMetric(a.metric, t.level, null)}</span>
            </Tooltip>
          ))}
          {a.monitored === false && (
            <Tooltip content={a.unmonitoredReason ?? "Not monitored"}>
              <span className="ap-badge ap-badge-wait">Unmonitored</span>
            </Tooltip>
          )}
        </span>
        <div className="ap-row-actions">
          <Tooltip content="Edit alert">
            <button className="ap-icon-btn" onClick={(e) => { e.stopPropagation(); edit(); }}><EditIcon /></button>
          </Tooltip>
          <Tooltip content="Delete alert">
            <button className="ap-icon-btn" onClick={(e) => {
              e.stopPropagation();
              requestConfirm({ message: `Delete this ${METRIC_LABELS[a.metric]} alert on ${accountLabel(a.account)}?`, onConfirm: () => deleteAccountAlert(a.id) });
            }}><TrashIcon /></button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
```

In the live tab render, at the top of `<div className="ap-list">` (before the `showAll ?` branch), always:

```tsx
          {accountAlerts.length > 0 && (
            <div>
              <div className="ap-group-header">Account</div>
              {accountAlerts.map((a) => <AccountAlertRow key={a.id} a={a} />)}
            </div>
          )}
```

with `const accountAlerts = loadAccountAlerts();` computed beside `allGroups` (it re-reads on the same alerts version bump the panel already subscribes to). Include `accountAlerts.length` in the live-tab count if the header shows one. CSS in `App.css` beside `.ap-badge-wait`: `.ap-tier.fired { border-color: var(--neg); color: var(--neg); }`. Imports: `loadAccountAlerts, deleteAccountAlert, accountLabel, fmtMetric, METRIC_LABELS, type AccountAlert` from `./lib/alertsApi`; `accountAlertRequest` from `./lib/signals`.

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/AlertsSidebar.test.tsx && npx tsc -b && npx eslint src/AlertsSidebar.tsx src/AccountAlertModal.tsx src/PositionsPanel.tsx src/lib/alertsApi.ts src/app/useAlertFiredNotices.ts`
Expected: all passed; tsc and eslint clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/AlertsSidebar.tsx frontend/src/AlertsSidebar.test.tsx frontend/src/App.css
git commit -m "feat(alerts): Account group in the alerts panel"
```

---

### Task 13: Docs

**Files:**
- Modify: `CLAUDE.md` (the `## Alerts` section)

- [ ] **Step 1: Add the section**

Append under `## Alerts`:

```markdown
### Account alerts

`kind: "account"` rows (`broker` = exec key such as `capital-live:live`,
`epic` = `""`) watch an account figure (`marginLevel`, `openPnl`,
`openPnlPct`, `equity`, `available`, `drawdown`) with 1 to 3 tiers
(warn/danger/critical) that fire once when crossed and re-arm after a
hysteresis band. They are NOT in `alert_kinds.KINDS` and the price engine
skips them: `core/account_alert_kind.py` validates and signs them,
`core/account_monitor.py` (`ACCOUNT_MONITOR`) polls each account's
`get_account_summary` + `get_positions` (30 s, 5 s within 20% of the next
tier), computes figures with `core/account_metrics.py` (broker figures
only, so the value can differ from the dock when resting orders reserve
margin), owns their expiry and fires through the same broadcast/notifiers.
Per-alert state (fired tiers, drawdown peak) lives in `alert_meta` under
`account:<id>`. Only Capital and IG non-paper accounts are monitorable; MT5
is excluded so polling never keeps the MetaApi account deployed. Create and
patch are admin-only. A poll failure older than 120 s or a missing figure
reports the account unmonitored once (push + Telegram + `__alerts__:monitor`)
and "resumed" once. `GET /api/alerts/account-metrics?account=` serves the
dialog's current value. Frontend: bell on the dock stats
(`PositionsPanel.Stat`), `AccountAlertModal.tsx`, the "Account" group in
`AlertsSidebar.tsx`, `loadAccountAlerts` and friends in `lib/alertsApi.ts`.
Probe: `python3 -m scripts.alert_probe --account capital:demo --timeout 60`.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: account alerts"
```

---

## Self-review notes

- Spec coverage: data model (T2, T5), engine separation (T3), metrics (T1), monitor incl. tiers/drawdown/watchdog/expiry (T4), delivery branches (T6, T9), API (T5), frontend bell/modal/panel (T10 to T12), testing (each task), probe (T7), docs (T13). The spec's "patching tiers keeps state but drops removed fired levels; patching baseline clears peak" is in T4 `on_alert_changed` and tested.
- Type consistency: `AccountMetrics.value_of` (T1) used by T4; `evaluate_tiers`/`crossed_now`/`near_tier`/`headline`/`tier_label`/`account_label`/`cash_balance` (T2) used by T4; `ACCOUNT_MONITOR.on_alert_changed/statuses/account_status/metrics_for` (T4) used by T5; fire payload keys `headline/critical/account/metric/tierLabel` (T4) used by T6, T8, T9; `accountAlertRequest` (T8) used by T10 to T12; `Stat` props (T11) used by the mobile view.
- Review Focus pins: 1 → `test_no_positions_means_no_margin_level_and_nothing_missing` + `test_no_positions_holds_state_and_stays_monitored`; 2 → `test_patch_tiers_keeps_state_patch_baseline_resets_peak`; 3 → `test_missing_available_with_positions_is_reported` + `test_missing_figure_reports_unmonitored_then_resumed`; 4 → `test_falling_metric_fires_most_severe_once` + `test_fires_most_severe_tier_once_and_rearms`; 5 → `test_restart_keeps_fired_state`.
