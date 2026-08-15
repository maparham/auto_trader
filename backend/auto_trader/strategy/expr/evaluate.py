from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING

from auto_trader.core.candle_aggregate import resolution_seconds
from auto_trader.core.models import Candle, RuleTerm
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
        return c.close - c.open
    if field == "body%":
        return (c.close - c.open) / c.open * 100 if c.open != 0 else None
    if field == "range":
        # Signed by direction; a doji (close == open) keeps its magnitude
        # positive rather than collapsing to 0 like body does.
        return (c.high - c.low) if c.close >= c.open else -(c.high - c.low)
    if field == "range%":
        if c.high == 0:
            return None
        pct = (c.high - c.low) / c.high * 100
        return pct if c.close >= c.open else -pct
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
    if name == "ATR%":
        # The legend's ATR% readout at its defaults: RMA ATR over the bar close.
        return [
            (a / c.close) * 100.0 if a is not None and c.close > 0 else None
            for a, c in zip(atr_series(candles, int(args_vals[0])), candles)
        ]
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
    if op == "<=":
        return l <= r
    if op == "==":
        # Exact, deliberately: count(...) and barsSinceEntry are integral, and
        # "exactly n of the last m bars" is the whole point of the operator. On
        # float series == is almost never true bar to bar, and that is fine —
        # there its value is as a proximity-heatmap query (closeness.signed_gap
        # gives it -abs(l - r)), not as a firing condition. Do not add a
        # tolerance here; that would silently change what count() == n means.
        return l == r
    # No bare fallthrough: an unknown op used to be silently treated as "<=",
    # which returns plausible booleans and passes every parser-level test.
    raise ValueError(f"unsupported comparison op: {op}")


def _cmp3(op: str, l: float | None, r: float | None) -> bool | None:
    """Three-valued comparison: None (unknown) when either side is undefined."""
    if not (_defined(l) and _defined(r)):
        return None
    return _cmp_vals(op, l, r)


def _kleene_and(vals: "list[bool | None]") -> bool | None:
    if any(v is False for v in vals):
        return False
    if any(v is None for v in vals):
        return None
    return True


def _kleene_or(vals: "list[bool | None]") -> bool | None:
    if any(v is True for v in vals):
        return True
    if any(v is None for v in vals):
        return None
    return False


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


def _pattern_series3(node: N.Predicate, candles: Sequence[Candle],
                     resolution: str, htf: dict[str, list[Candle]],
                     instances: "dict[str, ResolvedInstance] | None" = None) -> "list[bool | None]":
    """Per-bar three-valued truth of a PATTERN predicate: None while undefined
    (warm-up / before the first aligned HTF close)."""
    vals = series_of(_hoist_predicate(node), candles, resolution, htf, instances)
    return [None if not _defined(v) else v >= 0.5 for v in vals]


def _cond_matches3(cond: N.Node, candles: Sequence[Candle],
                   resolution: str, htf: dict[str, list[Candle]],
                   instances: "dict[str, ResolvedInstance] | None" = None) -> "list[bool | None]":
    """Per-bar three-valued truth of an embedded condition: None = unknown
    (some input undefined at that bar)."""
    n = len(candles)
    if isinstance(cond, N.BoolOp):
        per = [_cond_matches3(p, candles, resolution, htf, instances) for p in cond.parts]
        fold = _kleene_and if cond.op == "and" else _kleene_or
        return [fold([p[i] for p in per]) for i in range(n)]
    if isinstance(cond, N.Not):
        inner = _cond_matches3(cond.operand, candles, resolution, htf, instances)
        return [None if v is None else not v for v in inner]
    if isinstance(cond, N.Chain):
        per = [_cond_matches3(p, candles, resolution, htf, instances) for p in cond.parts]
        return [_kleene_and([p[i] for p in per]) for i in range(n)]
    if isinstance(cond, N.Predicate):
        if cond.fn in PATTERN_FNS:
            return _pattern_series3(cond, candles, resolution, htf, instances)
        # nodes.PREDICATE_FNS is exactly {"bullish", "bearish"} | PATTERN_FNS, and
        # validation rejects anything outside it, so the remainder is a clean binary.
        bullish = cond.fn == "bullish"
        opens = series_of(_apply_field_to_candle(cond.base, "open"), candles, resolution, htf, instances)
        closes = series_of(_apply_field_to_candle(cond.base, "close"), candles, resolution, htf, instances)
        out: list[bool | None] = []
        for i in range(n):
            if not (_defined(opens[i]) and _defined(closes[i])):
                out.append(None)
            else:
                out.append(closes[i] > opens[i] if bullish else closes[i] < opens[i])
        return out
    if isinstance(cond, N.Cross):
        a = series_of(cond.a, candles, resolution, htf, instances)
        b = series_of(cond.b, candles, resolution, htf, instances)
        # i == 0: no prev bar, the straddle is unknowable. Annotated (and named
        # apart from the Predicate branch's `out`) so the bool assignments below
        # don't narrow it to list[None].
        crossed: list[bool | None] = [None] * n
        for i in range(1, n):
            if not all(_defined(v) for v in (a[i], a[i - 1], b[i], b[i - 1])):
                crossed[i] = None
                continue
            if cond.fn == "crossAbove":
                crossed[i] = a[i - 1] <= b[i - 1] and a[i] > b[i]
            else:
                crossed[i] = a[i - 1] >= b[i - 1] and a[i] < b[i]
        return crossed
    # Compare
    left = series_of(cond.left, candles, resolution, htf, instances)
    right = series_of(cond.right, candles, resolution, htf, instances)
    return [_cmp3(cond.op, left[i], right[i]) for i in range(n)]


