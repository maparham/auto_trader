import pytest

from auto_trader.strategy.expr.errors import BAD_CROSS_MSG, ExprError
from auto_trader.strategy.expr.lexer import tokenize


def _types(src):
    return [t.type for t in tokenize(src)]


def test_x_gt_lexes_as_single_token():
    toks = tokenize("EMA(9) x> EMA(50)")
    assert _types("EMA(9) x> EMA(50)") == [
        "NAME", "LPAREN", "NUMBER", "RPAREN", "XGT",
        "NAME", "LPAREN", "NUMBER", "RPAREN", "EOF",
    ]
    xgt = toks[4]
    assert (xgt.value, xgt.start, xgt.end) == ("x>", 7, 9)


def test_x_lt_lexes_as_single_token():
    toks = tokenize("candle.close x< EMA(9)")
    assert toks[3].type == "XLT"
    assert (toks[3].value, toks[3].start, toks[3].end) == ("x<", 13, 15)


def test_spaced_x_stays_a_name():
    # "x >" is NOT the operator: NAME then GT.
    assert _types("EMA(9) x > EMA(50)")[4:6] == ["NAME", "GT"]


def test_uppercase_x_stays_a_name():
    assert _types("X> EMA(9)")[:2] == ["NAME", "GT"]


def test_longer_identifier_ending_in_x_stays_a_name():
    # only a bare "x" fuses with the bracket
    assert _types("max> 3")[:2] == ["NAME", "GT"]


def test_number_absorbs_trailing_x():
    # digit branch absorbs alnum (as it must for 4H): "50x" is one NAME.
    toks = tokenize("50x> 60")
    assert [t.type for t in toks] == ["NAME", "GT", "NUMBER", "EOF"]
    assert toks[0].value == "50x"


# --- ASCII alignment with the frontend lexer -------------------------------
# The TS mirror's character classes are explicit ASCII ranges, so unicode
# letters/digits must hit the same bad_char branch on both stacks.

def test_cyrillic_x_before_bracket_is_bad_char():
    # Cyrillic "х" (U+0445) looks like the cross operator but is not ASCII.
    with pytest.raises(ExprError) as ei:
        tokenize("EMA(9) х> EMA(50)")
    assert ei.value.code == "bad_char"
    assert (ei.value.start, ei.value.end) == (7, 8)


def test_cyrillic_identifier_is_bad_char_at_its_first_char():
    with pytest.raises(ExprError) as ei:
        tokenize("ЕМА(9) > 2")
    assert ei.value.code == "bad_char"
    assert (ei.value.start, ei.value.end) == (0, 1)


def test_arabic_indic_digits_are_bad_char():
    with pytest.raises(ExprError) as ei:
        tokenize("EMA(٩) > 2")
    assert ei.value.code == "bad_char"
    assert (ei.value.start, ei.value.end) == (4, 5)


def test_unicode_suffix_does_not_extend_an_ascii_name():
    # "EMAЕ" — the name stops at the ASCII run; the Cyrillic char is bad_char.
    with pytest.raises(ExprError) as ei:
        tokenize("EMAЕ(9) > 2")
    assert (ei.value.code, ei.value.start, ei.value.end) == ("bad_char", 3, 4)


def test_unicode_digit_after_a_number_is_bad_char():
    with pytest.raises(ExprError) as ei:
        tokenize("9٩ > 2")
    assert (ei.value.code, ei.value.start, ei.value.end) == ("bad_char", 1, 2)


# --- x>= gets the tailored cross-operator message ---------------------------

def test_x_ge_is_bad_cross_op_over_the_whole_operator():
    with pytest.raises(ExprError) as ei:
        tokenize("EMA(9) x>= 2")
    assert ei.value.code == "bad_cross_op"
    assert ei.value.message == BAD_CROSS_MSG
    assert (ei.value.start, ei.value.end) == (7, 10)


def test_x_le_is_bad_cross_op_too():
    with pytest.raises(ExprError) as ei:
        tokenize("EMA(9) x<= 2")
    assert (ei.value.code, ei.value.start, ei.value.end) == ("bad_cross_op", 7, 10)


def test_trailing_fused_bracket_at_eof_still_lexes():
    # No character after the bracket: the fuse must not read past the end.
    assert _types("EMA(9) x>") == ["NAME", "LPAREN", "NUMBER", "RPAREN", "XGT", "EOF"]


def test_no_space_fuse_is_unaffected():
    assert _types("EMA(9)x>EMA(50)") == [
        "NAME", "LPAREN", "NUMBER", "RPAREN", "XGT",
        "NAME", "LPAREN", "NUMBER", "RPAREN", "EOF",
    ]
