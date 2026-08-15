"""Oracle baseline planner: the strategy's entries, direction and exit
corrected with perfect hindsight.

Fills happen at the NEXT bar's open (engine pending-signal semantics), so the
planner works in fill space: entry_fill/exit_fill are the bar indices whose
opens fill the trade, with exit_fill > entry_fill. Costs push against us:
buy at open + spread/2 + slippage, sell at open - spread/2 - slippage, plus a
flat commission per side.
"""
from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle, Side, Trade
from auto_trader.engine.oracle import PlannedTrade, plan_corrected, replay_planned

T0 = datetime(2026, 1, 1, tzinfo=timezone.utc)


def _candles(opens):
    return [
        Candle(time=T0 + timedelta(hours=i), open=o, high=o, low=o, close=o)
        for i, o in enumerate(opens)
    ]


def _trade(entry_bar, exit_bar, candles, side=Side.BUY, qty=1.0):
    e, x = candles[entry_bar], candles[exit_bar]
    return Trade(side=side, quantity=qty, entry_time=e.time, entry_price=e.open,
                 exit_time=x.time, exit_price=x.open, pnl=0.0,
                 leg="long" if side is Side.BUY else "short")


_NO_COSTS = dict(commission_per_side=0.0, spread=0.0, slippage=0.0)


def test_losing_long_is_flipped_to_short_with_best_exit_in_window():
    candles = _candles([100, 100, 90, 80, 85])
    plans = plan_corrected([_trade(1, 3, candles)], candles, **_NO_COSTS)
    assert [(p.leg, p.entry_fill, p.exit_fill, p.qty) for p in plans] == [
        ("short", 1, 3, 1.0)]


def test_winning_long_keeps_direction_but_takes_the_better_exit():
    candles = _candles([100, 100, 120, 110, 105])
    plans = plan_corrected([_trade(1, 3, candles)], candles, **_NO_COSTS)
    assert [(p.leg, p.entry_fill, p.exit_fill) for p in plans] == [("long", 1, 2)]


def test_same_bar_exit_window_still_allows_the_minimum_round_trip():
    # Intra-bar stop: entry and exit on the same bar. The oracle's earliest
    # possible exit fill is the next bar.
    candles = _candles([100, 100, 90, 95])
    plans = plan_corrected([_trade(1, 1, candles)], candles, **_NO_COSTS)
    assert [(p.leg, p.entry_fill, p.exit_fill) for p in plans] == [("short", 1, 2)]


def test_overlapping_same_leg_plans_are_serialized_for_close_all_semantics():
    candles = _candles([100, 100, 101, 102, 103, 104])
    trades = [_trade(1, 4, candles), _trade(2, 4, candles)]
    plans = plan_corrected(trades, candles, **_NO_COSTS)
    assert [(p.leg, p.entry_fill, p.exit_fill) for p in plans] == [
        ("long", 1, 2), ("long", 2, 4)]


def test_entry_on_the_last_signalable_bar_is_dropped():
    # A trade whose entry fill is the final bar has no later open to exit on.
    candles = _candles([100, 100, 110])
    plans = plan_corrected([_trade(2, 2, candles)], candles, **_NO_COSTS)
    assert plans == []


def test_trade_is_kept_even_when_its_best_outcome_loses_to_costs():
    # Gross moves: long (1,2) is +1, short (1,2) is -1; with spread 4 both lose
    # (buy at +2, sell at -2). The entry time is the constraint being measured,
    # so the least-bad option stays in the plan rather than being skipped.
    candles = _candles([100, 101, 102])
    plans = plan_corrected([_trade(1, 2, candles)], candles,
                           commission_per_side=0.0, spread=4.0, slippage=0.0)
    assert [(p.leg, p.entry_fill, p.exit_fill) for p in plans] == [("long", 1, 2)]


def test_range_end_trade_may_hold_to_the_final_close():
    # The engine force-closes a still-open position at the LAST bar's close
    # ("range end") — a price the open-only candidate loop can't reach. The
    # oracle must never underperform the real trade, so a range-end trade gets
    # the hold-to-end exit as a candidate: exit_fill == len(candles) means "no
    # exit signal; the engine's range-end close books it".
    candles = _candles([100, 100, 101, 102])
    last = candles[-1]
    candles[-1] = Candle(time=last.time, open=102, high=130, low=102, close=130)
    t = _trade(1, 3, candles)
    t = Trade(side=t.side, quantity=t.quantity, entry_time=t.entry_time,
              entry_price=t.entry_price, exit_time=last.time, exit_price=130.0,
              pnl=30.0, leg="long", reason_out="range end")
    plans = plan_corrected([t], candles, **_NO_COSTS)
    assert [(p.leg, p.entry_fill, p.exit_fill) for p in plans] == [("long", 1, 4)]


