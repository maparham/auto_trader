"""Buy when a fast EMA crosses above a slow EMA and RSI isn't overbought. Long only.

• The fast EMA crosses above the slow EMA on this bar (was at/below it last bar).
• RSI(14) is below the ceiling.
• Close the long when RSI(14) rises above the ceiling."""

meta = {
    "name": "EMA Cross + RSI",
    "params": [
        {"name": "ema_fast", "label": "Fast EMA", "type": "int", "default": 9, "min": 2, "max": 200, "step": 1},
        {"name": "ema_slow", "label": "Slow EMA", "type": "int", "default": 21, "min": 2, "max": 400, "step": 1},
        {"name": "rsi_max", "label": "RSI ceiling", "type": "float", "default": 70, "min": 0, "max": 100},
        {"name": "stop_pct", "label": "Stop %", "type": "float", "default": 2.0, "min": 0.1, "max": 20},
        {"name": "target_pct", "label": "Target %", "type": "float", "default": 4.0, "min": 0.1, "max": 50},
    ],
}


def on_bar(ctx):
    fast, slow = ctx.param("ema_fast"), ctx.param("ema_slow")
    now_fast, now_slow = ctx.ema(fast), ctx.ema(slow)
    prev_fast, prev_slow = ctx.ema(fast, back=1), ctx.ema(slow, back=1)
    have_all = None not in (now_fast, now_slow, prev_fast, prev_slow)
    if ctx.position.is_flat and have_all:
        crossed_up = prev_fast <= prev_slow and now_fast > now_slow
        if crossed_up and (ctx.rsi(14) or 0) < ctx.param("rsi_max"):
            return [ctx.buy(
                sl=ctx.close * (1 - ctx.param("stop_pct") / 100),
                tp=ctx.close * (1 + ctx.param("target_pct") / 100),
                reason=f"EMA{fast} crossed above EMA{slow} & RSI<{ctx.param('rsi_max')}",
                note={"ema_fast": now_fast, "ema_slow": now_slow, "rsi": ctx.rsi(14)},
            )]
    if ctx.position.is_long and (ctx.rsi(14) or 0) > ctx.param("rsi_max"):
        return [ctx.close_long(reason=f"RSI>{ctx.param('rsi_max')}")]
    return []
