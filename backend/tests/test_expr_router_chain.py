from auto_trader.api.routers.expr import _referenced_tfs
from auto_trader.strategy.expr import nodes as N


def _cmp(op, a, b):
    return N.Compare(op, a, b, 0, 0)


def test_referenced_tfs_unions_across_chain_parts():
    close = N.Candle("close", 0, 0)
    e9_d = N.Tf(N.Call("EMA", [N.Num(9, 0, 0)], 0, 0), "D", 0, 0)
    e50_h = N.Tf(N.Call("EMA", [N.Num(50, 0, 0)], 0, 0), "H", 0, 0)
    chain = N.Chain([_cmp(">", close, e9_d), _cmp(">", e9_d, e50_h)], 0, 0)
    assert _referenced_tfs(chain) == {"D", "H"}
