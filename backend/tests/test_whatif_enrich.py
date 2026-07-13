"""enrich_trades_whatif: per-trade counterfactual stamps (rule-exit replay,
no-target replay, fill-delay cost, limit-entry replay), None when inputs are
missing, never fabricated."""

from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle, Side, Trade
from auto_trader.engine.whatif import enrich_trades_whatif

T0 = datetime(2026, 1, 5, tzinfo=timezone.utc)


def _mk(bars):
    return [
        Candle(time=T0 + timedelta(hours=i), open=o, high=h, low=lo, close=c, volume=0.0)
        for i, (o, h, lo, c) in enumerate(bars)
    ]


def _trade(entry_i, exit_i, *, entry=100.0, exit_=101.0, leg="long",
           reason="rule", stop_initial=95.0, stop_final=95.0, target=110.0):
    return Trade(
        side=Side.BUY if leg == "long" else Side.SELL, quantity=1.0,
        entry_time=T0 + timedelta(hours=entry_i), entry_price=entry,
        exit_time=T0 + timedelta(hours=exit_i), exit_price=exit_, pnl=exit_ - entry,
        leg=leg, reason_in="rule", reason_out=reason,
        stop_initial=stop_initial, stop_final=stop_final, target=target,
    )


def test_rule_exit_would_have_won():
    # Rule exit at bar3 open=101; bars 3..4 then run to the 110 target.
    candles = _mk([
        (100, 101, 99, 100),   # 0 signal bar (close 100)
        (100, 103, 98, 102),   # 1 entry fill at open 100
        (102, 104, 100, 103),  # 2
        (101, 105, 100, 104),  # 3 rule exit fills at open 101
        (104, 111, 103, 110),  # 4 would have hit target 110
    ])
    t = _trade(1, 3, exit_=101.0)
    enrich_trades_whatif([t], candles)
    w = t.whatif["rule_exit"]
    assert w["would_have"] == "won"
    # cf_r = (110-100)/5 = 2.0; actual_r = (101-100)/5 = 0.2; delta = 1.8
    assert w["delta_r"] == 1.8


def test_rule_exit_would_have_lost_and_short_leg():
    # Short rule exit at bar2 open=99 (profit); afterwards price rallies to the
    # 104 stop: holding would have LOST.
    candles = _mk([
        (100, 101, 99, 100),   # 0 signal
        (100, 101, 97, 98),    # 1 short entry at 100
        (99, 100, 97, 98),     # 2 rule exit at open 99
        (99, 105, 98, 104),    # 3 stop 104 hit
    ])
    t = _trade(1, 2, exit_=99.0, leg="short", stop_initial=104.0,
               stop_final=104.0, target=90.0)
    enrich_trades_whatif([t], candles)
    w = t.whatif["rule_exit"]
    assert w["would_have"] == "lost"
    # risk 4; cf_r = (100-104)/4 = -1.0; actual_r = (100-99)/4 = 0.25
    assert w["delta_r"] == -1.25


def test_rule_exit_excluded_for_mechanical_reasons_and_no_bracket():
    candles = _mk([(100, 101, 99, 100)] * 4)
    stop_out = _trade(1, 2, reason="stop")
    no_bracket = _trade(1, 2, stop_initial=None, stop_final=None, target=None)
    enrich_trades_whatif([stop_out, no_bracket], candles)
    assert stop_out.whatif["rule_exit"] is None
    assert no_bracket.whatif["rule_exit"] is None


def test_no_target_counterfactual():
    # Target exit at bar2; afterwards price falls to the 95 stop.
    candles = _mk([
        (100, 101, 99, 100),   # 0 signal
        (100, 111, 99, 110),   # 1 entry 100, target 110 hit intrabar
        (110, 110, 94, 95),    # 2 would-have-stopped bar
    ])
    t = _trade(1, 1, exit_=110.0, reason="target")
    enrich_trades_whatif([t], candles)
    w = t.whatif["no_target"]
    assert w["would_have"] == "stopped"
    # cf_r = (95-100)/5 = -1.0; actual_r = (110-100)/5 = 2.0; delta = -3.0
    assert w["delta_r"] == -3.0


def test_no_target_survived_gives_none_delta():
    candles = _mk([(100, 111, 99, 110), (110, 111, 109, 110)])
    t = _trade(0, 0, exit_=110.0, reason="target")
    enrich_trades_whatif([t], candles)
    assert t.whatif["no_target"] == {"would_have": "survived", "delta_r": None}