def _cond_matches(cond: N.Node, candles: Sequence[Candle],
                  resolution: str, htf: dict[str, list[Candle]],
                  instances: "dict[str, ResolvedInstance] | None" = None) -> list[bool]:
    """Per-bar truth of an embedded condition; unknown -> non-match (a warm-up
    bar does not poison the window)."""
    return [v is True for v in _cond_matches3(cond, candles, resolution, htf, instances)]


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
        # Reachable only through _pattern_series3' hoist: a PATTERN predicate
        # IS a per-bar 1.0/0.0 series, which is what lets the Tf/Offset branches
        # above align and shift it. bullish/bearish are pointwise and are handled
        # in _cond_matches3/_match3, so they never arrive here.
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
    if isinstance(node, N.IndicatorRef):
        inst = (instances or {}).get(node.instance)
        if inst is None:
            # validate() rejects this first; be defensive like the Tf branch so a
            # stale row can never 500 a run.
            return [None] * n
        pin = inst.spec.timeframe(inst.config)
        if pin:
            # The pane's own timeframe is a SETTING, so the ref already means the
            # HTF series: compute on native HTF bars and align to base, exactly
            # as the chart does for a pinned pane. The hours-per-bar handed to
            # the descriptor MUST come from the PINNED resolution, not the base
            # one, or any output expressed per unit of time is silently scaled by
            # the ratio between them.
            tf_res = tf_resolution(pin) or pin
            tf_candles = htf.get(tf_res) or htf.get(pin) or []
            if not tf_candles:
                return [None] * n
            tf_vals = inst.spec.series(
                inst.config, node.output, tf_candles, _tf_hours(tf_res)
            )
            base_ms = [int(c.time.timestamp() * 1000) for c in candles]
            return align_htf_to_base(base_ms, tf_candles, tf_vals, resolution_seconds(tf_res) * 1000)
        return inst.spec.series(inst.config, node.output, candles, _tf_hours(resolution))
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
    _pred_nodes: dict[int, tuple[N.Node, N.Node]]
    # Separate from _cache: that one is keyed by sub-node identity and holds
    # float|None arrays; this holds the three-valued match series of a PATTERN
    # condition node. Without it the 24-condition detector re-runs for every bar
    # of every count() window, making the per-bar path O(n^2).
    _pattern_cache: "dict[int, list[bool | None]]"
    # The row's expression text, exactly as parsed — node start/end spans index
    # into it, so operand labels for RuleTerm capture are source slices. "" when
    # the caller has no display need (sweep workers), which disables terms_at.
    source: str = ""
    # Bar-/entry-independent row (N.is_constant — e.g. the baselines' `1==1`):
    # evaluate answers once and reuses it instead of walking the tree per bar.
    is_const: bool = False
    _const_val: "bool | None" = None

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
                if self._match3(sub.cond, j, entry, entry_i) is True
            ))
        # Any remaining node is entry-free -> it was precomputed; guard defensively.
        arr = series_of(sub, self.candles, self.resolution, self.htf, self.instances)
        self._cache[key] = arr
        return arr[i] if 0 <= i < len(arr) else None

    def _match3(self, cond: N.Node, j: int, entry: float | None, entry_i: int | None) -> "bool | None":
        """Three-valued truth of a condition at bar j: None = unknown (some
        input undefined). Kleene: unknown and False = False, unknown or True =
        True, not unknown = unknown."""
        if isinstance(cond, N.BoolOp):
            vals = [self._match3(p, j, entry, entry_i) for p in cond.parts]
            return _kleene_and(vals) if cond.op == "and" else _kleene_or(vals)
        if isinstance(cond, N.Not):
            v = self._match3(cond.operand, j, entry, entry_i)
            return None if v is None else not v
        if isinstance(cond, N.Chain):
            return _kleene_and([self._match3(p, j, entry, entry_i) for p in cond.parts])
        if isinstance(cond, N.Predicate):
            if cond.fn in PATTERN_FNS:
                pkey = id(cond)
                if pkey not in self._pattern_cache:
                    self._pattern_cache[pkey] = _pattern_series3(
                        cond, self.candles, self.resolution, self.htf, self.instances
                    )
                arr = self._pattern_cache[pkey]
                return arr[j] if 0 <= j < len(arr) else None
            bullish = cond.fn == "bullish"  # the rest is binary (see _cond_matches3)
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
                return None
            return c > o if bullish else c < o
        if isinstance(cond, N.Cross):
            if j == 0:
                return None  # no prev bar: the straddle is unknowable
            a1, a0 = self._val(cond.a, j, entry, entry_i), self._val(cond.a, j - 1, entry, entry_i)
            b1, b0 = self._val(cond.b, j, entry, entry_i), self._val(cond.b, j - 1, entry, entry_i)
            if not all(_defined(v) for v in (a1, a0, b1, b0)):
                return None
            if cond.fn == "crossAbove":
                return a0 <= b0 and a1 > b1
            return a0 >= b0 and a1 < b1
        # Compare
        return _cmp3(cond.op, self._val(cond.left, j, entry, entry_i), self._val(cond.right, j, entry, entry_i))

    def evaluate(self, i: int, entry_price: float | None, entry_i: int | None = None) -> bool:
        if self.is_const:
            if self._const_val is None:
                self._const_val = self._match3(self.node, i, entry_price, entry_i) is True
            return self._const_val
        return self._match3(self.node, i, entry_price, entry_i) is True

    # --- fill provenance ------------------------------------------------------
    # The wire op names the frontend prettifies (signalGlyphs.opSymbol): raw
    # comparison ops pass through verbatim, crosses use the structured engine's
    # spelling so they render as "crosses ↑ / ↓".
    _CROSS_OP = {"crossAbove": "crossesAbove", "crossBelow": "crossesBelow"}
    # Negation of a comparison flips its operator: `not (a > b)` held because
    # a <= b, and that is the comparison worth showing. (Spelled out here rather
    # than imported from closeness.py, which imports THIS module.) `==` is
    # deliberately absent: the language has no `!=`, so a negated equality has no
    # honest flipped comparison to show.
    _NEG_OP = {">": "<=", ">=": "<", "<": ">=", "<=": ">"}

    def _label(self, sub: N.Node) -> str:
        return self.source[sub.start:sub.end]

    def _operand_tf(self, sub: N.Node) -> str | None:
        """The operand's effective timeframe as a Resolution string: a @tf pin
        anywhere in it wins; an unpinned indicator/series operand runs on the
        run's base resolution; price/const/entry operands are timeframe-less
        (mirrors the structured engine's _operand_timeframe)."""
        tf = N.first_tf(sub)
        if tf is not None:
            return tf_resolution(tf) or tf
        return self.resolution if N.contains_series(sub) else None

    def _term(self, left: N.Node, op: str, right: N.Node, i: int,
              entry: float | None, entry_i: int | None) -> RuleTerm:
        return RuleTerm(
            left_label=self._label(left),
            left_val=self._val(left, i, entry, entry_i),
            op=op,
            right_label=self._label(right),
            right_val=self._val(right, i, entry, entry_i),
            left_tf=self._operand_tf(left),
            right_tf=self._operand_tf(right),
        )

    def _leaf_terms(self, node: N.Node, i: int, entry, entry_i) -> "list[RuleTerm]":
        if isinstance(node, N.BoolOp):
            # Passing branches only: a false `or` branch is not a reason the row
            # fired. (Under `and` every part is True, so this filters nothing.)
            return [t for p in node.parts
                    if self._match3(p, i, entry, entry_i) is True
                    for t in self._leaf_terms(p, i, entry, entry_i)]
        if isinstance(node, N.Not):
            # Reaching a Not means it is True (it is either the row root — and
            # terms_at is called on passing rows only — or a part the BoolOp arm
            # above kept), so its operand is definitely False: report the
            # evidence for the negation.
            return self._negated_terms(node.operand, i, entry, entry_i)
        if isinstance(node, N.Chain):
            return [t for p in node.parts for t in self._leaf_terms(p, i, entry, entry_i)]
        if isinstance(node, N.Compare):
            return [self._term(node.left, node.op, node.right, i, entry, entry_i)]
        if isinstance(node, N.Cross):
            return [self._term(node.a, self._CROSS_OP[node.fn], node.b, i, entry, entry_i)]
        # Predicate: single-operand term (op "") the popover renders label-only.
        return [RuleTerm(
            left_label=self._label(node), left_val=None, op="",
            right_label="", right_val=None,
            left_tf=self._operand_tf(node), right_tf=None,
        )]

    def _negated_terms(self, node: N.Node, i: int, entry, entry_i) -> "list[RuleTerm]":
        """Honest terms for a condition known to be definitely False at `i` —
        the evidence its negation holds. Compare: the flipped comparison
        (`.get`, not `[]`: `==` has no flipped operator since the language has
        no `!=`, so a negated equality says nothing rather than KeyError-ing).
        Chain and `and`: at least one part is definitely False — those
        falsifiers, negated (a part that held, or is unknown, is not evidence).
        `or`: False only when every part is False — all of them, negated.
        Nested Not: its operand is True, so its regular passing terms.
        Cross/Predicate: no honest scalar negation exists (a label-only
        `bullish(candle)` term would read as if the pattern matched)."""
        if isinstance(node, N.Compare):
            neg = self._NEG_OP.get(node.op)
            if neg is None:
                return []
            return [self._term(node.left, neg, node.right, i, entry, entry_i)]
        if isinstance(node, (N.Chain, N.BoolOp)):
            return [t for p in node.parts
                    if self._match3(p, i, entry, entry_i) is False
                    for t in self._negated_terms(p, i, entry, entry_i)]
        if isinstance(node, N.Not):
            return self._leaf_terms(node.operand, i, entry, entry_i)
        return []

    def terms_at(self, i: int, entry: float | None, entry_i: int | None = None
                 ) -> tuple[RuleTerm, ...]:
        """Capture this row's exact comparison(s) at the firing bar `i` — the
        values the engine itself compared, threaded onto the resulting Fill so
        the chart can show *why* the trade fired without recomputing. Call only
        when the row passed at `i` (mirrors the structured engine's `_terms`,
        which captured passing rules only). Empty without a `source` (labels
        are source slices, and a run that can't label terms shouldn't emit
        misleading ones).

        Every term listed reflects a branch that actually CONTRIBUTED to the row
        passing — the same passing-only invariant `_provenance` applies across
        rows, applied inside the row: a false `or` branch is dropped, and a
        negated comparison is reported with its operator flipped. A negated
        cross/predicate contributes no term at all, so a passing row can legally
        yield ()."""
        if not self.source:
            return ()
        return tuple(self._leaf_terms(self.node, i, entry, entry_i))


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
    if isinstance(node, N.BoolOp):
        return all(_entry_free(p) for p in node.parts)
    if isinstance(node, N.Not):
        return _entry_free(node.operand)
    if isinstance(node, N.Chain):
        return all(_entry_free(p) for p in node.parts)
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


