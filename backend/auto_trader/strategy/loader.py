"""Discovery + loading of user-coded strategy files.

Strategies are plain .py files in backend/strategies/, edited in the user's own
IDE — the app only discovers, describes, and loads them. Loading is a fresh
exec every time (the file changes between runs); nothing is cached, matching
the stateless-strategy contract (state on the module would die between live
bars anyway). No sandboxing: this is a single-user local tool and the files
carry the same trust as the rest of the backend."""

from __future__ import annotations

import importlib.util
import traceback
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType

# backend/auto_trader/strategy/loader.py -> backend/strategies/
STRATEGIES_DIR = Path(__file__).resolve().parents[2] / "strategies"


class StrategyLoadError(Exception):
    """A strategy file failed to load (bad name, syntax error, no on_bar)."""


@dataclass(frozen=True, slots=True)
class StrategyInfo:
    filename: str
    name: str
    description: str
    hedged: bool
    error: str | None = None


def _describe(module: ModuleType, filename: str) -> StrategyInfo:
    meta = getattr(module, "meta", None)
    meta = meta if isinstance(meta, dict) else {}
    doc = (module.__doc__ or "").strip()
    return StrategyInfo(
        filename=filename,
        name=str(meta.get("name") or Path(filename).stem),
        description=str(meta.get("description") or doc),
        hedged=bool(meta.get("hedged", False)),
    )


def load_strategy(filename: str, directory: Path | None = None) -> ModuleType:
    """Load `filename` from the strategies dir, fresh each call. The filename
    must be a plain `*.py` basename (no path separators — the API exposes these
    names verbatim, so reject traversal outright)."""
    directory = directory or STRATEGIES_DIR
    if Path(filename).name != filename or not filename.endswith(".py"):
        raise StrategyLoadError(f"invalid strategy filename '{filename}'")
    path = directory / filename
    if not path.is_file():
        raise StrategyLoadError(f"strategy file not found: '{filename}'")
    spec = importlib.util.spec_from_file_location(f"user_strategy_{path.stem}", path)
    assert spec and spec.loader  # spec_from_file_location on an existing .py
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as e:
        tb = traceback.format_exc(limit=-1)
        raise StrategyLoadError(f"{filename}: failed to load — {e}\n{tb}") from e
    if not callable(getattr(module, "on_bar", None)):
        raise StrategyLoadError(f"{filename}: no on_bar(ctx) function defined")
    return module


def list_strategies(directory: Path | None = None) -> list[StrategyInfo]:
    """Every *.py in the strategies dir, described. A file that fails to load is
    still listed, with the failure in `error`, so the UI can show it (the user
    is mid-edit in their IDE — a broken file must be visible, not vanish)."""
    directory = directory or STRATEGIES_DIR
    if not directory.is_dir():
        return []
    out: list[StrategyInfo] = []
    for path in sorted(directory.glob("*.py")):
        try:
            module = load_strategy(path.name, directory)
            out.append(_describe(module, path.name))
        except StrategyLoadError as e:
            out.append(StrategyInfo(
                filename=path.name, name=path.stem, description="",
                hedged=False, error=str(e),
            ))
        except BaseException as e:
            # A strategy file can call sys.exit()/raise KeyboardInterrupt at import
            # time (exec_module runs its top-level code) — those subclass
            # BaseException, not Exception, so load_strategy's `except Exception`
            # doesn't catch them. Listing must not let one broken file abort the
            # whole discovery scan; the user is mid-edit and needs to see it's broken.
            out.append(StrategyInfo(
                filename=path.name, name=path.stem, description="",
                hedged=False, error=f"{path.name}: failed to load — {e}",
            ))
    return out