def test_fill_delay_r():
    # Signal close 100, long fill at 102: delay cost (102-100)/risk 5 = 0.4.
    candles = _mk([
        (100, 101, 99, 100),
        (102, 103, 101, 102),
    ])
    t = _trade(1, 1, entry=102.0, exit_=103.0, stop_initial=97.0, stop_final=97.0)
    enrich_trades_whatif([t], candles)
    assert t.whatif["fill_delay_r"] == 0.4


def test_fill_delay_none_on_bar0_fill():
    candles = _mk([(100, 101, 99, 100), (100, 101, 99, 100)])
    t = _trade(0, 1)
    enrich_trades_whatif([t], candles)
    assert t.whatif["fill_delay_r"] is None


def test_limit_entry_fills_and_improves():
    # Signal close 100; actual fill bar1 open 102. Limit 100 fills bar2
    # (low 99 <= 100). Re-anchored bracket from 100 (stop dist 5, target dist 8
    # from the actual entry 102): stop 95, target 108; bar3 hits 108.
    candles = _mk([
        (100, 101, 99, 100),    # 0 signal
        (102, 103, 101, 102),   # 1 actual fill at 102 (limit not touched)
        (101, 102, 99, 100),    # 2 limit 100 fills
        (100, 109, 99, 108),    # 3 target 108 hit
    ])
    t = _trade(1, 3, entry=102.0, exit_=108.0, reason="target",
               stop_initial=97.0, stop_final=97.0, target=110.0)
    enrich_trades_whatif([t], candles)
    w = t.whatif["limit_entry"]
    assert w["filled"] is True
    # risk = |102-97| = 5. cf move (108-100)=8 -> 1.6R; actual (108-102)=6 -> 1.2R
    assert w["delta_r"] == 0.4


def test_limit_entry_never_fills_reports_foregone():
    # Price never returns to the signal close within the 3-bar window.
    candles = _mk([
        (100, 101, 99, 100),    # 0 signal (close 100)
        (102, 104, 101, 103),   # 1 actual fill 102
        (103, 105, 102, 104),   # 2
        (104, 106, 103, 105),   # 3 window ends
        (105, 111, 104, 110),   # 4
    ])
    t = _trade(1, 4, entry=102.0, exit_=110.0, reason="target",
               stop_initial=97.0, stop_final=97.0, target=110.0)
    enrich_trades_whatif([t], candles)
    w = t.whatif["limit_entry"]
    assert w["filled"] is False
    # foregone = actual realized R = (110-102)/5 = 1.6
    assert w["foregone_r"] == 1.6


def test_unknown_times_leave_whatif_scenarios_none():
    candles = _mk([(100, 101, 99, 100)] * 3)
    t = _trade(1, 2)
    t.entry_time = T0 + timedelta(days=30)
    t.exit_time = T0 + timedelta(days=30)
    enrich_trades_whatif([t], candles)
    assert t.whatif["rule_exit"] is None
    assert t.whatif["fill_delay_r"] is None
    assert t.whatif["limit_entry"] is None


def test_empty_inputs_no_crash():
    enrich_trades_whatif([], _mk([(100, 101, 99, 100)]))
    t = _trade(0, 0)
    enrich_trades_whatif([t], [])
    assert t.whatif is None


def test_breakeven_never_arms():
    # Long from 100, risk 5 (stop 95). Price never reaches +0.5R (=102.5),
    # so no level arms.
    candles = _mk([
        (100, 101, 99, 100),   # 0 signal
        (100, 101, 99, 100),   # 1 entry at open 100
        (100, 101, 99, 100),   # 2
        (100, 101, 99, 100),   # 3 exit
    ])
    t = _trade(1, 3, exit_=100.0, stop_initial=95.0, target=110.0)
    enrich_trades_whatif([t], candles)
    be = {r["frac"]: r for r in t.whatif["breakeven_stop"]}
    assert all(not r["armed"] and not r["fired"] for r in be.values())


def test_breakeven_arms_then_returns_fires():
    # Long from 100, risk 5. Bar2 runs to 108 (mfe +1.6R), bar3 drops back to
    # entry 100 then exits at 99. Every trigger <= 1.5R arms; all armed levels
    # fire because price returns to entry after the peak.
    candles = _mk([
        (100, 101, 99, 100),   # 0 signal
        (100, 101, 99, 100),   # 1 entry at 100
        (101, 108, 100, 107),  # 2 peak 108
        (107, 107, 99, 99),    # 3 drops through entry 100, exits 99
    ])
    t = _trade(1, 3, exit_=99.0, stop_initial=95.0, target=110.0)
    enrich_trades_whatif([t], candles)
    be = {r["frac"]: r for r in t.whatif["breakeven_stop"]}
    assert be[0.5]["armed"] and be[0.5]["fired"]
    assert be[1.0]["armed"] and be[1.0]["fired"]
    assert be[1.5]["armed"] and be[1.5]["fired"]
    assert not be[2.0]["armed"]  # peak 108 = +1.6R, below +2R (=110)


