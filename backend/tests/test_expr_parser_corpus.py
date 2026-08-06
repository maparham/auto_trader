import json
import pathlib

import pytest

from auto_trader.strategy.expr.errors import ExprError
from auto_trader.strategy.expr.literals import literals
from auto_trader.strategy.expr.parser import parse
from auto_trader.strategy.expr.validate import validate
from auto_trader.indicators.registry import resolve_instances

CORPUS = json.loads(
    (pathlib.Path(__file__).parents[2] / "frontend/src/lib/expr/corpus.json").read_text()
)


@pytest.mark.parametrize("case", CORPUS, ids=[c["expr"] for c in CORPUS])
def test_backend_matches_corpus(case):
    # A case's raw pane map, converted by the SAME function the routers use, so
    # a row also guards slope_outputs vs the frontend's slopeOutputs: an output
    # one side exposes and the other doesn't surfaces as a code mismatch.
    instances = resolve_instances(case["instances"]) if case.get("instances") else None
    try:
        node = parse(case["expr"])
        validate(node, is_exit=case["isExit"], instances=instances)
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


def test_the_corpus_covers_indicator_references():
    """These rows are a guard, not a repair: both stacks already agreed on all of
    them by hand. Losing them would leave the reference syntax — the whole point
    of the feature — untested for cross-stack agreement."""
    with_refs = [c for c in CORPUS if c.get("instances")]
    assert len(with_refs) >= 4
    assert any("#" in c["expr"] for c in with_refs)
    assert any("x>" in c["expr"] for c in with_refs)
    assert any(c["error"] for c in with_refs)
