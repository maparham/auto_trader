"""Trend/regime breakout on 20-period, 3-deviation Bollinger Bands (after
Anthony Crudele). Band width classifies the regime; trades fire only on the
consolidation-to-trend transition.

• Consolidation (the squeeze): band width in the bottom percentile of its
  recent history, with the price range over the range lookback staying
  relatively sideways (height capped as a % of price).
• No trades inside the range (the middle of a consolidation is noise); only a
  confirmed break of the range edges matters.
• Transition to trend: band width expanding (above the squeeze width by a
  minimum %, and rising bar-over-bar) AND price closing beyond the
  consolidation range high/low for the confirming bar(s), within a limited
  window after the squeeze: late breaks are not chased.
• Entry in the breakout direction while flat, only inside the breakout
  window (a stop-out may re-enter while the window lasts; once the window
  closes the move is never chased).
• Stop anchored to the prior range: stop_range_frac slides it from the broken
  edge (0.0) to the far edge of the range (1.0). Target is target_r times the
  risk beyond entry.
• Optional regime kill-switch: entries require the Kaufman efficiency ratio
  (net move over path traveled) across er_lookback bars to reach min_er, so
  grinding chop markets are sat out. min_er 0 disables the gate.
• Optional flip guard: after a stop-out, entries in the OPPOSITE direction are
  skipped for flip_guard_bars bars — a failed break whose reversal also "breaks
  out" is the classic whipsaw chain. Same-direction re-entries stay allowed.
  flip_guard_bars 0 disables it (and live runs have no last-trade info yet, so
  the guard is backtest-only for now)."""

import numpy as np

meta = {
    "name": "BB Regime Breakout",
    "params": [
        {"name": "bb_period", "label": "BB period", "type": "int", "default": 20, "min": 2, "max": 200, "step": 1},
        {"name": "bb_dev", "label": "BB deviations", "type": "float", "default": 3.0, "min": 0.5, "max": 6.0},
        {"name": "squeeze_lookback", "label": "Squeeze lookback (bars)", "type": "int", "default": 60, "min": 10, "max": 500, "step": 1,
         "help": "Band-width history the squeeze percentile is measured against."},
        {"name": "squeeze_pctile", "label": "Squeeze percentile", "type": "float", "default": 25.0, "min": 1.0, "max": 100.0,
         "help": "Band width at or below this percentile of its lookback counts as consolidation."},
        {"name": "range_lookback", "label": "Range lookback (bars)", "type": "int", "default": 20, "min": 5, "max": 200, "step": 1,
         "help": "Bars ending at the squeeze that define the consolidation range."},
        {"name": "max_range_pct", "label": "Max range height %", "type": "float", "default": 4.0, "min": 0.1, "max": 50.0,
         "help": "Range height as % of its midpoint must stay under this to count as sideways."},
        {"name": "breakout_window", "label": "Breakout window (bars)", "type": "int", "default": 10, "min": 1, "max": 100, "step": 1,
         "help": "Max bars between the last squeeze bar and the first close beyond the range."},
        {"name": "confirm_bars", "label": "Confirm closes", "type": "int", "default": 1, "min": 1, "max": 10, "step": 1,
         "help": "Consecutive closes beyond the range edge required to confirm the break."},
        {"name": "min_expansion_pct", "label": "Min width expansion %", "type": "float", "default": 10.0, "min": 0.0, "max": 10000.0,
         "help": "Band width must exceed the squeeze-bar width by this % on entry."},
        {"name": "stop_range_frac", "label": "Stop depth (range frac)", "type": "float", "default": 1.0, "min": 0.0, "max": 1.5,
         "help": "0 = stop at the broken edge, 1 = at the far edge of the range."},
        {"name": "target_r", "label": "Target (R multiple)", "type": "float", "default": 2.0, "min": 0.1, "max": 50.0},
        {"name": "flip_guard_bars", "label": "Flip guard (bars)", "type": "int", "default": 0, "min": 0, "max": 1000, "step": 1,
         "help": "After a stop-out, skip entries in the OPPOSITE direction for this many bars (0 = off). "
                 "Same-direction re-entries stay allowed. Backtest-only: live runs have no last-trade info yet."},
        {"name": "er_lookback", "label": "Regime ER lookback (bars)", "type": "int", "default": 288, "min": 3, "max": 10000, "step": 1,
         "help": "Bars the efficiency-ratio regime gate is measured over (288 = one day of 5m bars)."},
        {"name": "min_er", "label": "Min efficiency ratio", "type": "float", "default": 0.0, "min": 0.0, "max": 1.0,
         "help": "Skip entries while |net move| / path traveled over the lookback is below this. 0 disables the gate."},
    ],
    # The UI keeps a BOLL chart overlay in sync with these params so the band
    # the strategy trades on is visible on the candles.
    "chart_overlays": [{"indicator": "BOLL", "calc_params": ["bb_period", "bb_dev"]}],
}