def test_breakeven_arms_and_runs_no_fire():
    # Long from 100, risk 5. Monotonic climb to a 110 target, never revisits
    # entry: armed levels do NOT fire.
    candles = _mk([
        (100, 101, 99, 100),   # 0 signal
        (100, 103, 100, 102),  # 1 entry at 100
        (102, 106, 102, 105),  # 2 +1R reached (105)
        (105, 111, 105, 110),  # 3 target 110, low never back to 100
    ])
    t = _trade(1, 3, exit_=110.0, stop_initial=95.0, target=110.0)
    enrich_trades_whatif([t], candles)
    be = {r["frac"]: r for r in t.whatif["breakeven_stop"]}
    assert be[0.5]["armed"] and not be[0.5]["fired"]
    assert be[1.0]["armed"] and not be[1.0]["fired"]


def test_breakeven_short_arms_then_returns_fires():
    # Short from 100, risk 4 (stop 104). Bar2 drops to 94 (mfe +1.5R), bar3
    # rallies back through entry 100 and exits 101.
    candles = _mk([
        (100, 101, 99, 100),   # 0 signal
        (100, 101, 99, 100),   # 1 short entry at 100
        (99, 100, 94, 95),     # 2 favorable to 94
        (95, 101, 95, 101),    # 3 rallies through entry, exits 101
    ])
    t = _trade(1, 3, exit_=101.0, leg="short", stop_initial=104.0,
               stop_final=104.0, target=90.0)
    enrich_trades_whatif([t], candles)
    be = {r["frac"]: r for r in t.whatif["breakeven_stop"]}
    assert be[0.5]["armed"] and be[0.5]["fired"]
    assert be[1.0]["armed"] and be[1.0]["fired"]
    assert be[1.5]["armed"] and be[1.5]["fired"]


def test_breakeven_per_trigger_divergence():
    # Long from 100, risk 5. Early dip fires the 0.5 level; a later higher peak
    # arms 1.5 AFTER the dip and never returns to entry, so 1.5 does not fire.
    candles = _mk([
        (100, 101, 99, 100),   # 0 signal
        (100, 103, 100, 102),  # 1 entry 100; hits +0.5R (102.5)? high 103 -> arms 0.5
        (102, 102, 100, 100),  # 2 back to entry 100 -> 0.5 fires here
        (100, 109, 100, 108),  # 3 climbs to 108 -> arms 1.5 (>=107.5), low 100 not below entry
        (108, 111, 107, 110),  # 4 exit at target 110, low 107 never back to 100
    ])
    t = _trade(1, 4, exit_=110.0, stop_initial=95.0, target=110.0)
    enrich_trades_whatif([t], candles)
    be = {r["frac"]: r for r in t.whatif["breakeven_stop"]}
    assert be[0.5]["armed"] and be[0.5]["fired"]
    assert be[1.5]["armed"] and not be[1.5]["fired"]


def test_breakeven_ineligible_no_stop_initial():
    candles = _mk([(100, 101, 99, 100), (100, 108, 99, 107)])
    t = _trade(1, 1, exit_=107.0, stop_initial=None, stop_final=None)
    enrich_trades_whatif([t], candles)
    assert t.whatif["breakeven_stop"] is None


def test_breakeven_no_fire_from_retrace_after_exit_bar():
    # Long from 100, risk 5. Arms at 0.5R and runs to a 110 target at bar3
    # without retracing. Bar4 exists AFTER the exit and drops back to entry;
    # the fire scan must stop at exit_i (bar3), so 0.5 stays armed but not fired.
    candles = _mk([
        (100, 101, 99, 100),   # 0 signal
        (100, 103, 100, 102),  # 1 entry 100, arms 0.5 (high 103 >= 102.5)
        (102, 106, 102, 105),  # 2 climb, low never back to 100
        (105, 111, 105, 110),  # 3 exit at target 110
        (110, 110, 99, 100),   # 4 after exit: low 99 would fire if scanned
    ])
    t = _trade(1, 3, exit_=110.0, stop_initial=95.0, target=110.0)
    enrich_trades_whatif([t], candles)
    be = {r["frac"]: r for r in t.whatif["breakeven_stop"]}
    assert be[0.5]["armed"] and not be[0.5]["fired"]
