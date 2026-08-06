from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING

from auto_trader.core.candle_aggregate import resolution_seconds
from auto_trader.core.models import Candle
from auto_trader.indicators.candle_patterns import PATTERN_FNS, pattern_series
from auto_trader.indicators.core import (
    atr_series, avwap_series, ema_series, rsi_series, sma_series,
)
from auto_trader.indicators.mtf import align_htf_to_base, slope_of
from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.tfs import tf_resolution
from auto_trader.strategy.expr.warmup import warmup_bars

if TYPE_CHECKING:
    from auto_trader.indicators.registry import ResolvedInstance


def candle_field(c: Candle, field: str) -> float | None:
    if field == "open":
        return c.open
    if field == "high":
        return c.high
    if field == "low":
        return c.low
    if field == "close":
        return c.close
    if field == "volume":
        return c.volume
    if field == "body":
        return abs(c.close - c.open)
    if field == "range":
        return c.high - c.low
    if field == "wickTop":
        return c.high - max(c.open, c.close)
    if field == "wickBottom":
        return min(c.open, c.close) - c.low
    return None


def _tf_hours(resolution: str) -> float:
    return resolution_seconds(resolution) / 3600


def _window(raw: Sequence[float | None], n: int, kind: str) -> list[float | None]:
    """highest/lowest/avg over the last n bars INCLUDING the current bar."""
    out: list[float | None] = [None] * len(raw)
    for i in range(len(raw)):
        if i + 1 < n:
            continue
        window = raw[i - n + 1 : i + 1]
        # A None or NaN anywhere in the window poisons the whole bar. NaN must be
        # screened explicitly: max/min over a list containing NaN is order-
        # dependent, so highest/lowest could otherwise return a finite value and
        # defeat the spec's NaN-poisoning rule.
        if any(v is None or (isinstance(v, float) and math.isnan(v)) for v in window):
            continue
        vals = [float(v) for v in window]  # type: ignore[arg-type]
        out[i] = max(vals) if kind == "highest" else min(vals) if kind == "lowest" else sum(vals) / n
    return out


def _indicator_raw(name: str, args_vals: list[float], candles: Sequence[Candle]) -> list[float | None]:
    closes = [c.close for c in candles]
    if name == "EMA":
        return ema_series(closes, int(args_vals[0]))
    if name == "SMA":
        return sma_series(closes, int(args_vals[0]))
    if name == "RSI":
        return rsi_series(closes, int(args_vals[0]))
    if name == "ATR":
        return atr_series(candles, int(args_vals[0]))
    if name == "VOLMA":
        return sma_series([c.volume for c in candles], int(args_vals[0]))
    if name == "VOL":
        return [c.volume for c in candles]
    if name == "AVWAP":
        return avwap_series(candles, int(args_vals[0]))
    return [None] * len(candles)


def _defined(v: float | None) -> bool:
    return v is not None and not (isinstance(v, float) and math.isnan(v))


def _cmp_vals(op: str, l: float | None, r: float | None) -> bool:
    if not (_defined(l) and _defined(r)):
        return False
    if op == ">":
        return l > r
    if op == "<":
        return l < r
    if op == ">=":
        return l >= r
    return l <= r


def _hoist_predicate(node: N.Predicate) -> N.Node:
    """Move the candle base's postfix wrappers OUTSIDE the predicate:

        Predicate(fn, Tf(Candle, "4H"))  ->  Tf(Predicate(fn, Candle), "4H")
        Predicate(fn, Offset(Candle, 1)) ->  Offset(Predicate(fn, Candle), 1)

    A pattern is a property of a BAR SERIES, not of one bar, so it must be
    detected on whichever series the pin selects and only then shifted/aligned.
    Hoisting hands both jobs to series_of's existing Tf and Offset branches
    instead of duplicating alignment here, and reproduces the same wrapper
    nesting `_apply_field_to_candle` builds for the field path. Validation has
    already guaranteed the base bottoms out in a bare Candle through Offset/Tf
    wrappers only.
    """
    wrappers: list[N.Offset | N.Tf] = []
    base: N.Node = node.base
    while isinstance(base, (N.Offset, N.Tf)):
        wrappers.append(base)
        base = base.base
    out: N.Node = N.Predicate(node.fn, base, node.start, node.end)
    for w in reversed(wrappers):
        if isinstance(w, N.Offset):
            out = N.Offset(out, w.n, w.start, w.end)
        else:
            out = N.Tf(out, w.tf, w.start, w.end)
    return out


