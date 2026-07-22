from auto_trader.strategy.expr import nodes as N


def _cmp(op, a, b):
    return N.Compare(op, a, b, a.start, b.end)


def test_chain_holds_parts_and_span():
    close = N.Candle("close", 0, 12)
    e9 = N.Call("EMA", [N.Num(9, 21, 22)], 15, 23)
    e50 = N.Call("EMA", [N.Num(50, 30, 32)], 26, 33)
    p1 = _cmp(">", close, e9)
    p2 = _cmp(">", e9, e50)
    chain = N.Chain([p1, p2], p1.start, p2.end)
    assert chain.parts == [p1, p2]
    assert (chain.start, chain.end) == (0, 33)


def test_contains_tf_sees_into_chain_parts():
    close = N.Candle("close", 0, 12)
    e9_d = N.Tf(N.Call("EMA", [N.Num(9, 0, 0)], 0, 0), "D", 0, 0)
    e50 = N.Call("EMA", [N.Num(50, 0, 0)], 0, 0)
    plain = N.Chain([_cmp(">", close, e50), _cmp(">", e50, e50)], 0, 0)
    tfd = N.Chain([_cmp(">", close, e9_d), _cmp(">", e9_d, e50)], 0, 0)
    assert N.contains_tf(plain) is False
    assert N.contains_tf(tfd) is True
