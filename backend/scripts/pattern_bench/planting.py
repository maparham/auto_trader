"""Synthesis of ground-truth windows: patterns with a known macro trajectory
dressed in real bar texture, planted into real series.

Why by-construction ground truth: hand-labelling "visually similar" windows
with the very matchers under test would be circular. Here similarity is
defined structurally — expected-good windows share the query's piecewise-
linear macro path (under noise, tempo and amplitude changes that leave the
trajectory recognisable), known-bad windows differ in trajectory while
sharing bar-level texture. Deliberately, NO smoothing filter is used to
build anything, so the construction does not presuppose the smoothed-scan
hypothesis it exists to test.
"""

from __future__ import annotations

import sqlite3

import numpy as np

# ---------------------------------------------------------------- archetypes
# Macro paths as (t, value) knots in the unit square; np.interp turns them
# into a close path of any length. Values are shape units, scaled at build.

ARCHETYPES: dict[str, tuple[tuple[float, float], ...]] = {
    "v-bottom": ((0.0, 1.0), (0.5, 0.0), (1.0, 0.95)),
    "trend-pullback": ((0.0, 0.0), (0.45, 0.62), (0.62, 0.38), (1.0, 1.0)),
    "double-top": ((0.0, 0.0), (0.25, 1.0), (0.5, 0.55), (0.75, 0.97), (1.0, 0.15)),
    "three-swing": ((0.0, 0.2), (0.2, 1.0), (0.45, 0.1), (0.7, 0.9), (1.0, 0.0)),
    "two-swing": ((0.0, 0.2), (0.35, 1.0), (1.0, 0.0)),
    "four-swing": ((0.0, 0.2), (0.15, 1.0), (0.35, 0.15), (0.55, 0.95), (0.75, 0.05), (1.0, 0.85)),
    "up-trend": ((0.0, 0.0), (1.0, 1.0)),
    "down-trend": ((0.0, 1.0), (1.0, 0.0)),
    "flat-chop": ((0.0, 0.5), (1.0, 0.5)),
    "inv-v": ((0.0, 0.0), (0.5, 1.0), (1.0, 0.05)),
    "inv-trend-pullback": ((0.0, 1.0), (0.45, 0.38), (0.62, 0.62), (1.0, 0.0)),
    "inv-double-top": ((0.0, 1.0), (0.25, 0.0), (0.5, 0.45), (0.75, 0.03), (1.0, 0.85)),
    "choppy-up": ((0.0, 0.0), (0.1, 0.28), (0.2, 0.06), (0.33, 0.52), (0.44, 0.22),
                  (0.58, 0.72), (0.72, 0.42), (0.85, 0.88), (1.0, 1.0)),
    # A structured low-amplitude lead (rounded top, ~8% of the range) before a
    # big decline and recovery — the amplitude-hierarchy case: after global
    # normalization the lead is numerically near-flat, and the metric must
    # still prefer a structured lead over a dead-flat one.
    "top-lead-v": ((0.0, 0.92), (0.07, 1.0), (0.14, 0.94), (0.21, 1.0), (0.28, 0.95),
                   (0.35, 0.97), (0.55, 0.05), (0.75, 0.12), (1.0, 0.55)),
    "flat-lead-v": ((0.0, 0.965), (0.35, 0.965), (0.55, 0.05), (0.75, 0.12), (1.0, 0.55)),
}


def macro_path(name: str, m: int) -> np.ndarray:
    """The archetype's close path over m bars, in shape units (range ~1)."""
    knots = ARCHETYPES[name]
    t = np.array([k[0] for k in knots])
    v = np.array([k[1] for k in knots])
    return np.interp(np.linspace(0.0, 1.0, m), t, v)


# ------------------------------------------------------------------ builders


def bar_scale(ohlc: np.ndarray) -> float:
    """The series' per-bar move scale: median |close-to-close| step. All
    noise and amplitude choices are expressed in this unit so a case built
    on GOLD and one built on US100 stress the matchers identically."""
    steps = np.abs(np.diff(ohlc[:, 3]))
    steps = steps[steps > 0]
    return float(np.median(steps)) if len(steps) else 1.0


def build_pattern(
    archetype: str,
    m: int,
    scale: float,
    rng: np.random.Generator,
    *,
    amplitude: float = 30.0,
    noise: float = 1.0,
    residuals: np.ndarray | None = None,
) -> np.ndarray:
    """(m, 4) candles whose close path is `archetype` at `amplitude` bar-scales
    of total range, plus per-bar noise of `noise` bar-scales — or, for a
    texture-transplant decoy, the exact `residuals` handed in. Wicks and the
    open gap are drawn in proportion to the realised per-bar moves, which is
    what real candles do."""
    macro = macro_path(archetype, m) * amplitude * scale
    if residuals is None:
        resid = rng.normal(0.0, noise * scale, m)
    else:
        resid = residuals[:m] if len(residuals) >= m else np.resize(residuals, m)
    c = macro + resid
    o = np.concatenate([[c[0] - resid[0]], c[:-1]])
    move = np.abs(c - o)
    wick = 0.2 * move + rng.uniform(0.1, 0.7, m) * scale * max(noise, 0.3)
    h = np.maximum(o, c) + wick * rng.uniform(0.3, 1.0, m)
    l = np.minimum(o, c) - wick * rng.uniform(0.3, 1.0, m)
    return np.stack([o, h, l, c], axis=1)


def residuals_of(bars: np.ndarray, archetype: str, amplitude: float, scale: float) -> np.ndarray:
    """What build_pattern added on top of the macro: the query's bar texture,
    recoverable exactly because the macro is deterministic."""
    macro = macro_path(archetype, len(bars)) * amplitude * scale
    return bars[:, 3] - macro