def test_target_exit_beating_every_open_is_kept_as_a_bracket_plan():
    # Intra-bar take-profit: the real trade filled at its target (110) on bar
    # 3, a price no open in the window comes near. Without that candidate the
    # oracle would underperform the run it is supposed to bound. The kept plan
    # carries target_level so the replay reproduces the intra-bar fill.
    candles = _candles([100, 100, 101, 102, 101])
    c3 = candles[3]
    candles[3] = Candle(time=c3.time, open=102, high=115, low=102, close=103)
    t = Trade(side=Side.BUY, quantity=1.0, entry_time=candles[1].time,
              entry_price=100.0, exit_time=c3.time, exit_price=110.0,
              pnl=10.0, leg="long", reason_out="target", target=110.0)
    plans = plan_corrected([t], candles, **_NO_COSTS)
    assert [(p.leg, p.entry_fill, p.exit_fill, p.target_level) for p in plans] == [
        ("long", 1, 3, 110.0)]


def test_target_exit_loses_to_a_better_open_and_is_not_kept():
    # A stop-like case in reverse: the target fill (101) is beaten by a later
    # open inside the window, so the ordinary open exit wins and no bracket is
    # attached.
    candles = _candles([100, 100, 101, 105, 104])
    t = Trade(side=Side.BUY, quantity=1.0, entry_time=candles[1].time,
              entry_price=100.0, exit_time=candles[3].time, exit_price=101.0,
              pnl=1.0, leg="long", reason_out="target", target=101.0)
    plans = plan_corrected([t], candles, **_NO_COSTS)
    assert [(p.leg, p.entry_fill, p.exit_fill, p.target_level) for p in plans] == [
        ("long", 1, 3, None)]


def test_signal_exited_trade_still_only_exits_at_opens():
    # Same shape, but the real trade exited via a signal at bar 3's open: the
    # final close was never available to it, so the oracle can't use it either.
    candles = _candles([100, 100, 101, 102])
    last = candles[-1]
    candles[-1] = Candle(time=last.time, open=102, high=130, low=102, close=130)
    plans = plan_corrected([_trade(1, 3, candles)], candles, **_NO_COSTS)
    assert [(p.leg, p.entry_fill, p.exit_fill) for p in plans] == [("long", 1, 3)]


# --- replay: planned trades executed through the real engine ---


def test_replay_bracket_plan_fills_intrabar_at_the_target():
    candles = _candles([100, 100, 101, 102, 101])
    c3 = candles[3]
    candles[3] = Candle(time=c3.time, open=102, high=115, low=102, close=103)
    plans = [PlannedTrade("long", 1, 3, 1.0, target_level=110.0)]
    res = replay_planned(plans, candles, starting_cash=10_000.0,
                         commission_per_side=0.0, spread=0.0, slippage=0.0)
    assert res.n_trades == 1
    assert res.trades[0].reason_out == "target"
    assert res.trades[0].exit_price == 110.0
    assert res.net_pnl == 10.0


def test_replay_hold_to_end_books_at_the_final_close():
    candles = _candles([100, 100, 101, 102])
    last = candles[-1]
    candles[-1] = Candle(time=last.time, open=102, high=130, low=102, close=130)
    plans = [PlannedTrade("long", 1, 4, 1.0)]
    res = replay_planned(plans, candles, starting_cash=10_000.0,
                         commission_per_side=0.0, spread=0.0, slippage=0.0)
    assert res.n_trades == 1
    assert res.trades[0].reason_out == "range end"
    assert res.net_pnl == 130 - 100


def test_replay_matches_hand_computed_net_pnl():
    candles = _candles([100, 110, 105, 115])
    # short (1,2): sell 110-1, buy 105+1, minus 2 commission -> +1
    # long  (2,3): buy 105+1, sell 115-1, minus 2 commission -> +6
    plans = [PlannedTrade("short", 1, 2, 1.0), PlannedTrade("long", 2, 3, 1.0)]
    res = replay_planned(plans, candles, starting_cash=10_000.0,
                         commission_per_side=1.0, spread=2.0, slippage=0.0)
    assert res.net_pnl == 7.0
    assert res.n_trades == 2
    assert sorted((t.leg, t.entry_time, t.exit_time) for t in res.trades) == [
        ("long", candles[2].time, candles[3].time),
        ("short", candles[1].time, candles[2].time),
    ]


def test_replay_exit_and_reentry_on_the_same_fill_bar():
    # Corrected plans serialized per leg close and reopen on the same open.
    candles = _candles([100, 100, 101, 102, 103, 104])
    plans = [PlannedTrade("long", 1, 2, 1.0), PlannedTrade("long", 2, 4, 1.0)]
    res = replay_planned(plans, candles, starting_cash=10_000.0,
                         commission_per_side=0.0, spread=0.0, slippage=0.0)
    assert res.n_trades == 2
    assert res.net_pnl == (101 - 100) + (103 - 101)
