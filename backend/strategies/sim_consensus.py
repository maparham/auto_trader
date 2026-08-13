"""Warm up on simulated longs, then trade with the recent consensus.

• Replay simulated 1:1 longs from history: enter at bar close, win when the
  target (+1%) is reached before the stop (-1%); a bar touching both counts
  as a loss. The next simulated long opens at the close of the resolving bar.
• Once at least 3 simulated longs have completed and the strategy is flat:
  open a real long if at least 2 of the last 3 won, else a real short,
  bracketed 1:1 around the entry.
• Simulated longs keep running in the background, so real trades chain
  back-to-back with a fresh last-3 record each time."""

meta = {
    "name": "Simulated Consensus",
    "params": [
        {"name": "sim_stop_pct", "label": "Sim stop %", "type": "float", "default": 1.0, "min": 0.1, "max": 20},
        {"name": "sim_target_pct", "label": "Sim target %", "type": "float", "default": 1.0, "min": 0.1, "max": 20},
        {"name": "real_stop_pct", "label": "Real stop %", "type": "float", "default": 1.0, "min": 0.1, "max": 20},
        {"name": "real_target_pct", "label": "Real target %", "type": "float", "default": 1.0, "min": 0.1, "max": 20},
    ],
}


def on_bar(ctx):
    highs, lows, closes = ctx.highs, ctx.lows, ctx.closes
    stop_frac = ctx.param("sim_stop_pct") / 100
    target_frac = ctx.param("sim_target_pct") / 100

    # Deterministic replay of the simulated-long chain over the full history
    # (the stateless contract forbids carrying state between bars).
    outcomes = []  # True = win, in completion order
    entry = closes[0]
    for i in range(1, len(closes)):
        hit_target = highs[i] >= entry * (1 + target_frac)
        hit_stop = lows[i] <= entry * (1 - stop_frac)
        if hit_target or hit_stop:
            outcomes.append(hit_target and not hit_stop)  # both in one bar = loss
            entry = closes[i]

    if not ctx.position.is_flat or len(outcomes) < 3:
        return []

    wins = sum(outcomes[-3:])
    record = "".join("W" if w else "L" for w in outcomes[-3:])
    note = {"sim_record": record, "sim_completed": len(outcomes)}
    sl_frac = ctx.param("real_stop_pct") / 100
    tp_frac = ctx.param("real_target_pct") / 100
    if wins >= 2:
        return [ctx.buy(
            sl=ctx.close * (1 - sl_frac), tp=ctx.close * (1 + tp_frac),
            reason=f"{wins}/3 recent simulated longs won", note=note,
        )]
    return [ctx.sell(
        sl=ctx.close * (1 + sl_frac), tp=ctx.close * (1 - tp_frac),
        reason=f"only {wins}/3 recent simulated longs won", note=note,
    )]
