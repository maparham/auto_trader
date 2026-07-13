"""Per-trade what-if counterfactuals for backtest analysis.

Replay-based scenarios (exit-rule counterfactual, target counterfactual,
pullback limit entry) walk candles forward with the SAME pessimistic intrabar
bracket rules as BacktestEngine._intrabar_exit: an open gapping through the
target resolves as target first, then stop by bar range, then target by bar
range. No slippage is modelled: counterfactuals compare price levels.

All results are per-trade attribution. They deliberately ignore knock-on
effects on later trades (single-position netting means a longer hold could
have blocked the next entry), so any finding should be confirmed with a real
rerun or sweep before acting on it.

Enrichment is best-effort and mutates trade.whatif (JSON-safe scalars only),
same pattern as context_features.enrich_trades; aggregates are pure functions
over TradeDTO-shaped dicts so the live response and the run-store recompute
share one code path.
"""

from __future__ import annotations

from auto_trader.core.models import Candle, Trade
from auto_trader.engine.analysis import _realized_r

REPLAY_HORIZON = 500      # max bars a replay walks; beyond -> undecided
LIMIT_FILL_WINDOW = 3     # bars a v1 limit entry stays working
STOP_CURVE_FRACS = [round(0.1 * k, 1) for k in range(1, 11)]      # 0.1 .. 1.0
TARGET_CURVE_RS = [round(0.5 * k, 1) for k in range(1, 11)]       # 0.5 .. 5.0
BE_TRIGGER_RS = [0.5, 1.0, 1.5, 2.0, 3.0]


def replay_bracket(
    candles: list[Candle],
    start: int,
    leg: str,
    stop: float | None,
    target: float | None,
    horizon: int = REPLAY_HORIZON,
) -> tuple[str, int | None]:
    """Outcome of holding a bracket from bar `start` (inclusive): ("target" |
    "stop" | "undecided", exit bar index or None). Undecided when both levels
    are None, `start` is past the array, or the horizon/data ends first."""
    if stop is None and target is None:
        return ("undecided", None)
    end = min(len(candles), start + horizon)
    for i in range(max(start, 0), end):
        bar = candles[i]
        if leg == "long":
            if target is not None and bar.open >= target:
                return ("target", i)
            if stop is not None and bar.low <= stop:
                return ("stop", i)
            if target is not None and bar.high >= target:
                return ("target", i)
        else:
            if target is not None and bar.open <= target:
                return ("target", i)
            if stop is not None and bar.high >= stop:
                return ("stop", i)
            if target is not None and bar.low <= target:
                return ("target", i)
    return ("undecided", None)


RULE_EXIT_MECHANICAL = {"stop", "trail", "target", "range end"}


def _signed_r(level: float, entry: float, risk: float, leg: str) -> float:
    """Signed R of a move from entry to `level` (positive = in the trade's favor)."""
    move = level - entry if leg == "long" else entry - level
    return move / risk


def _rule_exit(trade: Trade, candles, exit_i: int, risk: float, actual_r: float):
    if trade.reason_out in RULE_EXIT_MECHANICAL:
        return None
    if trade.stop_final is None and trade.target is None:
        return None
    outcome, _ = replay_bracket(candles, exit_i, trade.leg,
                                stop=trade.stop_final, target=trade.target)
    if outcome == "target":
        cf = _signed_r(trade.target, trade.entry_price, risk, trade.leg)
        return {"would_have": "won", "delta_r": round(cf - actual_r, 4)}
    if outcome == "stop":
        cf = _signed_r(trade.stop_final, trade.entry_price, risk, trade.leg)
        return {"would_have": "lost", "delta_r": round(cf - actual_r, 4)}
    return {"would_have": "undecided", "delta_r": None}


def _no_target(trade: Trade, candles, exit_i: int, risk: float, actual_r: float):
    if trade.reason_out != "target" or trade.stop_final is None:
        return None
    outcome, _ = replay_bracket(candles, exit_i, trade.leg,
                                stop=trade.stop_final, target=None)
    if outcome == "stop":
        cf = _signed_r(trade.stop_final, trade.entry_price, risk, trade.leg)
        return {"would_have": "stopped", "delta_r": round(cf - actual_r, 4)}
    return {"would_have": "survived", "delta_r": None}


def _fill_delay(trade: Trade, candles, entry_i: int, risk: float):
    """Cost of the one-bar honest fill vs entering at the signal close, in R
    (positive = the delay cost money)."""
    if entry_i == 0:
        return None
    sig_close = candles[entry_i - 1].close
    cost = ((trade.entry_price - sig_close) if trade.leg == "long"
            else (sig_close - trade.entry_price)) / risk
    return round(cost, 4)


