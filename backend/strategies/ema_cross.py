"""EMA fast/slow crossover with an RSI filter. Longs only.
Attaches a %-based stop and target; exits early when RSI tops the ceiling.

Higher-timeframe values: ctx.ema(9, tf="HOUR_4"); slopes: ctx.slope("EMA", 9, 3)."""

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
    if ctx.position.is_flat and ctx.ema(fast) is not None and ctx.ema(slow) is not None:
        if ctx.ema(fast) > ctx.ema(slow) and (ctx.rsi(14) or 0) < ctx.param("rsi_max"):
            return [ctx.buy(
                sl=ctx.close * (1 - ctx.param("stop_pct") / 100),
                tp=ctx.close * (1 + ctx.param("target_pct") / 100),
                reason=f"EMA{fast}>EMA{slow} & RSI<{ctx.param('rsi_max')}",
                note={"ema_fast": ctx.ema(fast), "ema_slow": ctx.ema(slow), "rsi": ctx.rsi(14)},
            )]
    if ctx.position.is_long and (ctx.rsi(14) or 0) > ctx.param("rsi_max"):
        return [ctx.close_long(reason=f"RSI>{ctx.param('rsi_max')}")]
    return []
