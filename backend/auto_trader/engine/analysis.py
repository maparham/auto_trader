"""Aggregate per-run analytics over TradeDTO-shaped trade dicts.

Operates on plain dicts (not Trade dataclasses) so one code path serves both
the live BacktestResponse and re-computation from run-store JSON. Winner =
pnl > 0, loser = pnl < 0 (plain sign — the engine's commission-aware win_rate
remains the headline number in `summary`). Group rows with n < 5 are flagged
low_sample rather than hidden. Zero trades produce an empty-but-valid payload.
"""

from __future__ import annotations

from datetime import datetime, timezone
from statistics import median

MAE_EDGES = [0.25, 0.5, 0.75, 1.0]
# Edges sit on half-R lines so each bucket is centered on a whole R value: a
# clean stop realizes exactly -1.0R and lands in the middle of the -1R bucket
# rather than on a boundary. Buckets: <=-3R, -2R, -1R, 0R, +1R, +2R, >=+3R.
R_EDGES = [-2.5, -1.5, -0.5, 0.5, 1.5, 2.5]
NEAR_STOP_R = 0.8
LOW_SAMPLE_N = 5
CONTEXT_FEATURES = ("trend", "vol_regime", "session", "candle_pattern", "day_of_week")


def _hist(values: list[float], edges: list[float]) -> dict:
    """Counts per bucket: (-inf, e0], (e0, e1], ..., (eN, +inf) -> len(edges)+1."""
    counts = [0] * (len(edges) + 1)
    for v in values:
        i = 0
        while i < len(edges) and v > edges[i]:
            i += 1
        counts[i] += 1
    return {"edges": edges, "counts": counts}


def _realized_r(t: dict) -> float | None:
    """Signed R-multiple of the realized price move vs the initial stop distance."""
    stop = t.get("stop_initial")
    if stop is None:
        return None
    risk = abs(t["entry_price"] - stop)
    if risk <= 0:
        return None
    move = t["exit_price"] - t["entry_price"]
    if t.get("leg") == "short":
        move = -move
    return move / risk


def _rows(trades: list[dict], key) -> list[dict]:
    groups: dict[str, list[dict]] = {}
    for t in trades:
        groups.setdefault(str(key(t)), []).append(t)
    rows = []
    for bucket, ts in groups.items():
        pnls = [t["pnl"] for t in ts]
        rows.append({
            "bucket": bucket,
            "n": len(ts),
            "win_rate": sum(1 for p in pnls if p > 0) / len(ts),
            "expectancy": sum(pnls) / len(ts),
            "net_pnl": sum(pnls),
            "low_sample": len(ts) < LOW_SAMPLE_N,
        })
    rows.sort(key=lambda r: -r["n"])
    return rows


def _hour_stats(trades: list[dict]) -> list[dict]:
    """Per-UTC-hour sufficient statistics for the time-of-day breakdown.

    Emits additive counts (n, wins, sum_pnl) rather than finished rows because
    the client regroups them into local-timezone-aligned buckets; win_rate and
    expectancy are derived on the client from these. A win is pnl > 0, matching
    _rows. Trades with no context or no hour_utc are skipped."""
    groups: dict[int, list[float]] = {}
    for t in trades:
        h = (t.get("context") or {}).get("hour_utc")
        if h is None:
            continue
        groups.setdefault(int(h), []).append(t["pnl"])
    return [
        {"hour": h, "n": len(pnls),
         "wins": sum(1 for p in pnls if p > 0),
         "sum_pnl": round(sum(pnls), 5)}
        for h, pnls in sorted(groups.items())
    ]


def _month_stats(trades: list[dict]) -> list[dict]:
    """Per-calendar-month rows (YYYY-MM, UTC) for the monthly breakdown.

    Same row shape and win/expectancy/low_sample definitions as _rows, but
    sorted chronologically rather than by count. Returns [] when trades span
    fewer than two distinct months, so a single-month run shows no table.
    Trades with no entry_time are skipped. Month is taken in UTC, matching how
    day_of_week is derived; a trade within hours of a month boundary could fall
    in an adjacent month under a distant timezone (accepted imprecision)."""
    groups: dict[str, list[dict]] = {}
    for t in trades:
        ts = t.get("entry_time")
        if ts is None:
            continue
        key = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m")
        groups.setdefault(key, []).append(t)
    if len(groups) < 2:
        return []
    rows = []
    for month, ts_group in sorted(groups.items()):
        pnls = [t["pnl"] for t in ts_group]
        rows.append({
            "bucket": month,
            "n": len(ts_group),
            "win_rate": sum(1 for p in pnls if p > 0) / len(ts_group),
            "expectancy": sum(pnls) / len(ts_group),
            "net_pnl": sum(pnls),
            "low_sample": len(ts_group) < LOW_SAMPLE_N,
        })
    return rows


def compute_analysis(trades: list[dict]) -> dict:
    winners = [t for t in trades if t["pnl"] > 0]
    losers = [t for t in trades if t["pnl"] < 0]

    w_mae = [t["mae_r"] for t in winners if t.get("mae_r") is not None]
    l_mae = [t["mae_r"] for t in losers if t.get("mae_r") is not None]
    sl = {
        "winners_mae_hist": _hist(w_mae, MAE_EDGES),
        "losers_mae_hist": _hist(l_mae, MAE_EDGES),
        "winners_near_stop_pct": (
            sum(1 for m in w_mae if m >= NEAR_STOP_R) / len(w_mae) if w_mae else None
        ),
        "n_with_r": sum(1 for t in trades if t.get("mae_r") is not None),
    }

    w_pairs = [
        (t["mfe_r"], _realized_r(t))
        for t in winners
        if t.get("mfe_r") is not None and _realized_r(t) is not None
    ]
    nontarget = [
        t for t in trades
        if t.get("target") is not None and t.get("reason") != "target"
        and t.get("mfe") is not None
    ]
    reached = [
        t for t in nontarget
        if t["mfe"] >= abs(t["target"] - t["entry_price"])
    ]
    tp = {
        "avg_winner_mfe_r": sum(m for m, _ in w_pairs) / len(w_pairs) if w_pairs else None,
        "avg_winner_realized_r": sum(r for _, r in w_pairs) / len(w_pairs) if w_pairs else None,
        "median_left_on_table_r": median(m - r for m, r in w_pairs) if w_pairs else None,
        "pct_nontarget_exits_reached_target": (
            len(reached) / len(nontarget) if nontarget else None
        ),
    }

    realized = [r for r in (_realized_r(t) for t in trades) if r is not None]

    def _ctx(feature):
        return _rows(trades, lambda t, f=feature: (
            (t.get("context") or {}).get(f) if (t.get("context") or {}).get(f) is not None
            else "unknown"
        ))

    from auto_trader.engine.whatif import compute_whatif  # local: avoids cycle

    return {
        "n_trades": len(trades),
        "sl": sl,
        "tp": tp,
        "exit_reasons": _rows(trades, lambda t: t.get("reason") or "unknown"),
        "r_hist": _hist(realized, R_EDGES),
        "context": {f: _ctx(f) for f in CONTEXT_FEATURES},
        "hour_stats": _hour_stats(trades),
        "month_stats": _month_stats(trades),
        "whatif": compute_whatif(trades),
    }
