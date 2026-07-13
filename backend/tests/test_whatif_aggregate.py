"""compute_whatif: pure aggregates over TradeDTO-shaped dicts carrying the
per-trade whatif stamps; every section is None when no trade feeds it."""

from auto_trader.engine.whatif import compute_whatif


def _t(pnl, *, entry=100.0, exit_=None, stop=95.0, leg="long", reason="rule",
       mae_r=None, mfe_r=None, whatif=None):
    return {
        "pnl": pnl, "leg": leg, "entry_price": entry,
        "exit_price": exit_ if exit_ is not None else entry + pnl,
        "stop_initial": stop, "reason": reason,
        "mae_r": mae_r, "mfe_r": mfe_r, "whatif": whatif,
    }


def test_all_none_when_nothing_enriched():
    out = compute_whatif([_t(1.0), _t(-1.0)])
    assert out == {"rule_exit": None, "no_target": None, "stop_curve": None,
                   "target_curve": None, "fill_delay": None, "limit_entry": None,
                   "breakeven_curve": None}


def test_rule_exit_by_reason_and_totals():
    trades = [
        _t(1.0, reason="Sell to Close",
           whatif={"rule_exit": {"would_have": "won", "delta_r": 1.8}}),
        _t(0.5, reason="Sell to Close",
           whatif={"rule_exit": {"would_have": "lost", "delta_r": -1.2}}),
        _t(0.2, reason="session close",
           whatif={"rule_exit": {"would_have": "undecided", "delta_r": None}}),
        _t(-1.0, reason="stop", whatif={"rule_exit": None}),
    ]
    out = compute_whatif(trades)["rule_exit"]
    rows = {r["reason"]: r for r in out["by_reason"]}
    assert rows["Sell to Close"] == {"reason": "Sell to Close", "n": 2,
        "would_have_won": 1, "would_have_lost": 1, "undecided": 0,
        "net_delta_r": 0.6}
    assert rows["session close"]["undecided"] == 1
    assert out["totals"]["n"] == 3 and out["totals"]["net_delta_r"] == 0.6


def test_no_target_net_saved():
    trades = [
        _t(10.0, reason="target",
           whatif={"no_target": {"would_have": "stopped", "delta_r": -3.0}}),
        _t(10.0, reason="target",
           whatif={"no_target": {"would_have": "survived", "delta_r": None}}),
    ]
    out = compute_whatif(trades)["no_target"]
    # saved = actual minus counterfactual = -delta; one stopped trade at -3.0.
    assert out == {"n": 2, "would_have_stopped": 1, "survived": 1,
                   "net_saved_r": 3.0}


def test_stop_curve():
    # Winner (realized +2R) with mae_r 0.6; loser (realized -1R) with mae_r 1.0.
    trades = [
        _t(10.0, exit_=110.0, mae_r=0.6),
        _t(-5.0, exit_=95.0, mae_r=1.0),
    ]
    curve = {row["frac"]: row for row in compute_whatif(trades)["stop_curve"]}
    # f=0.5: both stopped -> winner delta (-0.5 - 2) = -2.5; loser (-0.5 - -1) = +0.5
    assert curve[0.5] == {"frac": 0.5, "winners_killed": 1,
                          "losers_cheapened": 1, "net_delta_r": -2.0}
    # f=0.8: winner survives (0.6 < 0.8); loser cheapened by 0.2
    assert curve[0.8] == {"frac": 0.8, "winners_killed": 0,
                          "losers_cheapened": 1, "net_delta_r": 0.2}
    # f=1.0: loser unchanged (mae_r >= 1.0 -> outcome -1.0 == realized)
    assert curve[1.0]["net_delta_r"] == 0.0


def test_target_curve():
    trades = [_t(10.0, mfe_r=3.0), _t(-5.0, mfe_r=0.4), _t(2.0, mfe_r=1.0)]
    curve = {row["target_r"]: row for row in compute_whatif(trades)["target_curve"]}
    assert curve[0.5] == {"target_r": 0.5, "n_reached": 2, "pct_reached": 2 / 3}
    assert curve[3.0]["n_reached"] == 1
    assert curve[5.0]["n_reached"] == 0


