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


def test_non_finite_figures_are_missing_not_numbers():
    # M2: NaN/inf from a broker can never fire or re-arm a tier; they must go
    # through the watchdog as a missing figure instead.
    s = {**CAPITAL, "available": float("nan")}
    m = account_metrics(s, [pos(-40, 700.0)], cash_balance=False)
    assert "available" in m.missing and m.available is None
    s = {**CAPITAL, "balance": float("inf")}
    m = account_metrics(s, [pos(-40, 700.0)], cash_balance=False)
    assert "balance" in m.missing and m.balance is None
