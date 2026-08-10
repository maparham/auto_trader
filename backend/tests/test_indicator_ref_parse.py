import pytest

from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.errors import ExprError
from auto_trader.strategy.expr.lexer import tokenize
from auto_trader.strategy.expr.parser import parse
from auto_trader.strategy.expr.validate import validate


def test_hash_is_legal_inside_a_name():
    row = parse("SLOPE#a1b2c3.9 > 0")
    assert isinstance(row.left, N.IndicatorRef)
    assert row.left.instance == "SLOPE#a1b2c3"
    assert row.left.output == "9"


def test_a_plain_instance_ref_parses():
    row = parse("SLOPE.9 > 0.5")
    assert isinstance(row.left, N.IndicatorRef)
    assert (row.left.instance, row.left.output) == ("SLOPE", "9")


def test_a_ref_composes_under_offset_and_timeframe():
    row = parse("SLOPE.9[-2] @1H > 0")
    tf = row.left
    assert isinstance(tf, N.Tf) and tf.tf == "1H"
    assert isinstance(tf.base, N.Offset)
    assert isinstance(tf.base.base, N.IndicatorRef)


def test_a_ref_composes_inside_a_wrapper():
    row = parse("slope(SLOPE.9, 5) > 0")
    assert isinstance(row.left, N.Call)
    assert isinstance(row.left.args[0], N.IndicatorRef)


def test_a_registered_indicator_call_is_still_a_call_not_a_ref():
    row = parse("EMA(9) > 0")
    assert isinstance(row.left, N.Call) and row.left.name == "EMA"


def test_a_field_on_a_registered_call_is_untouched():
    # Still Field(Call), so validate keeps reporting field_on_call.
    row = parse("EMA(9).signal > 0")
    assert isinstance(row.left, N.Field)


def test_hash_still_rejected_as_a_leading_character():
    with pytest.raises(ExprError) as e:
        parse("#SLOPE > 0")
    assert e.value.code == "bad_char"


def test_contains_tf_sees_through_a_ref():
    assert N.contains_tf(parse("SLOPE.9 @1H > 0").left) is True
    assert N.contains_tf(parse("SLOPE.9 > 0").left) is False


def test_field_on_zero_arg_indicator_is_untouched():
    # VOL is arity-0 and registered in INDICATORS, so `VOL.x` must stay a
    # Field(Call) — not an IndicatorRef — and validate must still report
    # field_on_call, exercising the INDICATORS exclusion term specifically
    # (unlike EMA(9).signal, which is excluded earlier by `not node.args`).
    row = parse("VOL.x > 0")
    assert isinstance(row.left, N.Field)
    with pytest.raises(ExprError) as e:
        validate(row, is_exit=False)
    assert e.value.code == "field_on_call"


def test_field_on_bare_wrapper_name_is_untouched():
    # `slope` is a registered wrapper name; bare (no parens) it's still
    # Call('slope', []), so `.x` must stay Field, exercising WRAPPERS.
    row = parse("slope.x > 0")
    assert isinstance(row.left, N.Field)
    with pytest.raises(ExprError) as e:
        validate(row, is_exit=False)
    assert e.value.code == "field_on_call"


def test_field_on_bare_predicate_name_is_untouched():
    # `doji` is a registered candle-pattern predicate name; bare it's
    # Call('doji', []), so `.x` must stay Field, exercising PREDICATE_FNS.
    row = parse("doji.x > 0")
    assert isinstance(row.left, N.Field)
    with pytest.raises(ExprError) as e:
        validate(row, is_exit=False)
    assert e.value.code == "unknown_name"


def test_field_on_bare_cross_fn_name_is_untouched():
    # `crossAbove` is a registered cross fn name; bare it's Call('crossAbove',
    # []), so `.x` must stay Field, exercising CROSS_FNS.
    row = parse("crossAbove.x > 0")
    assert isinstance(row.left, N.Field)
    with pytest.raises(ExprError) as e:
        validate(row, is_exit=False)
    assert e.value.code == "cross_not_toplevel"


