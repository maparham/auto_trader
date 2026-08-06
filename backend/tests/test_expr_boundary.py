"""The governing constraint: strategy/expr/ holds no slope math and no
slope-specific branch. It may reach the indicator layer only through the
generic, shared modules (registry descriptors, core series helpers, mtf
alignment, candle patterns) — never through a concrete indicator module.

This is an architectural guard, not a behaviour test. If it fails, the fix is
almost always in the code it points at, not here.

Note on the `slope(x, n)` WRAPPER: it is a pre-existing expression-LANGUAGE
builtin (`WRAPPERS = {"slope": 2, ...}`, evaluated via
`auto_trader.indicators.mtf.slope_of`) and has nothing to do with the SLOPE
chart indicator. Every pattern below is chosen so the wrapper's own vocabulary
— `slope`, `slope_of`, `WRAPPERS`, `pctHr` (the wrapper's percent-per-hour
units) — passes untouched, while the SLOPE *indicator*'s vocabulary trips it.
"""

import ast
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
EXPR_DIR = BACKEND_ROOT / "auto_trader" / "strategy" / "expr"

# The GENERIC seam. `auto_trader.indicators` submodules that expr/ may import:
# shared math and the descriptor registry, none of which name an indicator.
# Anything else under that package is a concrete indicator module (today:
# slope.py) and is exactly the coupling this guard exists to prevent.
ALLOWED_INDICATOR_MODULES = frozenset({"core", "mtf", "candle_patterns", "registry"})

INDICATORS_PKG = "auto_trader.indicators"

# Vocabulary that belongs to the SLOPE INDICATOR (its config keys, its config
# parser, its output helper) or to a slope-specific branch. None of these are
# substrings of the wrapper's names, so `slope`/`slope_of`/`WRAPPERS` are safe.
SLOPE_INDICATOR_TOKENS = (
    '"SLOPE"',  # a literal `if name == "SLOPE"` branch
    "'SLOPE'",
    "maType",  # SlopeConfig extend-data keys (indicators/slope.py)
    "showAccel",
    "accelPeriod",
    "accelSmoothing",
    "accelAbsolute",
    "pctHr",  # SLOPE_UNITS members. The slope(x, n) WRAPPER computes
    "pctBar",  # percent-per-hour too, but never NAMES a unit: it has one
    "priceBar",  # mode, and `slope_of` takes bar_hours, not a units string.
    "SLOPE_UNITS",
    "SlopeConfig",
    "parse_slope_config",
    "slope_outputs",
)


def _expr_sources() -> list[Path]:
    # rglob, not glob: a future `expr/subpkg/` must not escape either guard.
    paths = sorted(EXPR_DIR.rglob("*.py"))
    assert paths, f"no sources found under {EXPR_DIR}"
    return paths


def _package_of(path: Path) -> str:
    """The dotted package a source file lives in, e.g.
    `auto_trader.strategy.expr`."""
    return ".".join(path.relative_to(BACKEND_ROOT).parts[:-1])


def _absolute_module(node: ast.ImportFrom, path: Path) -> str:
    """`node`'s module as an ABSOLUTE dotted path, resolving `from .. import`.

    `ImportFrom.level` is 0 for an absolute import, 1 for the current package,
    2 for its parent, and so on — so level N drops N-1 trailing segments off the
    importing file's own package.
    """
    if node.level == 0:
        return node.module or ""
    parts = _package_of(path).split(".")
    base = parts[: len(parts) - (node.level - 1)] if node.level > 1 else parts
    tail = (node.module or "").split(".") if node.module else []
    return ".".join([*base, *tail])


def _submodule_after_indicators(dotted: str) -> str | None:
    """The segment following an `indicators` package segment in `dotted`:
    `"slope"` for `...indicators.slope`, `""` for a bare `...indicators`
    (meaning the submodule is named by the import's aliases instead), or None
    when `dotted` does not traverse an `indicators` package at all."""
    parts = dotted.split(".") if dotted else []
    if "indicators" not in parts:
        return None
    i = parts.index("indicators")
    return parts[i + 1] if i + 1 < len(parts) else ""


def _imported_indicator_modules(tree: ast.AST, path: Path) -> list[str]:
    """Every `indicators` submodule reached by `tree`, by name.

    Covers all four spellings, absolute and relative:
      from auto_trader.indicators.slope import x   -> "slope"
      from auto_trader.indicators import slope     -> "slope"
      import auto_trader.indicators.slope          -> "slope"
      from ...indicators.slope import x            -> "slope"

    Relative imports are resolved against the file's own package, but the
    `indicators` segment is looked for in the RAW module path too, so a
    mis-levelled relative import that resolves nowhere real still fails
    closed rather than sailing past a prefix test.
    """
    found: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            sub = _submodule_after_indicators(_absolute_module(node, path))
            if sub is None:
                sub = _submodule_after_indicators(node.module or "")
            if sub is None:
                continue
            # A bare `... import indicators` names its submodules in the aliases.
            found.extend([sub] if sub else [a.name for a in node.names])
        elif isinstance(node, ast.Import):
            for a in node.names:
                sub = _submodule_after_indicators(a.name)
                if sub:
                    found.append(sub)
    return found


def test_expr_never_imports_a_concrete_indicator_module():
    offenders = []
    for path in _expr_sources():
        tree = ast.parse(path.read_text(), filename=str(path))
        for mod in _imported_indicator_modules(tree, path):
            if mod not in ALLOWED_INDICATOR_MODULES:
                offenders.append(f"{path.name}: indicators.{mod}")
    assert not offenders, (
        f"strategy/expr/ may only import {sorted(ALLOWED_INDICATOR_MODULES)} "
        f"from {INDICATORS_PKG}; found: {offenders}"
    )


def test_expr_never_names_a_slope_concept():
    """No `if name == "SLOPE"`, no units/maType/accel handling.

    `slope`, `slope_of` and `WRAPPERS` are the pre-existing slope(x, n) WRAPPER,
    which is a language feature rather than the indicator — they stay.
    """
    offenders = []
    for path in _expr_sources():
        text = path.read_text()
        for bad in SLOPE_INDICATOR_TOKENS:
            if bad in text:
                offenders.append(f"{path.name}: {bad}")
    assert not offenders, (
        "strategy/expr/ must stay generic; SLOPE-indicator vocabulary found: "
        f"{offenders}"
    )
