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
