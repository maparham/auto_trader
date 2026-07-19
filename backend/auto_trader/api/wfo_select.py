"""Per-fold combo selection for walk-forward optimization. Pure functions over
fold result tables; importable by the job thread (no FastAPI, no engine)."""
from __future__ import annotations

from statistics import pstdev

from auto_trader.engine.plateau import with_plateau


def _mean(xs):
    return sum(xs) / len(xs) if xs else 0.0


def objective_values(rows: list[dict], objective: dict) -> list[float | None]:
    min_trades = objective.get("min_trades") or 0
    eligible = [
        r["metrics"] is not None
        and (r["metrics"].get("n_trades") or 0) >= min_trades
        for r in rows
    ]
    composite = objective.get("composite")
    if not composite:
        metric = objective["metric"]
        return [
            r["metrics"].get(metric) if ok and r["metrics"].get(metric) is not None
            else None
            for r, ok in zip(rows, eligible)
        ]
    # z-score each component across eligible rows, then weighted-sum. A row
    # missing any component is ineligible for the composite.
    comps: dict[str, tuple[float, float]] = {}
    for name in composite:
        vals = [r["metrics"].get(name) for r, ok in zip(rows, eligible) if ok]
        vals = [v for v in vals if v is not None]
        comps[name] = (_mean(vals), pstdev(vals) if len(vals) > 1 else 0.0)
    out: list[float | None] = []
    for r, ok in zip(rows, eligible):
        if not ok:
            out.append(None)
            continue
        score = 0.0
        bad = False
        for name, w in composite.items():
            v = r["metrics"].get(name)
            if v is None:
                bad = True
                break
            mean, sd = comps[name]
            score += w * ((v - mean) / sd if sd > 0 else 0.0)
        out.append(None if bad else score)
    return out


def select_fold(rows, axes, objective, selection: str):
    values = objective_values(rows, objective)
    combos = [r["combo"] for r in rows]
    scores: list[float | None] = [None] * len(rows)
    if selection == "plateau":
        scores, _ = with_plateau(combos, values, axes)
    ranked = scores if any(s is not None for s in scores) else values
    best_i: int | None = None
    for i, s in enumerate(ranked):
        if s is None:
            continue
        if best_i is None or s > ranked[best_i] or (
            s == ranked[best_i]
            and values[i] is not None and values[best_i] is not None
            and values[i] > values[best_i]
        ):
            best_i = i
    return best_i, values, scores


def plateau_breadth(values: list[float | None]) -> float | None:
    ok = [v for v in values if v is not None]
    if not ok:
        return None
    peak = max(ok)
    if peak <= 0:
        return None
    return round(sum(1 for v in ok if v >= 0.8 * peak) / len(ok), 4)
