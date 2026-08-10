import pytest
from auto_trader.strategy.expr.errors import ExprError
from auto_trader.strategy.expr.lexer import tokenize


def _types(src):
    return [(t.type, t.value, t.start, t.end) for t in tokenize(src)]


def test_tokenizes_names_numbers_operators_with_spans():
    assert _types("EMA(9) >= 1.5") == [
        ("NAME", "EMA", 0, 3),
        ("LPAREN", "(", 3, 4),
        ("NUMBER", "9", 4, 5),
        ("RPAREN", ")", 5, 6),
        ("GE", ">=", 7, 9),
        ("NUMBER", "1.5", 10, 13),
        ("EOF", "", 13, 13),
    ]


def test_tokenizes_postfix_and_at():
    assert [t.type for t in tokenize("candle[-1].open@4H")] == [
        "NAME", "LBRACKET", "MINUS", "NUMBER", "RBRACKET", "DOT", "NAME", "AT", "NAME", "EOF"
    ]


def test_bad_char_raises_with_span():
    with pytest.raises(ExprError) as exc:
        tokenize("EMA(9) ~ 1")
    assert exc.value.code == "bad_char"
    assert (exc.value.start, exc.value.end) == (7, 8)


def test_tokenizes_equality_with_spans():
    assert _types("count(candle.close > candle.open, 5) == 3")[-4:] == [
        ("RPAREN", ")", 35, 36),
        ("EQ", "==", 37, 39),
        ("NUMBER", "3", 40, 41),
        ("EOF", "", 41, 41),
    ]


def test_bare_equals_is_a_targeted_error_not_bad_char():
    with pytest.raises(ExprError) as exc:
        tokenize("EMA(9) = 1")
    assert exc.value.code == "bad_eq_op"
    assert exc.value.message == "Use == for equality."
    assert (exc.value.start, exc.value.end) == (7, 8)


def test_trailing_bare_equals_reports_at_the_equals():
    with pytest.raises(ExprError) as exc:
        tokenize("EMA(9) =")
    assert exc.value.code == "bad_eq_op"
    assert (exc.value.start, exc.value.end) == (7, 8)


def test_ge_and_le_still_lex_as_before():
    # The new "=" branch must not intercept the second character of >= or <=.
    assert [t.type for t in tokenize("1 >= 2")] == ["NUMBER", "GE", "NUMBER", "EOF"]
    assert [t.type for t in tokenize("1 <= 2")] == ["NUMBER", "LE", "NUMBER", "EOF"]


def test_equals_never_fuses_with_a_leading_x():
    # "=" must not join the x> / x< cross-operator fusion branch: there is no
    # cross-equality, so "x" here is just an unknown variable the parser will
    # report. Guards the constraint that a future refactor would silently break.
    assert [t.type for t in tokenize("x == 3")] == ["NAME", "EQ", "NUMBER", "EOF"]
    assert [t.type for t in tokenize("x==3")] == ["NAME", "EQ", "NUMBER", "EOF"]


def test_percent_is_a_name_character():
    assert _types("ATR%(14)") == [
        ("NAME", "ATR%", 0, 4),
        ("LPAREN", "(", 4, 5),
        ("NUMBER", "14", 5, 7),
        ("RPAREN", ")", 7, 8),
        ("EOF", "", 8, 8),
    ]


def test_leading_percent_is_bad_char():
    with pytest.raises(ExprError) as exc:
        tokenize("% > 1")
    assert exc.value.code == "bad_char"
