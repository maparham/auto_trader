"""Config-level parity gate: the assembler's full series map must equal the
frontend buildSeries output for the same config+candles. Regenerate the golden
with `npx vitest run src/lib/ruleSeriesParityGolden.test.ts`."""
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from auto_trader.api.schemas import RiskConfigDTO, RuleGroupDTO
from auto_trader.core.models import Candle
from auto_trader.strategy.rule_series import build_rule_series

GOLDEN = Path(__file__).parent / "fixtures" / "rule_series_golden.json"


def _candles(rows):
    return [
        Candle(time=datetime.fromtimestamp(r["timestamp"] / 1000, tz=timezone.utc),
               open=r["open"], high=r["high"], low=r["low"], close=r["close"], volume=r["volume"])
        for r in rows
    ]


def _operands(cfg):
    ops = []
    for key in ("longEntry", "longExit", "shortEntry", "shortExit"):
        group = cfg.get(key) or {"combine": "AND", "rules": []}
        ops += [o.to_operand() for o in RuleGroupDTO(**group).operands()]
    return ops


def _atr_lengths(cfg):
    lengths = []
    for key in ("longRisk", "shortRisk"):
        if cfg.get(key):
            for name in RiskConfigDTO(**cfg[key]).atr_series_names():
                lengths.append(int(name.split("_")[1]))
    return lengths


def test_assembler_matches_buildSeries_golden():
    g = json.loads(GOLDEN.read_text())
    candles = _candles(g["candles"])
    htf = {tf: _candles(rows) for tf, rows in g["htf"].items()}
    ops = _operands(g["config"])
    out = build_rule_series(ops, candles, g["baseResolution"], htf, _atr_lengths(g["config"]))

    assert set(out) == set(g["series"]), "series keys differ from buildSeries"
    for name, expected in g["series"].items():
        got = out[name]
        assert len(got) == len(expected)
        for a, b in zip(got, expected):
            if a is None or b is None:
                assert a is b, f"{name}: None mismatch"
            else:
                assert a == pytest.approx(b, rel=1e-12, abs=1e-12), f"{name} diverged"