def _limit_entry(trade: Trade, candles, entry_i: int, risk: float, actual_r: float):
    if entry_i == 0:
        return None
    limit = candles[entry_i - 1].close  # v1: limit at the signal close (offset 0)
    fill_i = None
    fill_px = None
    for i in range(entry_i, min(entry_i + LIMIT_FILL_WINDOW, len(candles))):
        bar = candles[i]
        if trade.leg == "long" and bar.low <= limit:
            fill_i, fill_px = i, min(bar.open, limit)
            break
        if trade.leg == "short" and bar.high >= limit:
            fill_i, fill_px = i, max(bar.open, limit)
            break
    if fill_i is None:
        return {"filled": False, "foregone_r": round(actual_r, 4)}
    # Re-anchor the recorded stop/target DISTANCES to the better entry price;
    # deltas stay in the ORIGINAL risk units so they compare to actual_r.
    # Accepted v1 limitation: for a trailed trade whose stop_final crossed to
    # the profit side of entry, abs(entry_price - stop_final) is no longer the
    # original risk distance, so the re-anchored counterfactual stop lands on
    # the loss side and distorts the delta for that trade.
    sign = 1 if trade.leg == "long" else -1
    stop = (fill_px - sign * abs(trade.entry_price - trade.stop_final)
            ) if trade.stop_final is not None else None
    target = (fill_px + sign * abs(trade.target - trade.entry_price)
              ) if trade.target is not None else None
    outcome, _ = replay_bracket(candles, fill_i, trade.leg, stop=stop, target=target)
    if outcome == "undecided":
        return {"filled": True, "delta_r": None}
    hit = target if outcome == "target" else stop
    cf = _signed_r(hit, fill_px, risk, trade.leg)
    return {"filled": True, "delta_r": round(cf - actual_r, 4)}


def _breakeven_stop(trade: Trade, candles, entry_i: int, exit_i: int,
                    risk: float, leg: str) -> list[dict]:
    """Per profit trigger, whether a breakeven-stop overlay would arm (price
    first reaches entry +/- frac*risk within [entry_i, exit_i]) and then fire
    (a LATER bar in that span retraces to the entry price). Bar high/low
    touches; firing strictly after the arming bar avoids same-bar lookahead."""
    entry = trade.entry_price
    end = min(len(candles) - 1, exit_i)
    rows = []
    for frac in BE_TRIGGER_RS:
        trigger = entry + frac * risk if leg == "long" else entry - frac * risk
        arm_i = None
        for i in range(max(entry_i, 0), end + 1):
            bar = candles[i]
            reached = bar.high >= trigger if leg == "long" else bar.low <= trigger
            if reached:
                arm_i = i
                break
        fired = False
        if arm_i is not None:
            for j in range(arm_i + 1, end + 1):
                bar = candles[j]
                back = bar.low <= entry if leg == "long" else bar.high >= entry
                if back:
                    fired = True
                    break
        rows.append({"frac": frac, "armed": arm_i is not None, "fired": fired})
    return rows


def enrich_trades_whatif(trades: list[Trade], candles: list[Candle]) -> None:
    """Stamp trade.whatif per the what-if spec. A trade missing what a scenario
    needs gets that key None; a trade with no locatable times or no stop_initial
    (no R basis) gets every scenario None. Empty candles leave whatif None."""
    if not trades or not candles:
        return
    index = {c.time: i for i, c in enumerate(candles)}
    for trade in trades:
        entry_i = index.get(trade.entry_time)
        exit_i = index.get(trade.exit_time)
        risk = (abs(trade.entry_price - trade.stop_initial)
                if trade.stop_initial is not None else 0.0)
        if risk <= 0:
            trade.whatif = {"rule_exit": None, "no_target": None,
                            "fill_delay_r": None, "limit_entry": None,
                            "breakeven_stop": None}
            continue
        actual_r = _signed_r(trade.exit_price, trade.entry_price, risk, trade.leg)
        trade.whatif = {
            "rule_exit": (_rule_exit(trade, candles, exit_i, risk, actual_r)
                          if exit_i is not None else None),
            "no_target": (_no_target(trade, candles, exit_i, risk, actual_r)
                          if exit_i is not None else None),
            "fill_delay_r": (_fill_delay(trade, candles, entry_i, risk)
                             if entry_i is not None else None),
            "limit_entry": (_limit_entry(trade, candles, entry_i, risk, actual_r)
                            if entry_i is not None else None),
            "breakeven_stop": (
                _breakeven_stop(trade, candles, entry_i, exit_i, risk, trade.leg)
                if entry_i is not None and exit_i is not None else None),
        }


def _round4(x: float) -> float:
    return round(x, 4)