def _pattern_bool_series(node: N.Predicate, candles: Sequence[Candle],
                         resolution: str, htf: dict[str, list[Candle]],
                         instances: "dict[str, ResolvedInstance] | None" = None) -> list[bool]:
    """Per-bar truth of a PATTERN predicate. Undefined (warm-up, or a base bar
    before the first aligned HTF close) is a non-match, matching the
    bullish/bearish convention."""
    vals = series_of(_hoist_predicate(node), candles, resolution, htf, instances)
    return [_defined(v) and v >= 0.5 for v in vals]


def _cond_matches(cond: "N.Compare | N.Cross | N.Predicate", candles: Sequence[Candle],
                   resolution: str, htf: dict[str, list[Candle]],
                   instances: "dict[str, ResolvedInstance] | None" = None) -> list[bool]:
    """Per-bar truth of an embedded condition. Undefined operands -> False
    (a warm-up bar is a non-match, it does not poison the window)."""
    n = len(candles)
    if isinstance(cond, N.Predicate):
        if cond.fn in PATTERN_FNS:
            return _pattern_bool_series(cond, candles, resolution, htf, instances)
        # nodes.PREDICATE_FNS is exactly {"bullish", "bearish"} | PATTERN_FNS, and
        # validation rejects anything outside it, so the remainder is a clean binary.
        bullish = cond.fn == "bullish"
        opens = series_of(_apply_field_to_candle(cond.base, "open"), candles, resolution, htf, instances)
        closes = series_of(_apply_field_to_candle(cond.base, "close"), candles, resolution, htf, instances)
        if bullish:
            return [_defined(opens[i]) and _defined(closes[i]) and closes[i] > opens[i] for i in range(n)]
        return [_defined(opens[i]) and _defined(closes[i]) and closes[i] < opens[i] for i in range(n)]
    if isinstance(cond, N.Cross):
        a = series_of(cond.a, candles, resolution, htf, instances)
        b = series_of(cond.b, candles, resolution, htf, instances)
        out = [False] * n
        for i in range(1, n):
            if not all(_defined(v) for v in (a[i], a[i - 1], b[i], b[i - 1])):
                continue
            if cond.fn == "crossAbove":
                out[i] = a[i - 1] <= b[i - 1] and a[i] > b[i]
            else:
                out[i] = a[i - 1] >= b[i - 1] and a[i] < b[i]
        return out
    left = series_of(cond.left, candles, resolution, htf, instances)
    right = series_of(cond.right, candles, resolution, htf, instances)
    return [_cmp_vals(cond.op, left[i], right[i]) for i in range(n)]


