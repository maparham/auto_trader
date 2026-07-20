import json
import pathlib

import pytest

from auto_trader.strategy.expr.errors import ExprError
from auto_trader.strategy.expr.literals import literals
from auto_trader.strategy.expr.parser import parse
from auto_trader.strategy.expr.validate import validate

CORPUS = json.loads(
    (pathlib.Path(__file__).parents[2] / "frontend/src/lib/expr/corpus.json").read_text()
)


@pytest.mark.parametrize("case", CORPUS, ids=[c["expr"] for c in CORPUS])
def test_backend_matches_corpus(case):
    try:
        node = parse(case["expr"])
        validate(node, is_exit=case["isExit"])
        err = None
    except ExprError as e:
        err = e
    if case["error"]:
        assert err is not None and err.code == case["error"]["code"]
        assert (err.start, err.end) == (case["error"]["from"], case["error"]["to"])
    else:
        assert err is None
        got = [(lit.ordinal, lit.value, lit.start, lit.end, lit.label) for lit in literals(node)]
        want = [
            (x["ordinal"], x["value"], x["from"], x["to"], x["label"])
            for x in case["literals"]
        ]
        assert got == want
