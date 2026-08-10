# ATR%(length) Expression Function Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `ATR%(length)` — ATR ÷ close × 100, the legend's ATR% math — as a first-class function in the backtest rule expression language.

**Architecture:** The expr engine is two hand-written parser stacks kept in lockstep: TS (`frontend/src/lib/expr/parser.ts`, registry in `catalog.ts`) and Python (`backend/auto_trader/strategy/expr/lexer.py`/`parser.py`, registry in `registry.py`), with `corpus.json` as the shared parity fixture. Evaluation happens only on the backend (`evaluate.py`). Both stacks are registry-driven, so the work is: teach both lexers that `%` is a name character, add one registry entry per stack, add the evaluate branch, and extend the corpus.

**Tech Stack:** TypeScript + vitest (`cd frontend && npx vitest run <file>`), Python + pytest (`cd backend && python -m pytest tests/<file> -q`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-10-atr-percent-expression-design.md`
- `%` is legal only INSIDE a name (never leading), exactly like `#`; only in the alpha-leading name loop, NOT the digit-leading branch — both lexers must match char-for-char.
- Evaluation: RMA (Wilder) `atr_series`, divisor = bar close, `None` when ATR is `None` or close ≤ 0.
- Frontend test baseline is NOT green (5–7 known failures on main); run only the expr-scoped test files and never "fix" unrelated failures.
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Backend — lex `%` in names, register `ATR%`

**Files:**
- Modify: `backend/auto_trader/strategy/expr/lexer.py:107` (name continuation loop)
- Modify: `backend/auto_trader/strategy/expr/registry.py:18` (INDICATORS dict)
- Test: `backend/tests/test_expr_lexer.py`, `backend/tests/test_expr_parser.py`

**Interfaces:**
- Produces: `tokenize("ATR%")` → one `NAME` token `"ATR%"`; `registry.INDICATORS["ATR%"] == IndicatorSpec(1, "length")`; `parse("ATR%(14) < 0.8")` succeeds.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_expr_lexer.py`:

```python
def test_percent_is_a_name_character():
    assert _types("ATR%(14)") == [
        ("NAME", "ATR%", 0, 4),
        ("LPAREN", "(", 4, 5),
        ("NUMBER", "14", 5, 7),
        ("RPAREN", ")", 7, 8),
        ("EOF", "", 8, 8),
    ]


def test_leading_percent_is_bad_char():
    with pytest.raises(ExprError) as exc:
        tokenize("% > 1")
    assert exc.value.code == "bad_char"
```

Append to `backend/tests/test_expr_parser.py` (it already imports `parse`; mirror the file's existing imports if not):

```python
def test_atr_percent_parses_as_indicator_call():
    parse("ATR%(14) < 0.8")  # must not raise
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_expr_lexer.py tests/test_expr_parser.py -q -k "percent"`
Expected: `test_percent_is_a_name_character` and `test_atr_percent_parses_as_indicator_call` FAIL (`bad_char` on `%`); `test_leading_percent_is_bad_char` passes already.

- [ ] **Step 3: Implement**

In `lexer.py` line 107, extend the name-continuation class (update the `#` comment above it to mention `%` and `ATR%`):

```python
            while j < n and (_is_alnum(src[j]) or src[j] in "_#%"):
```

In `registry.py`, after the `"ATR"` entry:

```python
    "ATR%": IndicatorSpec(1, "length"),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_expr_lexer.py tests/test_expr_parser.py -q`
Expected: all PASS (no regressions in either file).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/strategy/expr/lexer.py backend/auto_trader/strategy/expr/registry.py backend/tests/test_expr_lexer.py backend/tests/test_expr_parser.py
git commit -m "feat(expr): backend lexes % in names and registers ATR% indicator"
```

### Task 2: Frontend — lex `%` in names, register `ATR%` in the catalog

**Files:**
- Modify: `frontend/src/lib/expr/parser.ts:243` (name continuation loop + its `#` comment)
- Modify: `frontend/src/lib/expr/catalog.ts` (INDICATORS array line ~23, INDICATOR_SPECS line ~91)
- Test: `frontend/src/lib/expr/parser.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (stacks are independent until the corpus task).
- Produces: `analyze("ATR%(14) < 0.8").error === null`; `INDICATOR_SPECS["ATR%"] = { arity: 1, argKind: "length" }` (highlight.ts and lint pick this up generically).

- [ ] **Step 1: Write the failing tests**

Append inside the `describe("analyze", ...)` block of `frontend/src/lib/expr/parser.test.ts`:

```ts
  it("parses ATR% as an indicator call with a length literal", () => {
    const { literals, error } = analyze("ATR%(14) < 0.8");
    expect(error).toBeNull();
    expect(literals.map((l) => [l.value, l.label])).toEqual([
      [14, "ATR% length"], [0.8, "threshold"],
    ]);
  });

  it("keeps a leading % a lex error", () => {
    expect(analyze("% > 1").error?.code).toBe("bad_char");
  });
```

(If the `literals` objects carry no `label` field in TS, assert `[l.ordinal, l.value]` pairs `[[0, 14], [1, 0.8]]` instead — check the existing first test in the file, which asserts ordinal/value.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/expr/parser.test.ts`
Expected: the ATR% test FAILS (bad_char on `%`); the leading-% test passes already.

- [ ] **Step 3: Implement**

`parser.ts` line 243 (extend the comment above it to mention `%`/`ATR%` alongside `#`):

```ts
      while (j < n && (isAlnum(src[j]) || src[j] === "_" || src[j] === "#" || src[j] === "%")) j += 1;
```

`catalog.ts` — after the ATR entry in `INDICATORS`:

```ts
  { name: "ATR%", insert: "ATR%(14)", signature: "ATR%(length)", detail: "ATR as % of close" },
```

and after the ATR line in `INDICATOR_SPECS`:

```ts
  "ATR%": { arity: 1, argKind: "length" },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/expr/parser.test.ts src/lib/expr/highlight.test.ts src/lib/expr/lint.ts src/lib/expr/complete.test.ts`
(Substitute the actual lint test filename if different; only expr-scoped files.)
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/expr/parser.ts frontend/src/lib/expr/catalog.ts frontend/src/lib/expr/parser.test.ts
git commit -m "feat(expr): frontend lexes % in names and registers ATR% in the catalog"
```

### Task 3: Corpus parity entries

**Files:**
- Modify: `frontend/src/lib/expr/corpus.json`
- Test (existing, auto-pick-up): `frontend/src/lib/expr/corpus.test.ts`, `backend/tests/test_expr_parser_corpus.py`

**Interfaces:**
- Consumes: `ATR%` registered on both stacks (Tasks 1–2).
- Produces: shared fixtures guarding against future stack drift on `%` names.

- [ ] **Step 1: Add corpus entries**

Append to the array in `corpus.json` (offsets: in `"ATR%(14) < 0.8"` the `14` spans [5,7) and `0.8` spans [11,14); in `"avg(ATR%(14), 5) > 1"` the `14` spans [9,11) and `5` spans [14,15)):

```json
  { "expr": "ATR%(14) < 0.8", "isExit": false, "error": null,
    "literals": [
      {"ordinal":0,"value":14,"from":5,"to":7,"label":"ATR% length"},
      {"ordinal":1,"value":0.8,"from":11,"to":14,"label":"threshold"}
    ] },
  { "expr": "avg(ATR%(14), 5) > 1", "isExit": false, "error": null,
    "literals": [
      {"ordinal":0,"value":14,"from":9,"to":11,"label":"ATR% length"},
      {"ordinal":1,"value":5,"from":14,"to":15,"label":"avg window"},
      {"ordinal":2,"value":1,"from":19,"to":20,"label":"threshold"}
    ] },
  { "expr": "% > 1", "isExit": false, "error": {"code":"bad_char","from":0,"to":1}, "literals": [] },
  { "expr": "FOO%(9) > 0", "isExit": false, "error": {"code":"unknown_name","from":0,"to":7}, "literals": [] }
```

Before trusting the hand-computed labels/spans above, check what the analyzers actually emit (the corpus test failure output shows the actual values; correct the fixture to match ONLY if both stacks agree with each other).

- [ ] **Step 2: Run both corpus suites**

Run: `cd frontend && npx vitest run src/lib/expr/corpus.test.ts`
Run: `cd backend && python -m pytest tests/test_expr_parser_corpus.py -q`
Expected: both PASS. If they disagree with each other (not just with the fixture), STOP — that is a real stack-drift bug to fix, not a fixture to fudge.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/expr/corpus.json
git commit -m "test(expr): corpus entries for ATR% parsing and % error cases"
```

### Task 4: Backend evaluation

**Files:**
- Modify: `backend/auto_trader/strategy/expr/evaluate.py:75` (`_indicator_raw`)
- Test: `backend/tests/test_expr_evaluate.py`

**Interfaces:**
- Consumes: `"ATR%"` registered in `registry.py` (Task 1); `atr_series` already imported in evaluate.py.
- Produces: `_indicator_raw("ATR%", [n], candles)` → per-bar `atr/close*100` or `None`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_expr_evaluate.py` (uses the file's existing `_bars` helper, which derives high/low from open/close so ATR is non-trivial):

```python
def test_atr_percent_is_atr_over_close_times_100():
    candles = _bars([(1.0, 2.0), (2.0, 3.0), (3.0, 2.5), (2.5, 4.0), (4.0, 3.0)])
    from auto_trader.strategy.expr.evaluate import _indicator_raw
    atr = _indicator_raw("ATR", [2.0], candles)
    atrp = _indicator_raw("ATR%", [2.0], candles)
    for a, p, c in zip(atr, atrp, candles):
        if a is None:
            assert p is None
        else:
            assert p == pytest.approx(a / c.close * 100)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_expr_evaluate.py -q -k atr_percent`
Expected: FAIL — `atrp` is all `None` (unknown-name fallthrough).

- [ ] **Step 3: Implement**

In `evaluate.py::_indicator_raw`, after the `ATR` branch:

```python
    if name == "ATR%":
        # The legend's ATR% readout at its defaults: RMA ATR over the bar close.
        return [
            (a / c.close) * 100.0 if a is not None and c.close > 0 else None
            for a, c in zip(atr_series(candles, int(args_vals[0])), candles)
        ]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_expr_evaluate.py tests/test_expr_warmup.py tests/test_expr_validate.py tests/test_expr_literals.py -q`
Expected: all PASS (warmup/validate/literals exercise the registry generically; a failure there means the registry entry broke an invariant — investigate, don't skip).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/strategy/expr/evaluate.py backend/tests/test_expr_evaluate.py
git commit -m "feat(expr): evaluate ATR%(n) as RMA ATR over close x100"
```

### Task 5: Completion accepts `%` in the typed prefix

**Files:**
- Modify: `frontend/src/lib/expr/complete.ts:206` (bare-word regex) and `:279` (`validFor`)
- Test: `frontend/src/lib/expr/complete.test.ts`

**Interfaces:**
- Consumes: `"ATR%"` in `INDICATORS`/`INDICATOR_SPECS` (Task 2).
- Produces: typing `ATR` offers both `ATR` and `ATR%`; typing `ATR%` keeps the `ATR%` option live instead of dropping completions.

- [ ] **Step 1: Write the failing test**

Open `frontend/src/lib/expr/complete.test.ts`, find how existing tests build a completion context (they call the exported completion source with a doc + cursor position — copy the file's own helper/pattern verbatim). Add, following that pattern:

```ts
  it("offers ATR% for the prefix ATR and keeps matching after the %", () => {
    // Using the file's existing helper for options-at-cursor:
    const atLabels = (doc: string) => optionsFor(doc).map((o) => o.label);
    expect(atLabels("ATR")).toEqual(expect.arrayContaining(["ATR", "ATR%"]));
    expect(atLabels("ATR%")).toEqual(expect.arrayContaining(["ATR%"]));
  });
```

(`optionsFor` is a stand-in for whatever helper the file already uses — reuse it, do not invent a new harness.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/expr/complete.test.ts`
Expected: the `"ATR%"`-prefix case FAILS (the word regex stops before `%`, so no options or wrong `from`).

- [ ] **Step 3: Implement**

`complete.ts` line 206:

```ts
  const wordMatch = /([A-Za-z_][A-Za-z0-9_%]*)$/.exec(before);
```

`complete.ts` line 279:

```ts
  return { from, to: pos, options, validFor: /[A-Za-z0-9_#.%]*$/ };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/expr/`
Expected: all expr-suite tests PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/expr/complete.ts frontend/src/lib/expr/complete.test.ts
git commit -m "feat(expr): completion matches % in the typed prefix for ATR%"
```

### Task 6: Full scoped verification

**Files:** none (verification only)

- [ ] **Step 1: Backend expr suite**

Run: `cd backend && python -m pytest tests/ -q -k expr`
Expected: all PASS.

- [ ] **Step 2: Frontend expr + typecheck**

Run: `cd frontend && npx vitest run src/lib/expr/ && npx tsc --noEmit -p .`
(Use the project's typecheck script from package.json if one exists.)
Expected: vitest PASS; tsc clean. Do NOT run the full frontend suite — the baseline has known failures unrelated to this work.

- [ ] **Step 3: Commit any stragglers / finish**

If both are green and the tree is clean apart from committed work, the feature is done.
