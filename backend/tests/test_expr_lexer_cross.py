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