def test_fill_delay_and_limit_entry():
    trades = [
        _t(1.0, whatif={"fill_delay_r": 0.4,
                         "limit_entry": {"filled": True, "delta_r": 0.4}}),
        _t(2.0, whatif={"fill_delay_r": 0.2,
                         "limit_entry": {"filled": True, "delta_r": None}}),
        _t(3.0, whatif={"fill_delay_r": None,
                         "limit_entry": {"filled": False, "foregone_r": 1.6}}),
    ]
    out = compute_whatif(trades)
    assert out["fill_delay"] == {"n": 2, "avg_r": 0.3, "total_r": 0.6}
    le = out["limit_entry"]
    assert le == {"n": 3, "fill_rate": 2 / 3, "filled_net_delta_r": 0.4,
                  "undecided": 1, "unfilled_foregone_r": 1.6,
                  "unfilled_winners": 1, "net_verdict_r": -1.2}


def _be(frac_flags):
    # frac_flags: {frac: (armed, fired)} -> the stamp list for one trade.
    return [{"frac": f, "armed": a, "fired": fi} for f, (a, fi) in frac_flags.items()]


def test_breakeven_curve_none_when_no_stamps():
    out = compute_whatif([_t(1.0), _t(-1.0)])
    assert out["breakeven_curve"] is None


def test_breakeven_curve_rescues_and_cuts():
    # Loser: realized -1R, fires at 0.5 -> rescued, delta +1.
    loser = _t(-5.0, stop=95.0, whatif={
        "breakeven_stop": _be({0.5: (True, True), 1.0: (False, False),
                               1.5: (False, False), 2.0: (False, False),
                               3.0: (False, False)})})
    # Winner: realized +2R (exit 110), armed+fired at 0.5 -> cut, delta -2.
    winner = _t(10.0, exit_=110.0, stop=95.0, whatif={
        "breakeven_stop": _be({0.5: (True, True), 1.0: (True, False),
                               1.5: (True, False), 2.0: (True, False),
                               3.0: (False, False)})})
    curve = compute_whatif([loser, winner])["breakeven_curve"]
    row = {r["frac"]: r for r in curve}
    assert row[0.5]["n_armed"] == 2 and row[0.5]["n_fired"] == 2
    assert row[0.5]["losers_rescued"] == 1 and row[0.5]["winners_cut"] == 1
    # net = (+1) + (-2) = -1
    assert row[0.5]["net_delta_r"] == -1.0
    # At 1.0 only the winner armed, and it did not fire.
    assert row[1.0]["n_armed"] == 1 and row[1.0]["n_fired"] == 0
    assert row[1.0]["net_delta_r"] == 0.0


def test_breakeven_curve_skips_ineligible_stamp():
    # A trade with breakeven_stop None must not appear in any count.
    good = _t(-5.0, stop=95.0, whatif={
        "breakeven_stop": _be({0.5: (True, True), 1.0: (False, False),
                               1.5: (False, False), 2.0: (False, False),
                               3.0: (False, False)})})
    bad = _t(-5.0, stop=95.0, whatif={"breakeven_stop": None})
    row = {r["frac"]: r for r in compute_whatif([good, bad])["breakeven_curve"]}
    assert row[0.5]["n_armed"] == 1 and row[0.5]["n_fired"] == 1


def test_breakeven_curve_zero_realized_fired_lands_in_neither_bucket():
    # A trade that exits exactly at entry (realized 0R) and fires counts as
    # fired but belongs to neither rescued (< 0) nor cut (> 0), and adds 0
    # to the net.
    flat = _t(0.0, exit_=100.0, stop=95.0, whatif={
        "breakeven_stop": _be({0.5: (True, True), 1.0: (False, False),
                               1.5: (False, False), 2.0: (False, False),
                               3.0: (False, False)})})
    row = {r["frac"]: r for r in compute_whatif([flat])["breakeven_curve"]}
    assert row[0.5]["n_armed"] == 1 and row[0.5]["n_fired"] == 1
    assert row[0.5]["losers_rescued"] == 0 and row[0.5]["winners_cut"] == 0
    assert row[0.5]["net_delta_r"] == 0.0
