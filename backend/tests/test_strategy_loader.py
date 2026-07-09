"""Discovery + loading of user strategy files (backend/strategies/*.py)."""

from pathlib import Path

import pytest

from auto_trader.strategy.loader import (
    STRATEGIES_DIR,
    StrategyLoadError,
    list_strategies,
    load_strategy,
)


def write(tmp_path: Path, name: str, body: str) -> Path:
    p = tmp_path / name
    p.write_text(body)
    return p


GOOD = '''"""Docstring description."""
meta = {"name": "My Strat"}
def on_bar(ctx):
    return []
'''

HEDGED = '''meta = {"name": "Hedger", "description": "meta wins", "hedged": True}
def on_bar(ctx):
    return []
'''

BROKEN = "def on_bar(ctx:\n"  # syntax error

NO_ON_BAR = '"""Has no on_bar."""\nx = 1\n'


def test_list_strategies(tmp_path):
    write(tmp_path, "good.py", GOOD)
    write(tmp_path, "hedged.py", HEDGED)
    write(tmp_path, "broken.py", BROKEN)
    write(tmp_path, "no_on_bar.py", NO_ON_BAR)
    infos = {i.filename: i for i in list_strategies(tmp_path)}
    assert set(infos) == {"good.py", "hedged.py", "broken.py", "no_on_bar.py"}

    good = infos["good.py"]
    assert good.name == "My Strat"
    assert good.description == "Docstring description."  # docstring fallback
    assert good.hedged is False and good.error is None

    hedged = infos["hedged.py"]
    assert hedged.description == "meta wins"  # meta beats docstring
    assert hedged.hedged is True

    assert infos["broken.py"].error is not None  # syntax error captured, not raised
    assert "on_bar" in (infos["no_on_bar.py"].error or "")


def test_list_missing_dir_is_empty(tmp_path):
    assert list_strategies(tmp_path / "nope") == []


def test_load_strategy(tmp_path):
    write(tmp_path, "good.py", GOOD)
    mod = load_strategy("good.py", tmp_path)
    assert callable(mod.on_bar)
    # Fresh exec each call: two loads are distinct module objects.
    assert load_strategy("good.py", tmp_path) is not mod


def test_load_rejects_bad_names(tmp_path):
    write(tmp_path, "good.py", GOOD)
    for bad in ("../evil.py", "good", "missing.py"):
        with pytest.raises(StrategyLoadError):
            load_strategy(bad, tmp_path)


def test_load_syntax_error_raises(tmp_path):
    write(tmp_path, "broken.py", BROKEN)
    with pytest.raises(StrategyLoadError, match="broken.py"):
        load_strategy("broken.py", tmp_path)


def test_default_dir_has_the_example():
    assert STRATEGIES_DIR.name == "strategies"
    names = [i.filename for i in list_strategies()]
    assert "ema_cross.py" in names
