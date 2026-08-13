"""Buy momentum's dips: RSI pullback-and-recovery inside a rising trend. Long only.

• Trend filter: fast EMA above slow EMA, and the slow EMA rising (positive
  slope over the last 5 bars).
• Entry: RSI(14) was below the floor on the previous bar and is turning back
  up on this one — buying the dip, not the peak.
• Bracket: stop an ATR(14) multiple below entry, target an R-multiple of the
  stop distance above.
• Exit early if the fast EMA falls back below the slow EMA (trend gone)."""

meta = {
    "name": "Trend Pullback",
    "params": [
        {"name": "ema_fast", "label": "Fast EMA", "type": "int", "default": 20, "min": 2, "max": 200, "step": 1},
        {"name": "ema_slow", "label": "Slow EMA", "type": "int", "default": 50, "min": 2, "max": 400, "step": 1},
        {"name": "rsi_floor", "label": "RSI pullback floor", "type": "float", "default": 40, "min": 0, "max": 100},
        {"name": "stop_atr", "label": "Stop (ATR multiple)", "type": "float", "default": 2.0, "min": 0.1, "max": 50},
        {"name": "target_r", "label": "Target (R multiple)", "type": "float", "default": 1.5, "min": 0.1, "max": 50},
    ],
}


def on_bar(ctx):
    fast, slow = ctx.param("ema_fast"), ctx.param("ema_slow")
    ef, es = ctx.ema(fast), ctx.ema(slow)
    if ef is None or es is None:
        return []

    if ctx.position.is_long and ef < es:
        return [ctx.close_long(reason=f"EMA{fast} crossed below EMA{slow}")]

    rsi_now, rsi_prev = ctx.rsi(14), ctx.rsi(14, back=1)
    slow_slope = ctx.slope("EMA", slow, 5)
    atr = ctx.atr(14)
    have_all = None not in (rsi_now, rsi_prev, slow_slope, atr)
    if ctx.position.is_flat and have_all and ef > es and slow_slope > 0:
        floor = ctx.param("rsi_floor")
        if rsi_prev < floor and rsi_now > rsi_prev:
            stop = ctx.close - ctx.param("stop_atr") * atr
            if stop < ctx.close:
                return [ctx.buy(
                    sl=stop,
                    tp=ctx.close + ctx.param("target_r") * (ctx.close - stop),
                    reason=f"RSI recovering from below {floor} in uptrend",
                    note={"rsi": rsi_now, "rsi_prev": rsi_prev,
                          "ema_fast": ef, "ema_slow": es, "atr": atr},
                )]
    return []