def series_of(node: N.Node, candles: Sequence[Candle], resolution: str,
              htf: dict[str, list[Candle]],
              instances: "dict[str, ResolvedInstance] | None" = None) -> list[float | None]:
    """Evaluate an `entry`-free node to a per-bar array over `candles`."""
    n = len(candles)
    if isinstance(node, N.Num):
        return [node.value] * n
    if isinstance(node, N.Candle):
        assert node.field is not None
        return [candle_field(c, node.field) for c in candles]
    if isinstance(node, N.Entry):
        raise ValueError("entry is not a series")
    if isinstance(node, N.Field):
        # Only reachable for candle.field (validated); a Field over a Candle base.
        base = node.base
        if isinstance(base, (N.Candle,)):
            return [candle_field(c, node.name) for c in candles]
        # candle-with-postfix, e.g. candle@TF.high or candle[-1].open: the field
        # lives on the base candle expression -> rebuild a Candle at that field.
        return series_of(_apply_field_to_candle(base, node.name), candles, resolution, htf, instances)
    if isinstance(node, N.Offset):
        base = series_of(node.base, candles, resolution, htf, instances)
        return [base[i - node.n] if i >= node.n else None for i in range(n)]
    if isinstance(node, N.Tf):
        # htf is keyed by the CANONICAL resolution ("HOUR"), the pin carries the
        # alias ("1H"); also accept a dict keyed by the raw alias for older
        # shippers. Missing/empty candles degrade to all-None (the alignment of
        # nothing) rather than crashing — routes 422 before running when a
        # referenced timeframe has no candles, this is the defensive layer.
        tf_res = tf_resolution(node.tf) or node.tf
        tf_candles = htf.get(tf_res) or htf.get(node.tf) or []
        if not tf_candles:
            return [None] * n
        tf_vals = series_of(node.base, tf_candles, tf_res, htf, instances)
        base_ms = [int(c.time.timestamp() * 1000) for c in candles]
        tf_ms = resolution_seconds(tf_res) * 1000
        return align_htf_to_base(base_ms, tf_candles, tf_vals, tf_ms)
    if isinstance(node, N.Unary):
        inner = series_of(node.operand, candles, resolution, htf, instances)
        return [None if v is None else -v for v in inner]
    if isinstance(node, N.Binary):
        left = series_of(node.left, candles, resolution, htf, instances)
        right = series_of(node.right, candles, resolution, htf, instances)
        return [_binop(node.op, left[i], right[i]) for i in range(n)]
    if isinstance(node, N.BarsSinceEntry):
        raise ValueError("barsSinceEntry is not a series")
    if isinstance(node, N.Predicate):
        # Reachable only through _pattern_bool_series' hoist: a PATTERN predicate
        # IS a per-bar 1.0/0.0 series, which is what lets the Tf/Offset branches
        # above align and shift it. bullish/bearish are pointwise and are handled
        # in _cond_matches/_match_at, so they never arrive here.
        if node.fn in PATTERN_FNS:
            return [float(v) for v in pattern_series(candles, node.fn)]
        raise ValueError(f"{node.fn} is not a series")
    if isinstance(node, N.Count):
        matches = _cond_matches(node.cond, candles, resolution, htf, instances)
        pre = [0] * (n + 1)  # prefix sums: pre[j+1] = matches in bars [0, j]
        for j in range(n):
            pre[j + 1] = pre[j] + (1 if matches[j] else 0)
        wseries = series_of(node.window, candles, resolution, htf, instances)
        out: list[float | None] = [None] * n
        for i in range(n):
            wv = wseries[i]
            if not _defined(wv):
                continue
            k = int(wv)
            if k < 1:
                out[i] = 0.0
                continue
            if i + 1 < k:
                continue  # window does not fit yet
            out[i] = float(pre[i + 1] - pre[i + 1 - k])
        return out
    if isinstance(node, N.Call):
        if node.name in WRAPPER_KINDS:
            inner = series_of(node.args[0], candles, resolution, htf, instances)
            length = int(series_of(node.args[1], candles, resolution, htf, instances)[0] or 0)
            if node.name == "slope":
                return slope_of(inner, length, _tf_hours(resolution))
            return _window(inner, length, node.name)
        arg_vals = [float(series_of(a, candles, resolution, htf, instances)[0] or 0) for a in node.args]
        return _indicator_raw(node.name, arg_vals, candles)
    raise ValueError(f"cannot evaluate {type(node).__name__} as a series")


WRAPPER_KINDS = ("slope", "highest", "lowest", "avg")


def _apply_field_to_candle(base: N.Node, field: str) -> N.Node:
    """Rewrite `candle`-rooted postfix so the field is on the candle leaf:
    Tf(Candle(None), tf).field -> Tf(Candle(field), tf); Offset likewise."""
    import dataclasses
    if isinstance(base, N.Candle):
        return dataclasses.replace(base, field=field)
    if isinstance(base, N.Offset):
        return dataclasses.replace(base, base=_apply_field_to_candle(base.base, field))
    if isinstance(base, N.Tf):
        return dataclasses.replace(base, base=_apply_field_to_candle(base.base, field))
    raise ValueError("field base is not candle-rooted")


def _binop(op: str, a: float | None, b: float | None) -> float | None:
    if a is None or b is None:
        return None
    if op == "+":
        return a + b
    if op == "-":
        return a - b
    if op == "*":
        return a * b
    if op == "/":
        return a / b if b != 0 else math.nan
    raise ValueError(op)


