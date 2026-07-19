"""Parameter stability across walk-forward folds, and the composite robustness
score. Pure arithmetic; conventions match engine/metrics.py (None in = 0
contribution, never raises)."""
from __future__ import annotations

from statistics import median, pstdev


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def _ramp(x: float | None, lo: float, hi: float) -> float:
    if x is None:
        return 0.0
    return _clamp01((x - lo) / (hi - lo))


def parameter_stability(chosen, axes, fold_tables) -> dict:
    per_axis: dict[str, dict] = {}
    weights: dict[str, float] = {}
    range_axes = [a for a in axes if a["kind"] == "range"]
    for a in range_axes:
        target = a["targets"][0]
        values = list(a["values"])
        idx = {v: i for i, v in enumerate(values)}
        picks = [idx.get(c.get(target)) for c in chosen]
        picks = [p for p in picks if p is not None]
        uniform_sd = pstdev(range(len(values))) if len(values) > 1 else 0.0
        stability = 1.0
        if len(picks) >= 2 and uniform_sd > 0:
            stability = _clamp01(1.0 - pstdev(picks) / uniform_sd)
        adjacency = 1.0
        if len(picks) >= 2:
            adjacency = sum(
                1 for a_, b in zip(picks, picks[1:]) if abs(a_ - b) <= 1
            ) / (len(picks) - 1)
        per_axis[target] = {
            "stability": round(stability, 4),
            "adjacency": round(adjacency, 4),
            "values": [c.get(target) for c in chosen],
        }
        # Sensitivity weight: spread of the per-value median objective. An axis
        # the objective ignores should not drag the overall score.
        by_value_medians: list[float] = []
        for v in values:
            per_fold = []
            for combos, objs in fold_tables:
                vals = [o for c, o in zip(combos, objs)
                        if c.get(target) == v and o is not None]
                if vals:
                    per_fold.append(median(vals))
            if per_fold:
                by_value_medians.append(median(per_fold))
        weights[target] = pstdev(by_value_medians) if len(by_value_medians) > 1 else 0.0

    if not per_axis:
        return {"per_axis": {}, "overall": None, "adjacency": None}
    total_w = sum(weights.values())
    if total_w > 0:
        overall = sum(per_axis[t]["stability"] * weights[t] for t in per_axis) / total_w
    else:
        overall = sum(v["stability"] for v in per_axis.values()) / len(per_axis)
    # Overall adjacency: a fold transition counts only if EVERY axis stayed
    # within one step.
    n_steps = len(chosen) - 1
    joint = 0
    if n_steps > 0:
        for k in range(n_steps):
            ok = True
            for a in range_axes:
                t = a["targets"][0]
                idx = {v: i for i, v in enumerate(a["values"])}
                i0, i1 = idx.get(chosen[k].get(t)), idx.get(chosen[k + 1].get(t))
                if i0 is None or i1 is None or abs(i0 - i1) > 1:
                    ok = False
                    break
            joint += 1 if ok else 0
    return {
        "per_axis": per_axis,
        "overall": round(overall, 4),
        "adjacency": round(joint / n_steps, 4) if n_steps > 0 else None,
    }


def robustness_score(*, wfe_median, pct_folds_profitable, oos_sharpe,
                     param_stability, oos_max_dd_pct, plateau_breadth,
                     oos_trades_total, n_folds) -> float:
    core = (
        0.30 * _ramp(wfe_median, 0.0, 0.6)
        + 0.20 * (pct_folds_profitable or 0.0)
        + 0.15 * _ramp(oos_sharpe, 0.0, 1.5)
        + 0.15 * (param_stability or 0.0)
        + 0.10 * _ramp(-(oos_max_dd_pct or 100.0), -40.0, -10.0)
        + 0.10 * (plateau_breadth or 0.0)
    )
    penalty = min(1.0, (oos_trades_total or 0) / 100.0) * min(1.0, (n_folds or 0) / 5.0)
    return round(100.0 * _clamp01(core) * penalty, 1)
