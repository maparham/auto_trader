"""The Python half of the shared SLOPE warm-up corpus.

frontend/src/lib/indicators/slopeWarmupCases.json is read by BOTH stacks — here
against `slope_warmup`, and by frontend/src/lib/indicators/slopeWarmupParity.
test.ts against slopeOutputs.ts `slopeWarmup`. One table, two readers, so the
frontend's history-ask depth and the backend's actual series requirement cannot
drift apart without a test failing.

Same arrangement as test_expr_parser_corpus.py: the corpus lives in the frontend
tree and the backend test reaches across for it.
"""

import json
import pathlib

import pytest

from auto_trader.indicators.slope import (
    parse_slope_config, slope_outputs, slope_warmup,
)

CASES = json.loads(
    (pathlib.Path(__file__).parents[2]
     / "frontend/src/lib/indicators/slopeWarmupCases.json").read_text()
)


@pytest.mark.parametrize("case", CASES, ids=[c["label"] for c in CASES])
def test_slope_warmup_matches_corpus(case):
    cfg = parse_slope_config(case["calcParams"], case["extendData"])
    # The output SET must agree too: a table listing outputs this config does not
    # expose (or missing one it does) would silently stop covering its own case.
    assert sorted(slope_outputs(cfg)) == sorted(case["warmup"])
    for output, want in case["warmup"].items():
        assert slope_warmup(cfg, output) == want


def test_the_corpus_actually_exercises_accel_and_smoothing():
    """A corpus of six plain single-line panes would pass while proving nothing
    about the two terms most likely to be dropped in a port."""
    assert any(o.startswith("accel") for c in CASES for o in c["warmup"])
    assert any(
        (c["extendData"].get("smoothing") or {}).get("type") == "ema" for c in CASES
    )
    assert any(
        (c["extendData"].get("accelSmoothing") or {}).get("type") == "ema" for c in CASES
    )


def test_the_review_scenario():
    """Pinned separately from the corpus loop so the number the fix is about is
    visible in the test file, not only in a data file."""
    cfg = parse_slope_config(
        [50], {"slopePeriod": 3, "smoothing": {"type": "ema", "length": 10}}
    )
    # 50 (MA length) + 3 (slope period) + 9 (EMA(10) smoothing costs length-1).
    assert slope_warmup(cfg, "50") == 62
