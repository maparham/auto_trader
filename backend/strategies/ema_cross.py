"""EMA(9)/EMA(21) crossover with an RSI(14) < 70 filter. Longs only.
Attaches a 2% stop and 4% target; exits early when RSI tops 70.

Higher-timeframe values: ctx.ema(9, tf="HOUR_4"); slopes: ctx.slope("EMA", 9, 3)."""

meta = {"name": "EMA Cross + RSI"}


def on_bar(ctx):
    if ctx.position.is_flat and ctx.ema(9) is not None and ctx.ema(21) is not None:
        if ctx.ema(9) > ctx.ema(21) and (ctx.rsi(14) or 0) < 70:
            return [ctx.buy(
                sl=ctx.close * 0.98, tp=ctx.close * 1.04,
                reason="EMA9>EMA21 & RSI<70",
                note={"ema9": ctx.ema(9), "ema21": ctx.ema(21), "rsi": ctx.rsi(14)},
            )]
    if ctx.position.is_long and (ctx.rsi(14) or 0) > 70:
        return [ctx.close_long(reason="RSI>70")]
    return []