def _bandwidth(closes: np.ndarray, period: int, dev: float) -> np.ndarray:
    """Rolling Bollinger band width (upper-lower)/middle for every full window
    of `closes`; entry k covers closes[k .. k+period-1]."""
    win = np.lib.stride_tricks.sliding_window_view(closes, period)
    mid = win.mean(axis=1)
    sd = win.std(axis=1)
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(mid > 0, 2.0 * dev * sd / mid, np.inf)


def _sideways_range(highs, lows, i: int, p) -> tuple[float, float] | None:
    """THE consolidation gate, shared by _signal (entries) and chart_regions
    (shading) so the two can never drift: the trailing range_lookback bars
    ending at bar i, if their height stays under max_range_pct of the midpoint.
    Returns (range_high, range_low) or None."""
    r0 = i - p["range_lookback"] + 1
    if r0 < 0:
        return None
    rh = float(highs[r0: i + 1].max())
    rl = float(lows[r0: i + 1].min())
    mid = (rh + rl) / 2
    if mid <= 0 or (rh - rl) / mid * 100.0 > p["max_range_pct"]:
        return None
    return rh, rl


def chart_regions(candles, params) -> list[dict]:
    """Post-run chart viz hook: every squeeze window — consecutive bars whose
    band width sits in the squeeze percentile of its trailing lookback AND whose
    trailing price range stays sideways (_sideways_range, the SAME gate entries
    use) — including squeezes that never resolved into a breakout. Times are
    unix seconds; top/bottom bound the window's own bars. Vectorized
    full-series pass, run once after a backtest (never per bar)."""
    p = params
    closes = np.array([c.close for c in candles], dtype=np.float64)
    highs = np.array([c.high for c in candles], dtype=np.float64)
    lows = np.array([c.low for c in candles], dtype=np.float64)
    period, look, rl = p["bb_period"], p["squeeze_lookback"], p["range_lookback"]
    n = len(closes)
    if n < period + look:
        return []
    bw = _bandwidth(closes, period, p["bb_dev"])  # bw[k] = width AT bar period-1+k
    # Trailing percentile of the width over `look` widths ending at each bar.
    win = np.lib.stride_tricks.sliding_window_view(bw, look)
    thr = np.percentile(win, p["squeeze_pctile"], axis=1)
    squeeze = win[:, -1] <= thr  # squeeze[j] is bar period-1+look-1+j
    base = period + look - 2

    # _sideways_range, vectorized: rolling range over `rl` bars vs max_range_pct.
    # sideways[i] (i >= rl-1) mirrors _sideways_range(highs, lows, i, p) is not None.
    rmax = np.lib.stride_tricks.sliding_window_view(highs, rl).max(axis=1)
    rmin = np.lib.stride_tricks.sliding_window_view(lows, rl).min(axis=1)
    mid = (rmax + rmin) / 2
    with np.errstate(divide="ignore", invalid="ignore"):
        height_ok = np.where(mid > 0, (rmax - rmin) / mid * 100.0, np.inf)
    ok = height_ok <= p["max_range_pct"]  # ok[k] gates the range ENDING at bar k+rl-1

    def _sideways(i: int) -> bool:
        k = i - rl + 1
        return bool(ok[k]) if k >= 0 else False

    regions: list[dict] = []
    j = 0
    while j < len(squeeze):
        if not (squeeze[j] and _sideways(base + j)):
            j += 1
            continue
        start = j
        while j + 1 < len(squeeze) and squeeze[j + 1] and _sideways(base + j + 1):
            j += 1
        first, last = base + start, base + j
        regions.append({
            "from_time": candles[first].time.timestamp(),
            "to_time": candles[last].time.timestamp(),
            "top": float(highs[first: last + 1].max()),
            "bottom": float(lows[first: last + 1].min()),
            "label": "squeeze",
        })
        j += 1
    return regions


