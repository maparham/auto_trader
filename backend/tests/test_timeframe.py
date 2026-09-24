import json
import pathlib

import pytest

from auto_trader.brokers.capital_stream import SECONDS_INTERVALS
from auto_trader.core import timeframe as tf

CORPUS = json.loads(
    (pathlib.Path(__file__).parents[2] / "frontend/src/lib/timeframes.corpus.json").read_text()
)


@pytest.mark.parametrize("row", CORPUS, ids=lambda r: r["input"] or "<empty>")
def test_corpus(row):
    if row.get("error"):
        with pytest.raises(tf.TimeframeError):
            tf.canonicalize(row["input"])
        return
    assert tf.canonicalize(row["input"]) == row["canonical"]
    assert tf.label(row["input"]) == row["label"]
    assert tf.seconds(row["input"]) == row["seconds"]


def test_seconds_keys_match_stream():
    assert tf.SECONDS_KEYS == SECONDS_INTERVALS


def test_error_names_the_limit():
    with pytest.raises(tf.TimeframeError, match="between 1 and 1439"):
        tf.canonicalize("MINUTE_1440")


def test_error_is_a_value_error():
    # Existing callers catch ValueError around resolution_seconds().
    assert issubclass(tf.TimeframeError, ValueError)


def test_is_native():
    assert tf.is_native("HOUR_4") and tf.is_native("4H") and tf.is_native("MINUTE_60")
    assert not tf.is_native("HOUR_6") and not tf.is_native("MONTH")
    assert not tf.is_native("SECOND_5")
