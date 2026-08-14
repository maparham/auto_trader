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


import bisect


def _sim_chain(candles, stop_frac: float, target_frac: float):
    """Deterministic replay of the whole simulated-long chain: parallel lists
    of completion bar index and outcome (True = win), in completion order.
    Causal by construction — the chain only ever walks forward — so slicing at
    the current bar index (bisect) yields exactly what that bar may know."""
    completed_at: list[int] = []
    outcomes: list[bool] = []
    entry = candles[0].close
    for i in range(1, len(candles)):
        hit_target = candles[i].high >= entry * (1 + target_frac)
        hit_stop = candles[i].low <= entry * (1 - stop_frac)
        if hit_target or hit_stop:
            completed_at.append(i)
            outcomes.append(hit_target and not hit_stop)  # both in one bar = loss
            entry = candles[i].close
    return completed_at, outcomes


def on_bar(ctx):
    stop_frac = ctx.param("sim_stop_pct") / 100
    target_frac = ctx.param("sim_target_pct") / 100

    # The chain replay is one memoized O(n) pass over the run (a per-bar replay
    # was O(n²) — minutes of wall-clock on minute-resolution histories); each
    # bar then reads its causal prefix of the completed outcomes.
    completed_at, all_outcomes = ctx.memo(
        f"sim_chain:{stop_frac}:{target_frac}",
        lambda candles: _sim_chain(candles, stop_frac, target_frac),
    )
    n_done = bisect.bisect_right(completed_at, len(ctx.closes) - 1)
    outcomes = all_outcomes[:n_done]

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