def tempo(bars: np.ndarray, factor: float) -> np.ndarray:
    """The same pattern over round(m*factor) bars: the close path is
    resampled, candles rebuilt bar-by-bar so texture stays plausible."""
    m = len(bars)
    m2 = int(round(m * factor))
    xi = np.linspace(0.0, m - 1.0, m2)
    xp = np.arange(m, dtype=np.float64)
    c = np.interp(xi, xp, bars[:, 3])
    o = np.concatenate([[c[0]], c[:-1]])
    up_w = np.interp(xi, xp, bars[:, 1] - np.maximum(bars[:, 0], bars[:, 3]))
    dn_w = np.interp(xi, xp, np.minimum(bars[:, 0], bars[:, 3]) - bars[:, 2])
    h = np.maximum(o, c) + np.abs(up_w)
    l = np.minimum(o, c) - np.abs(dn_w)
    return np.stack([o, h, l, c], axis=1)


def amplify(bars: np.ndarray, k: float) -> np.ndarray:
    """The same shape at k times the price range, about its own mean."""
    mu = bars[:, 3].mean()
    return (bars - mu) * k + mu


# ------------------------------------------------------------------ planting


def gapless_sites(ts: np.ndarray, length: int, count: int, min_gap_bars: int = 400) -> list[int]:
    """Deterministic plant sites whose windows contain no time gap (a planted
    window straddling a weekend would be span-filtered away through no fault
    of the matcher). Sites are spread across the segment and never overlap."""
    dt = np.diff(ts)
    med = np.median(dt)
    bad = dt > 2 * med
    # A prefix sum over the gap mask answers "any gap inside [i, i+length)?"
    # for every i at once.
    gaps = np.concatenate([[0], np.cumsum(bad)])
    ok = np.flatnonzero(gaps[length - 1 :] - gaps[: len(gaps) - length + 1] == 0)
    ok = ok[(ok > length) & (ok < len(ts) - 2 * length)]
    if len(ok) < count:
        raise ValueError(f"only {len(ok)} gapless sites for length {length}")
    sites: list[int] = []
    stride = max(1, len(ok) // (count + 1))
    for idx in range(stride, len(ok), stride):
        cand = int(ok[idx])
        if all(abs(cand - s) >= length + min_gap_bars for s in sites):
            sites.append(cand)
        if len(sites) == count:
            break
    if len(sites) < count:
        raise ValueError(f"could not spread {count} sites of length {length}")
    return sites


def plant(ohlc: np.ndarray, site: int, bars: np.ndarray) -> None:
    """Overwrite the series at `site` with `bars`, level-shifted so the splice
    is continuous on the left (the pattern opens where the prior bar closed).
    In place, on the caller's copy."""
    shift = ohlc[site - 1, 3] - bars[0, 0]
    ohlc[site : site + len(bars)] = bars + shift


# -------------------------------------------------------------------- loading


def load_segment(
    db_path: str,
    broker: str,
    epic: str,
    resolution: str,
    from_ts: int,
    to_ts: int,
    side: str = "bid",
) -> tuple[np.ndarray, np.ndarray]:
    """A pinned slice of a real series: (ts, ohlc). Pinned by wall clock, so
    the benchmark is stable while the live right edge keeps growing."""
    con = sqlite3.connect(db_path)
    try:
        rows = con.execute(
            "select ts, open, high, low, close from bars"
            " where broker=? and epic=? and resolution=? and side=? and ts between ? and ?"
            " order by ts",
            (broker, epic, resolution, side, from_ts, to_ts),
        ).fetchall()
    finally:
        con.close()
    if not rows:
        raise ValueError(f"no bars for {broker}/{epic}/{resolution} in range")
    arr = np.array(rows, dtype=np.float64)
    return arr[:, 0].astype(np.int64), np.ascontiguousarray(arr[:, 1:5])


def jitter(bars: np.ndarray, scale: float, rng: np.random.Generator, noise: float = 1.0) -> np.ndarray:
    """The same real window with fresh bar noise on the closes: the macro
    trajectory IS the original close path, the texture is new."""
    c = bars[:, 3] + rng.normal(0.0, noise * scale, len(bars))
    o = np.concatenate([[c[0]], c[:-1]])
    up_w = bars[:, 1] - np.maximum(bars[:, 0], bars[:, 3])
    dn_w = np.minimum(bars[:, 0], bars[:, 3]) - bars[:, 2]
    h = np.maximum(o, c) + np.abs(up_w)
    l = np.minimum(o, c) - np.abs(dn_w)
    return np.stack([o, h, l, c], axis=1)


def invert(bars: np.ndarray) -> np.ndarray:
    """The window mirrored about its own mean close: same texture statistics,
    opposite trajectory."""
    mu = bars[:, 3].mean()
    o, h, l, c = (2 * mu - bars[:, k] for k in range(4))
    return np.stack([o, l, h, c], axis=1)  # high and low swap under mirroring


def reverse(bars: np.ndarray) -> np.ndarray:
    """The window played backwards: same bag of moves, different story."""
    rev = bars[::-1]
    c = rev[:, 3]
    o = np.concatenate([[c[0]], c[:-1]])
    up_w = rev[:, 1] - np.maximum(rev[:, 0], rev[:, 3])
    dn_w = np.minimum(rev[:, 0], rev[:, 3]) - rev[:, 2]
    h = np.maximum(o, c) + np.abs(up_w)
    l = np.minimum(o, c) - np.abs(dn_w)
    return np.stack([o, h, l, c], axis=1)
