"""Stay long while the fast EMA is above the slow EMA, short while it's below.

• Fast EMA above slow EMA → hold long (close any short first, go long once flat).
• Fast EMA below slow EMA → hold short (close any long first, go short once flat).

A reversal flattens on the flip bar and opens the new side on the next bar
(netted execution can't reverse in a single bar). No stop/target — the
opposite EMA state is the exit."""

meta = {
    "name": "EMA Trend (long/short)",
    "params": [
        {"name": "ema_fast", "label": "Fast EMA", "type": "int", "default": 9, "min": 2, "max": 200, "step": 1},
        {"name": "ema_slow", "label": "Slow EMA", "type": "int", "default": 21, "min": 2, "max": 400, "step": 1},
    ],
}


def on_bar(ctx):
    fast, slow = ctx.param("ema_fast"), ctx.param("ema_slow")
    ef, es = ctx.ema(fast), ctx.ema(slow)
    if ef is None or es is None:
        return []
    if ef > es:
        if ctx.position.is_short:
            return [ctx.close_short(reason=f"EMA{fast}>EMA{slow} — flip to long")]
        if ctx.position.is_flat:
            return [ctx.buy(reason=f"EMA{fast}>EMA{slow}", note={"ema_fast": ef, "ema_slow": es})]
    elif ef < es:
        if ctx.position.is_long:
            return [ctx.close_long(reason=f"EMA{fast}<EMA{slow} — flip to short")]
        if ctx.position.is_flat:
            return [ctx.sell(reason=f"EMA{fast}<EMA{slow}", note={"ema_fast": ef, "ema_slow": es})]
    return []