def compute_whatif(trades: list[dict]) -> dict:
    """Aggregate the per-trade whatif stamps (dict-based: serves the live
    response and the run-store recompute identically). Sections with no
    eligible trades are None, never empty placeholders."""
    w = [t.get("whatif") or {} for t in trades]

    # A: rule-exit counterfactual, grouped by exit reason.
    rule = [(t, x["rule_exit"]) for t, x in zip(trades, w) if x.get("rule_exit")]
    rule_exit = None
    if rule:
        groups: dict[str, list[dict]] = {}
        for t, r in rule:
            groups.setdefault(t.get("reason") or "unknown", []).append(r)

        def _row(reason, rs):
            return {
                "reason": reason,
                "n": len(rs),
                "would_have_won": sum(1 for r in rs if r["would_have"] == "won"),
                "would_have_lost": sum(1 for r in rs if r["would_have"] == "lost"),
                "undecided": sum(1 for r in rs if r["would_have"] == "undecided"),
                "net_delta_r": _round4(sum(r["delta_r"] or 0.0 for r in rs)),
            }

        by_reason = sorted((_row(k, v) for k, v in groups.items()),
                           key=lambda r: -r["n"])
        totals = _row("", [r for _, r in rule])
        totals.pop("reason")
        rule_exit = {"by_reason": by_reason, "totals": totals}

    # B: target counterfactual.
    nt = [x["no_target"] for x in w if x.get("no_target")]
    no_target = None
    if nt:
        stopped = [r for r in nt if r["would_have"] == "stopped"]
        no_target = {
            "n": len(nt),
            "would_have_stopped": len(stopped),
            "survived": len(nt) - len(stopped),
            # what the target saved = actual minus counterfactual = -delta
            "net_saved_r": _round4(-sum(r["delta_r"] or 0.0 for r in stopped)),
        }

    # C: stop-tightening curve from stored mae_r + realized R.
    cr = [(t["mae_r"], _realized_r(t)) for t in trades
          if t.get("mae_r") is not None and _realized_r(t) is not None]
    stop_curve = None
    if cr:
        stop_curve = []
        for f in STOP_CURVE_FRACS:
            hit = [(m, r) for m, r in cr if m >= f]
            stop_curve.append({
                "frac": f,
                "winners_killed": sum(1 for m, r in hit if r > 0),
                "losers_cheapened": sum(1 for m, r in hit if r < 0),
                "net_delta_r": _round4(sum(-f - r for m, r in hit)),
            })

    # D: target-placement curve from stored mfe_r (hit rate only; censored at
    # each trade's actual target, which scenario B un-censors).
    mfes = [t["mfe_r"] for t in trades if t.get("mfe_r") is not None]
    target_curve = None
    if mfes:
        target_curve = [
            {"target_r": tr, "n_reached": sum(1 for m in mfes if m >= tr),
             "pct_reached": sum(1 for m in mfes if m >= tr) / len(mfes)}
            for tr in TARGET_CURVE_RS
        ]

    # E: fill-delay cost.
    delays = [x["fill_delay_r"] for x in w if x.get("fill_delay_r") is not None]
    fill_delay = None
    if delays:
        fill_delay = {"n": len(delays),
                      "avg_r": _round4(sum(delays) / len(delays)),
                      "total_r": _round4(sum(delays))}

    # F: pullback limit entry.
    le = [x["limit_entry"] for x in w if x.get("limit_entry")]
    limit_entry = None
    if le:
        filled = [r for r in le if r["filled"]]
        unfilled = [r for r in le if not r["filled"]]
        filled_net = sum(r["delta_r"] or 0.0 for r in filled)
        foregone = sum(r["foregone_r"] for r in unfilled)
        limit_entry = {
            "n": len(le),
            "fill_rate": len(filled) / len(le),
            "filled_net_delta_r": _round4(filled_net),
            "undecided": sum(1 for r in filled if r["delta_r"] is None),
            "unfilled_foregone_r": _round4(foregone),
            "unfilled_winners": sum(1 for r in unfilled if r["foregone_r"] > 0),
            "net_verdict_r": _round4(filled_net - foregone),
        }

    # G: breakeven-stop overlay curve from per-trade arm/fire stamps + realized R.
    be_rows = [(t.get("whatif") or {}).get("breakeven_stop") for t in trades]
    be_pairs = [(rows, _realized_r(t)) for t, rows in zip(trades, be_rows)
                if rows is not None and _realized_r(t) is not None]
    breakeven_curve = None
    if be_pairs:
        breakeven_curve = []
        for k, frac in enumerate(BE_TRIGGER_RS):
            armed = [(rows[k], r) for rows, r in be_pairs if rows[k]["armed"]]
            fired = [(cell, r) for cell, r in armed if cell["fired"]]
            breakeven_curve.append({
                "frac": frac,
                "n_armed": len(armed),
                "n_fired": len(fired),
                "losers_rescued": sum(1 for _, r in fired if r < 0),
                "winners_cut": sum(1 for _, r in fired if r > 0),
                "net_delta_r": _round4(sum(-r for _, r in fired)),
            })

    return {"rule_exit": rule_exit, "no_target": no_target,
            "stop_curve": stop_curve, "target_curve": target_curve,
            "fill_delay": fill_delay, "limit_entry": limit_entry,
            "breakeven_curve": breakeven_curve}
