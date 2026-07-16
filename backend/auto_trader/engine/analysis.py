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


_BAR_METRICS = (
    "bars_held", "bars_in_profit", "bars_in_loss", "body_through",
    "wick_from_profit", "wick_from_loss", "longest_profit_streak",
    "longest_loss_streak", "bars_to_mfe", "bars_to_mae", "entry_crossings",
)


def _avg_bar_metrics(group: list[dict]) -> dict:
    """Mean of each bar metric over the group. All-None for an empty group. The
    client derives each count's share of bars held for display, so no ratio is
    aggregated here."""
    if not group:
        return {m: None for m in _BAR_METRICS}
    return {m: sum(t[m] for t in group) / len(group) for m in _BAR_METRICS}


def _bar_dynamics(trades: list[dict]) -> dict:
    """Winners, losers, and all-trades averages of the per-trade bar-count
    dynamics. A trade is eligible only if it carries bar stats (older runs
    predate the fields and are skipped); when nothing is eligible every group is
    all-None and the client hides the section. `total` is the pooled average
    over all eligible trades, not the sum of the winner and loser averages."""
    eligible = [t for t in trades if t.get("bars_held") is not None]
    winners = [t for t in eligible if t["pnl"] > 0]
    losers = [t for t in eligible if t["pnl"] < 0]
    return {
        "n_winners": len(winners),
        "n_losers": len(losers),
        "n_total": len(eligible),
        "total": _avg_bar_metrics(eligible),
        "winners": _avg_bar_metrics(winners),
        "losers": _avg_bar_metrics(losers),
    }


def _nice_bucket_width(max_bars: int, target: int = 8) -> int:
    """Round bar-count per duration bucket, chosen so the run spans roughly
    `target` buckets. Widths follow a 1-2-5 progression so bucket edges land on
    round bar counts (and therefore round duration multiples on the client)."""
    if max_bars <= target:
        return 1
    raw = max_bars / target
    for cand in (1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000):
        if cand >= raw:
            return cand
    return 10000


def _duration_hist(trades: list[dict], width: int | None = None) -> dict | None:
    """Winner/loser trade counts bucketed by how long each trade was held.

    Buckets are equal spans of `bar_width` bars (bucket i covers held-bar counts
    [i*bar_width, (i+1)*bar_width)); the client turns each span into a duration
    range using the run resolution. Bucket width is chosen dynamically from the
    longest hold. Returns None when no trade carries bar stats (older runs), so
    the client hides the chart. Break-even trades (pnl == 0) are eligible but
    counted in neither series, matching `_bar_dynamics`.

    When `width` is forced (not None), that width is used instead of one derived
    from this subset. This keeps per-leg histograms aligned with the all-trades
    width, since the client renders one x-axis (from ALL) and indexes the per-leg
    arrays positionally. A forced-width call with no eligible trades returns an
    empty split ({"bar_width": width, "winners": [], "losers": []}) rather than
    None, so an empty leg renders as a zero split instead of collapsing the whole
    chart to no-split."""
    eligible = [t for t in trades if t.get("bars_held") is not None]
    if not eligible:
        if width is not None:
            return {"bar_width": width, "winners": [], "losers": []}
        return None
    max_bars = max(int(t["bars_held"]) for t in eligible)
    if width is None:
        width = _nice_bucket_width(max_bars)
    n_buckets = max_bars // width + 1
    winners = [0] * n_buckets
    losers = [0] * n_buckets
    for t in eligible:
        i = int(t["bars_held"]) // width
        if t["pnl"] > 0:
            winners[i] += 1
        elif t["pnl"] < 0:
            losers[i] += 1
    return {"bar_width": width, "winners": winners, "losers": losers}


def _analysis_for(trades: list[dict]) -> dict:
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
        "bar_dynamics": _bar_dynamics(trades),
        "duration_hist": _duration_hist(trades),
        "whatif": compute_whatif(trades),
    }


def _partition_by_leg(trades: list[dict]) -> tuple[list[dict], list[dict]]:
    """Split trades on `leg`; a missing or empty leg counts as long, matching
    the engine default (Signal.leg)."""
    longs = [t for t in trades if (t.get("leg") or "long") == "long"]
    shorts = [t for t in trades if (t.get("leg") or "long") == "short"]
    return longs, shorts


def rolling_expectancy(trades: list[dict], min_trades: int = 12) -> dict | None:
    """Rolling mean P&L per trade over an adaptive window (max(10, n//5)),
    ordered by entry time. The first point lands once a full window exists, so
    the series answers "was the edge stable, seasonal, or fading" without the
    noisy warm-up prefix. None below min_trades."""
    seq = sorted((t for t in trades if t.get("entry_time") is not None),
                 key=lambda t: t["entry_time"])
    n = len(seq)
    if n < min_trades:
        return None
    window = max(10, n // 5)
    points = []
    for i in range(window - 1, n):
        chunk = seq[i - window + 1 : i + 1]
        points.append({
            "t": seq[i]["entry_time"],
            "expectancy": round(sum(t["pnl"] for t in chunk) / window, 5),
        })
    return {"window": window, "points": points}


def compute_analysis(trades: list[dict]) -> dict:
    """All-trades analysis payload plus a per-direction split. `by_leg.long` and
    `by_leg.short` are full analysis payloads (whatif included) over that side's
    trades only; they do not nest a further by_leg. Sequence-derived numbers
    (streaks, consecutive counts) are per-leg subsequences by construction."""
    longs, shorts = _partition_by_leg(trades)
    payload = _analysis_for(trades)
    long_payload = _analysis_for(longs)
    short_payload = _analysis_for(shorts)
    # Force each leg's duration histogram onto ALL's bucket width so the client,
    # which renders the x-axis from ALL and indexes the per-leg arrays
    # positionally, lines each leg's bars up under the correct duration labels.
    all_dh = payload.get("duration_hist")
    if all_dh is not None:
        w = all_dh["bar_width"]
        long_payload["duration_hist"] = _duration_hist(longs, width=w)
        short_payload["duration_hist"] = _duration_hist(shorts, width=w)
    payload["by_leg"] = {"long": long_payload, "short": short_payload}
    payload["rolling"] = rolling_expectancy(trades)
    return payload