def _signal(i: int, closes, highs, lows, bw, bw_start: int, p) -> tuple[str, float, float, int] | None:
    """Evaluate the full breakout condition at bar i. Returns (leg, range_high,
    range_low, squeeze_bar) when a confirmed regime-transition breakout exists,
    else None. bw[k] is the band width at bar bw_start + k."""
    confirm, window = p["confirm_bars"], p["breakout_window"]

    # Most recent squeeze bar at least confirm_bars back: width at or below the
    # squeeze percentile of its trailing lookback. The loop's lower bound IS
    # the breakout window, anchored to the first confirming close (bar
    # i-confirm+1) — so a long confirmation can never make every squeeze bar
    # unreachable.
    look = p["squeeze_lookback"]
    j = None
    for cand in range(i - confirm, max(i - confirm - window, bw_start + look - 2), -1):
        k = cand - bw_start
        if k - look + 1 < 0:
            break
        hist = bw[k - look + 1: k + 1]
        if bw[k] <= np.percentile(hist, p["squeeze_pctile"]):
            j = cand
            break
    if j is None:
        return None

    # The consolidation range ending at the squeeze bar, and its sideways gate
    # (shared with chart_regions via _sideways_range — one predicate, no drift).
    rng = _sideways_range(highs, lows, j, p)
    if rng is None:
        return None
    rh, rl = rng

    # Regime transition: band width expanding out of the squeeze.
    bw_i, bw_j = bw[i - bw_start], bw[j - bw_start]
    if not (np.isfinite(bw_i) and np.isfinite(bw_j)):
        return None
    if bw_i < bw_j * (1 + p["min_expansion_pct"] / 100.0) or bw_i <= bw[i - 1 - bw_start]:
        return None

    # Directional break: all confirming closes beyond the range edge.
    tail = closes[i - confirm + 1: i + 1]
    if np.all(tail > rh):
        return ("long", rh, rl, j)
    if np.all(tail < rl):
        return ("short", rh, rl, j)
    return None


def on_bar(ctx):
    p = {name: ctx.param(name) for name in (
        "bb_period", "bb_dev", "squeeze_lookback", "squeeze_pctile",
        "range_lookback", "max_range_pct", "breakout_window", "confirm_bars",
        "min_expansion_pct", "stop_range_frac", "target_r",
        "flip_guard_bars", "er_lookback", "min_er",
    )}
    closes, highs, lows = ctx.closes, ctx.highs, ctx.lows
    i = len(closes) - 1
    period = p["bb_period"]
    # Oldest bar any evaluation can touch: band-width history for the squeeze
    # percentile at the earliest candidate squeeze bar, plus the BB window.
    span = p["squeeze_lookback"] + p["breakout_window"] + p["confirm_bars"] + 2
    if i + 1 < period + span or not ctx.position.is_flat:
        return []

    # Regime kill-switch: in a grinding market the net move is a small fraction
    # of the path traveled, and breakouts revert. Gate entries on the Kaufman
    # efficiency ratio over a long lookback; min_er 0 leaves it off.
    if p["min_er"] > 0:
        n = p["er_lookback"]
        if i < n:
            return []
        seg = closes[i - n: i + 1]
        path = float(np.abs(np.diff(seg)).sum())
        er = abs(float(seg[-1]) - float(seg[0])) / path if path > 0 else 1.0
        if er < p["min_er"]:
            return []

    # Band width over just the tail this bar can see (constant work per bar).
    bw_start = i - span - period + 1
    bw = _bandwidth(closes[bw_start:], period, p["bb_dev"])
    bw_start += period - 1  # bw[k] is the width AT bar bw_start + k

    sig = _signal(i, closes, highs, lows, bw, bw_start, p)
    if sig is None:
        return []

    # Level-triggered while flat: the breakout window bounds chasing (and any
    # re-entry after a stop-out); once it expires the signal dies on its own.
    leg, rh, rl, j = sig

    # Flip guard: a stop-out whose reversal immediately "breaks out" the other
    # way is the whipsaw chain — block only the OPPOSITE direction for a while,
    # so a genuine resumption of the original break can still re-enter.
    guard = p["flip_guard_bars"]
    if guard > 0:
        ex = ctx.last_exit
        if (ex is not None and ex.was_stop and ex.leg != leg
                and ex.bars_ago < guard):
            return []
    frac, height = p["stop_range_frac"], rh - rl
    note = {"range_high": rh, "range_low": rl, "band_width": float(bw[i - bw_start])}
    # The broken consolidation range as a chart zone: range lookback ending at
    # the squeeze bar, extended to the breakout bar so the shading meets the entry.
    zones = [ctx.zone(j - p["range_lookback"] + 1, i, rh, rl, label="consolidation range")]
    if leg == "long":
        # ctx.close > rh >= stop, so the bracket is always on the right side.
        stop = rh - frac * height
        return [ctx.buy(
            sl=stop, tp=ctx.close + p["target_r"] * (ctx.close - stop),
            reason=f"band expansion + break above range high {rh:.5g}", note=note,
            zones=zones,
        )]
    stop = rl + frac * height
    return [ctx.sell(
        sl=stop, tp=ctx.close - p["target_r"] * (stop - ctx.close),
        reason=f"band expansion + break below range low {rl:.5g}", note=note,
        zones=zones,
    )]