def _condition_operands(node: N.Node, subs: list[N.Node], seen: set[int]) -> None:
    """Collect the arithmetic operands of every comparison/cross in a condition
    tree, deduped by identity, for precomputation. Consecutive chain links share
    their middle operand (p[i].right is p[i+1].left), so the dedup keeps it to
    one precompute. Predicates precompute lazily via their own caches."""
    def add(operand: N.Node) -> None:
        if id(operand) not in seen:
            seen.add(id(operand))
            subs.append(operand)
    if isinstance(node, N.BoolOp):
        for p in node.parts:
            _condition_operands(p, subs, seen)
    elif isinstance(node, N.Not):
        _condition_operands(node.operand, subs, seen)
    elif isinstance(node, N.Chain):
        for p in node.parts:
            for operand in N.part_operands(p):
                add(operand)
    elif isinstance(node, N.Compare):
        add(node.left)
        add(node.right)
    elif isinstance(node, N.Cross):
        add(node.a)
        add(node.b)
    # Predicate: match series is built lazily on first evaluate


def compile_row(node: N.Row, candles, resolution, htf,
                instances: "dict[str, ResolvedInstance] | None" = None,
                *, source: str = "") -> CompiledRow:
    cache: dict[int, list[float | None]] = {}
    subs: list[N.Node] = []
    _condition_operands(node, subs, set())
    for sub in subs:
        _precompute(sub, candles, resolution, htf, cache, instances)
    return CompiledRow(node, candles, resolution, htf, instances,
                       warmup_bars(node, resolution, instances), cache, {}, {},
                       source=source, is_const=N.is_constant(node))