@dataclass(slots=True)
class CompiledRow:
    node: N.Row
    candles: Sequence[Candle]
    resolution: str
    htf: dict[str, list[Candle]]
    instances: "dict[str, ResolvedInstance] | None"
    warmup: int
    _cache: dict[int, list[float | None]]
    _matches: dict[int, list[bool]]
    _pred_nodes: dict[int, tuple[N.Node, N.Node]]
    # Separate from _cache: that one is keyed by sub-node identity and holds
    # float|None arrays; this holds the bool match series of a PATTERN condition
    # node. Without it the 24-condition detector re-runs for every bar of every
    # count() window, making the per-bar path O(n^2).
    _pattern_cache: dict[int, list[bool]]

    def _val(self, sub: N.Node, i: int, entry: float | None, entry_i: int | None = None) -> float | None:
        # entry-free sub-expressions are precomputed to arrays; entry-bearing ones
        # recurse per bar (entry is a scalar constant across the trade).
        key = id(sub)
        if key in self._cache:
            return self._cache[key][i] if 0 <= i < len(self._cache[key]) else None
        if isinstance(sub, N.Entry):
            return entry
        if isinstance(sub, N.Num):
            return sub.value
        if isinstance(sub, N.Candle):
            assert sub.field is not None
            return candle_field(self.candles[i], sub.field) if 0 <= i < len(self.candles) else None
        if isinstance(sub, N.Unary):
            v = self._val(sub.operand, i, entry, entry_i)
            return None if v is None else -v
        if isinstance(sub, N.Binary):
            return _binop(sub.op, self._val(sub.left, i, entry, entry_i), self._val(sub.right, i, entry, entry_i))
        if isinstance(sub, N.BarsSinceEntry):
            if entry_i is None or i < entry_i:
                return None
            return float(i - entry_i)
        if isinstance(sub, N.Count):
            wv = self._val(sub.window, i, entry, entry_i)
            if not _defined(wv):
                return None
            k = int(wv)
            if k < 1:
                return 0.0
            if i + 1 < k:
                return None
            return float(sum(
                1 for j in range(i - k + 1, i + 1)
                if self._match_at(sub.cond, j, entry, entry_i)
            ))
        # Any remaining node is entry-free -> it was precomputed; guard defensively.
        arr = series_of(sub, self.candles, self.resolution, self.htf, self.instances)
        self._cache[key] = arr
        return arr[i] if 0 <= i < len(arr) else None

    def _match_at(self, cond, j: int, entry: float | None, entry_i: int | None) -> bool:
        """Truth of an embedded condition at bar j (per-bar path)."""
        if isinstance(cond, N.Predicate):
            if cond.fn in PATTERN_FNS:
                pkey = id(cond)
                if pkey not in self._pattern_cache:
                    self._pattern_cache[pkey] = _pattern_bool_series(
                        cond, self.candles, self.resolution, self.htf, self.instances
                    )
                arr = self._pattern_cache[pkey]
                return 0 <= j < len(arr) and arr[j]
            bullish = cond.fn == "bullish"  # see _cond_matches: the rest is binary
            key = id(cond)
            if key not in self._pred_nodes:
                self._pred_nodes[key] = (
                    _apply_field_to_candle(cond.base, "open"),
                    _apply_field_to_candle(cond.base, "close"),
                )
            o_node, c_node = self._pred_nodes[key]
            o = self._val(o_node, j, entry, entry_i)
            c = self._val(c_node, j, entry, entry_i)
            if not (_defined(o) and _defined(c)):
                return False
            return c > o if bullish else c < o
        if isinstance(cond, N.Cross):
            if j == 0:
                return False
            a1, a0 = self._val(cond.a, j, entry, entry_i), self._val(cond.a, j - 1, entry, entry_i)
            b1, b0 = self._val(cond.b, j, entry, entry_i), self._val(cond.b, j - 1, entry, entry_i)
            if not all(_defined(v) for v in (a1, a0, b1, b0)):
                return False
            if cond.fn == "crossAbove":
                return a0 <= b0 and a1 > b1
            return a0 >= b0 and a1 < b1
        return _cmp_vals(cond.op, self._val(cond.left, j, entry, entry_i), self._val(cond.right, j, entry, entry_i))

    def _cmp(self, part: N.Compare, i: int, entry: float | None, entry_i: int | None = None) -> bool:
        l = self._val(part.left, i, entry, entry_i)
        r = self._val(part.right, i, entry, entry_i)
        return _cmp_vals(part.op, l, r)

    def evaluate(self, i: int, entry_price: float | None, entry_i: int | None = None) -> bool:
        node = self.node
        if isinstance(node, N.Predicate):
            key = id(node)
            if key not in self._matches:
                self._matches[key] = _cond_matches(
                    node, self.candles, self.resolution, self.htf, self.instances
                )
            m = self._matches[key]
            return m[i] if 0 <= i < len(m) else False
        if isinstance(node, N.Compare):
            return self._cmp(node, i, entry_price, entry_i)
        if isinstance(node, N.Chain):
            return all(self._match_at(p, i, entry_price, entry_i) for p in node.parts)
        # Cross
        if i == 0:
            return False
        lnow = self._val(node.a, i, entry_price, entry_i)
        lprev = self._val(node.a, i - 1, entry_price, entry_i)
        rnow = self._val(node.b, i, entry_price, entry_i)
        rprev = self._val(node.b, i - 1, entry_price, entry_i)
        if not all(_defined(v) for v in (lnow, lprev, rnow, rprev)):
            return False
        if node.fn == "crossAbove":
            return lprev <= rprev and lnow > rnow
        return lprev >= rprev and lnow < rnow


