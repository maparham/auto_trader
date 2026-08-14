"""sim_consensus built-in strategy: warms up on simulated 1:1 longs replayed
from history, then trades real long when >=2 of the last 3 simulated longs won,
else real short. Simulated longs enter at bar close, resolve on the first bar
whose high/low reaches +/-1%; a bar that touches both levels counts as a loss.
"""

from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle
from auto_trader.engine.backtest import BacktestEngine
from auto_trader.strategy.coded import CodedStrategy
from auto_trader.strategy.loader import load_strategy


def bars(prices: list[tuple[float, float, float, float]]) -> list[Candle]:
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return [
        Candle(time=t0 + timedelta(hours=i), open=o, high=h, low=l, close=c)
        for i, (o, h, l, c) in enumerate(prices)
    ]


def run(prices: list[tuple[float, float, float, float]]):
    candles = bars(prices)
    module = load_strategy("sim_consensus.py")
    strat = CodedStrategy(module, candles, quantity=1.0)
    return BacktestEngine(strat).run(candles)


# Building blocks (entries always land on a 100.0 close, so simulated
# brackets sit at 101 / 99):
WIN = (100, 101.5, 99.5, 100)    # high tags +1%, low stays above -1%
LOSS = (100, 100.5, 98.5, 100)   # low tags -1%, high stays below +1%
BOTH = (100, 101.5, 98.5, 100)   # tags both levels inside one bar
FLAT = (100, 100.5, 99.5, 100)   # resolves nothing


def test_sim_chain_replays_once_not_per_bar():
    # The simulated-long chain is memoized via ctx.memo: one O(n) pass per run
    # instead of a full replay every bar (which made minute-resolution runs of
    # this strategy effectively hang).
    prices = [WIN, LOSS, WIN, FLAT] * 10
    candles = bars(prices)
    module = load_strategy("sim_consensus.py")
    calls = []
    orig = module._sim_chain
    module._sim_chain = lambda *a, **k: (calls.append(1), orig(*a, **k))[1]
    try:
        BacktestEngine(CodedStrategy(module, candles, quantity=1.0)).run(candles)
    finally:
        module._sim_chain = orig
    assert len(calls) == 1


def test_meta_declares_name_and_pct_params():
    module = load_strategy("sim_consensus.py")
    meta = module.meta
    assert meta["name"]
    by_name = {p["name"]: p for p in meta["params"]}
    for pname in ("sim_stop_pct", "sim_target_pct", "real_stop_pct", "real_target_pct"):
        assert by_name[pname]["default"] == 1.0


def test_no_trade_until_three_simulated_longs_complete():
    # sim1 wins (bar1), sim2 wins (bar2), sim3 never resolves -> only 2
    # completed simulated longs, so no real trade ever fires.
    result = run([FLAT, WIN, WIN, FLAT, FLAT, FLAT, FLAT])
    assert result.trades == []


def test_two_wins_of_three_opens_real_long():
    # sim record W, L, W -> real long. Decision on bar 3, fill at bar 4 open
    # (100), bracket 99 / 101; bar 5 tags the target.
    result = run([FLAT, WIN, LOSS, WIN, FLAT, (100, 101.5, 99.9, 101)])
    assert len(result.trades) == 1
    t = result.trades[0]
    assert t.leg == "long"
    assert t.entry_price == 100.0
    assert t.stop_initial == 99.0
    assert t.target == 101.0
    assert t.reason_out == "target"


def test_one_win_of_three_opens_real_short():
    # sim record W, L, L -> real short with a 1:1 bracket above/below entry.
    result = run([FLAT, WIN, LOSS, LOSS, FLAT, (100, 100.5, 98.9, 99)])
    assert len(result.trades) == 1
    t = result.trades[0]
    assert t.leg == "short"
    assert t.entry_price == 100.0
    assert t.stop_initial == 101.0
    assert t.target == 99.0
    assert t.reason_out == "target"


def test_bar_touching_both_levels_counts_as_loss():
    # sim record BOTH, BOTH, W. Counting both-touch bars as losses gives
    # L, L, W -> short; counting them as wins would give a long instead.
    result = run([FLAT, BOTH, BOTH, WIN, FLAT, (100, 100.5, 98.9, 99)])
    assert len(result.trades) == 1
    assert result.trades[0].leg == "short"


def test_rolling_window_keeps_trading_after_first_real_trade():
    # First real long closes at its target on bar 5; the simulated longs kept
    # running in the background, so a second real trade follows.
    result = run([
        FLAT, WIN, LOSS, WIN,          # warm-up: W, L, W -> long on bar 3
        FLAT,                          # fill at bar 4 open
        (100, 101.5, 99.9, 100),       # bar 5: real target hit; sim4 wins too
        FLAT,                          # room to re-enter
        (100, 101.5, 99.9, 100),       # bar 7: second target / sim resolution
        FLAT,
    ])
    assert len(result.trades) >= 2
    assert result.trades[0].leg == "long"
    assert result.trades[1].leg == "long"
