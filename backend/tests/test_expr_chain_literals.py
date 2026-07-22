from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.literals import literals, substitute


def _cmp(op, a, b):
    return N.Compare(op, a, b, a.start, b.end)


def _chain_src():
    # close > EMA(9) > EMA(50): spans chosen so starts are strictly increasing
    close = N.Candle("close", 0, 12)
    e9 = N.Call("EMA", [N.Num(9, 20, 21)], 16, 22)
    e50 = N.Call("EMA", [N.Num(50, 30, 32)], 25, 33)
    p1 = _cmp(">", close, e9)
    p2 = _cmp(">", e9, e50)  # e9 shared with p1
    return N.Chain([p1, p2], 0, 33), (e9, e50)


def test_literals_extracts_each_operand_once():
    chain, _ = _chain_src()
    lits = literals(chain)
    # EMA(9) is shared between the two links but must appear once
    assert [lit.value for lit in lits] == [9, 50]
    assert [lit.ordinal for lit in lits] == [0, 1]


def test_substitute_rewrites_literals_in_all_links():
    chain, _ = _chain_src()
    out = substitute(chain, {0: 21.0, 1: 55.0})
    # the shared EMA(9) becomes EMA(21) in both links (same node object)
    assert out.parts[0].right.args[0].value == 21.0
    assert out.parts[1].left.args[0].value == 21.0
    assert out.parts[1].right.args[0].value == 55.0