def _entry_free(node: N.Node) -> bool:
    if isinstance(node, N.Entry):
        return False
    if isinstance(node, N.Num) or isinstance(node, N.Candle):
        return True
    if isinstance(node, (N.Offset, N.Tf)):
        return _entry_free(node.base)
    if isinstance(node, N.Field):
        return _entry_free(node.base)
    if isinstance(node, N.Unary):
        return _entry_free(node.operand)
    if isinstance(node, N.Binary):
        return _entry_free(node.left) and _entry_free(node.right)
    if isinstance(node, N.Call):
        return all(_entry_free(a) for a in node.args)
    if isinstance(node, N.BarsSinceEntry):
        return False
    if isinstance(node, N.Predicate):
        return _entry_free(node.base)
    if isinstance(node, N.Count):
        return _entry_free(node.cond) and _entry_free(node.window)
    if isinstance(node, N.Compare):
        return _entry_free(node.left) and _entry_free(node.right)
    if isinstance(node, N.Cross):
        return _entry_free(node.a) and _entry_free(node.b)
    return True


def _precompute(node: N.Node, candles, resolution, htf, cache: dict[int, list[float | None]],
                instances: "dict[str, ResolvedInstance] | None" = None) -> None:
    """Precompute arrays for maximal entry-free sub-nodes (skip pure Num/Candle:
    those are cheap per bar and keep the per-bar cross path simple)."""
    if _entry_free(node) and not isinstance(node, (N.Num, N.Candle)):
        cache[id(node)] = series_of(node, candles, resolution, htf, instances)
        return
    if isinstance(node, N.Unary):
        _precompute(node.operand, candles, resolution, htf, cache, instances)
    elif isinstance(node, N.Binary):
        _precompute(node.left, candles, resolution, htf, cache, instances)
        _precompute(node.right, candles, resolution, htf, cache, instances)


def compile_row(node: N.Row, candles, resolution, htf,
                instances: "dict[str, ResolvedInstance] | None" = None) -> CompiledRow:
    cache: dict[int, list[float | None]] = {}
    if isinstance(node, N.Chain):
        # Consecutive links share their middle operand (p[i].right is p[i+1].left);
        # dedup by identity so it is precomputed once.
        seen: set[int] = set()
        subs = []
        for p in node.parts:
            for operand in N.part_operands(p):
                if id(operand) not in seen:
                    seen.add(id(operand))
                    subs.append(operand)
    elif isinstance(node, N.Compare):
        subs = [node.left, node.right]
    elif isinstance(node, N.Predicate):
        subs = []  # match series is built lazily on first evaluate
    else:
        subs = [node.a, node.b]
    for sub in subs:
        _precompute(sub, candles, resolution, htf, cache, instances)
    return CompiledRow(node, candles, resolution, htf, instances,
                       warmup_bars(node, resolution, instances), cache, {}, {}, {})
