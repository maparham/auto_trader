"""Enter when the trend is accelerating, not merely present. Long only.

• Slope of the EMA, in percent per bar, measured over the last `slope_bars`
  bars — and the same slope one window earlier for comparison.
• Entry: slope above the minimum AND rising by more than the acceleration
  margin versus the earlier window.
• Exit: slope flattens below the exit threshold. An ATR(14) stop rides along
  as disaster protection; no target — the flattening slope is the exit."""

meta = {
    "name": "Slope Acceleration",
    "params": [
        {"name": "ema_len", "label": "EMA length", "type": "int", "default": 20, "min": 2, "max": 200, "step": 1},
        {"name": "slope_bars", "label": "Slope window (bars)", "type": "int", "default": 5, "min": 2, "max": 50, "step": 1},
        {"name": "min_slope_pct", "label": "Min slope (%/bar)", "type": "float", "default": 0.05, "min": 0.0, "max": 5.0},
        {"name": "accel_min_pct", "label": "Min acceleration (%/bar)", "type": "float", "default": 0.01, "min": 0.0, "max": 5.0},
        {"name": "exit_slope_pct", "label": "Exit slope (%/bar)", "type": "float", "default": 0.0, "min": -5.0, "max": 5.0},
        {"name": "stop_atr", "label": "Stop (ATR multiple)", "type": "float", "default": 2.0, "min": 0.1, "max": 50},
    ],
}


def _slope_pct(newer, older, n):
    """EMA slope in percent per bar between two readings n bars apart."""
    if newer is None or older is None or older == 0:
        return None
    return (newer - older) / older * 100 / n


def on_bar(ctx):
    length, n = ctx.param("ema_len"), ctx.param("slope_bars")
    e0, e1, e2 = ctx.ema(length), ctx.ema(length, back=n), ctx.ema(length, back=2 * n)
    slope_now = _slope_pct(e0, e1, n)
    slope_prev = _slope_pct(e1, e2, n)
    if slope_now is None:
        return []

    if ctx.position.is_long and slope_now < ctx.param("exit_slope_pct"):
        return [ctx.close_long(reason=f"EMA{length} slope flattened to {slope_now:.3f}%/bar")]

    atr = ctx.atr(14)
    if ctx.position.is_flat and slope_prev is not None and atr is not None:
        accelerating = slope_now - slope_prev >= ctx.param("accel_min_pct")
        if slope_now >= ctx.param("min_slope_pct") and accelerating:
            return [ctx.buy(
                sl=ctx.close - ctx.param("stop_atr") * atr,
                reason=f"EMA{length} slope {slope_now:.3f}%/bar and accelerating",
                note={"slope_now": slope_now, "slope_prev": slope_prev, "atr": atr},
            )]
    return []