# --- the lexer's dot rule ------------------------------------------------------
#
# `SLOPE.9` only reaches the parser because tokenize stopped treating a "." that
# follows a NAME / ")" / "]" as the start of a decimal literal. These pin both
# halves of that rule: the new spelling works, and the leading-dot decimals that
# always worked still do. The TS mirror is pinned by the same three expressions
# in frontend/src/lib/expr/parser.test.ts, and corpus.json runs all three
# through BOTH stacks.
@pytest.mark.parametrize("src, types, values", [
    # The "." after a NAME is field access, never the decimal 0.9.
    ("SLOPE.9 > 0", ["NAME", "DOT", "NUMBER", "GT", "NUMBER"], ["SLOPE", ".", "9", ">", "0"]),
    # A "." after an operator still starts a decimal.
    ("2 + .5", ["NUMBER", "PLUS", "NUMBER"], ["2", "+", ".5"]),
    # ...and so does a leading one.
    (".5 > 0", ["NUMBER", "GT", "NUMBER"], [".5", ">", "0"]),
])
def test_a_dot_starts_a_decimal_only_where_no_field_can_follow(src, types, values):
    toks = tokenize(src)[:-1]   # drop EOF
    assert [t.type for t in toks] == types
    assert [t.value for t in toks] == values


def test_a_dot_after_a_bracket_is_field_access_not_a_decimal():
    # "]" joins NAME and ")" in the no-decimal set, so an offset can be followed
    # by a field: `SLOPE.9[-1].foo` must not swallow ".f" or ".9".
    toks = tokenize("SLOPE.9[-1] > 0")[:-1]
    assert [t.type for t in toks] == [
        "NAME", "DOT", "NUMBER", "LBRACKET", "MINUS", "NUMBER", "RBRACKET", "GT", "NUMBER",
    ]


def test_a_numeric_output_does_not_swallow_a_following_field():
    # The timeframe fusion ("1.5H" is one NAME) must not apply straight after a
    # ".", or `SLOPE.9.foo` would lex as a single NAME "9.foo" and report a
    # confusing unknown-output error instead of the stray-field one.
    assert [t.type for t in tokenize("SLOPE.9.foo")[:-1]] == [
        "NAME", "DOT", "NUMBER", "DOT", "NAME",
    ]
    assert [t.value for t in tokenize("1.5H")[:-1]] == ["1.5H"]   # still fused


# --- a NUMBER output is accepted ONLY where an indicator ref is built ----------
@pytest.mark.parametrize("src", [
    "candle.9 > 0",      # Candle root
    "EMA(9).9 > 0",      # a call WITH args
    "VOL.9 > 0",         # a registered zero-arg indicator
    "slope.9 > 0",       # a registered wrapper name
    "doji.9 > 0",        # a registered predicate name
    "crossAbove.9 > 0",  # a registered cross fn name
])
def test_a_numeric_field_is_rejected_outside_an_indicator_ref(src):
    # The four-category exclusion set plus `candle`: only a bare UNREGISTERED
    # zero-arg name may take a number as its field, because only there is a
    # number a name (a pane's outputs are named by its MA lengths).
    with pytest.raises(ExprError) as e:
        parse(src)
    assert e.value.code == "unexpected_token"


def test_a_numeric_output_still_parses_after_offset_and_pin():
    row = parse("SLOPE.9[-2] @1H > 0")
    tf = row.left
    assert isinstance(tf, N.Tf)
    assert isinstance(tf.base, N.Offset)
    assert isinstance(tf.base.base, N.IndicatorRef)
    assert tf.base.base.output == "9"


def test_dotted_name_after_digits_output_fuses_into_the_ref():
    node = parse("ATR1.14.to% > 1").left
    assert isinstance(node, N.IndicatorRef)
    assert node.instance == "ATR1"
    assert node.output == "14.to%"
    assert (node.start, node.end) == (0, 11)


def test_second_chain_level_does_not_fuse():
    node = parse("ATR1.14.to%.x > 1").left
    assert isinstance(node, N.Field)
    assert isinstance(node.base, N.IndicatorRef)
    assert node.base.output == "14.to%"


def test_offset_breaks_the_fusion_chain():
    node = parse("ATR1.14[-1].to% > 1").left
    assert isinstance(node, N.Field)  # Field(Offset(IndicatorRef))
