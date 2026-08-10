# ATR Pane pct Instance-Ref Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rules can reference an ATR pane's ATR% as `ATR1.14.pct`, honoring the pane's Smoothing and % Source settings.

**Architecture:** One grammar change mirrored in both parser stacks (fuse `.NAME` onto an all-digits ref output), then purely registry-driven extension: the ATR instance modules (`frontend/src/lib/atr.ts`, `backend/auto_trader/indicators/atr.py`) grow a second output `"<len>.pct"`; generic layers (lint, completion lists, warmup, backend `IndicatorSeriesSpec` dispatch) pick it up. Backend also gains `price_of` (port of `mtf.ts::priceOf`) and pctSource parsing.

**Tech Stack:** TypeScript + vitest (`cd frontend && npx vitest run <paths>`), Python + pytest (`cd backend && python -m pytest <paths> -q`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-10-atr-pane-pct-ref-design.md`
- Fusion rule, identical in both parsers: only when the ref's current output is ALL DIGITS and the next tokens are `DOT NAME`; fused output = `"<digits>.<name>"`; span extends to the name end. One level only (a fused output is no longer all-digits).
- Deliberate error-shape change: `SLOPE.9.foo` becomes `unknown_indicator_output` (was `field_on_indicator_ref`). `X.9[-1].foo` keeps `field_on_indicator_ref`.
- pct math: pane-smoothed ATR ÷ `price_of(bar, pctSource)` × 100; `None`/undefined when ATR is undefined or the price ≤ 0. pctSource normalization: open/high/low/close/hl2/hlc3/ohlc4/hlcc4, anything else → close.
- Frontend test baseline is NOT green; run only the test files this plan names.
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Backend grammar — fuse `.name` onto a digits ref output

**Files:**
- Modify: `backend/auto_trader/strategy/expr/parser.py` (postfix DOT branch, ~line 255)
- Test: `backend/tests/test_indicator_ref_parse.py`

**Interfaces:**
- Produces: `parse("ATR1.14.pct > 1")` yields `N.IndicatorRef("ATR1", "14.pct")` with end span covering `pct`. `parse("ATR1.14.pct.x > 1")` yields `Field(IndicatorRef)` (validate later reports `field_on_indicator_ref`).

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_indicator_ref_parse.py` (check its imports first; it already imports `parse` and `nodes as N` — mirror them if not):

```python
def test_dotted_name_after_digits_output_fuses_into_the_ref():
    node = parse("ATR1.14.pct > 1").left
    assert isinstance(node, N.IndicatorRef)
    assert node.instance == "ATR1"
    assert node.output == "14.pct"
    assert (node.start, node.end) == (0, 11)


def test_second_chain_level_does_not_fuse():
    node = parse("ATR1.14.pct.x > 1").left
    assert isinstance(node, N.Field)
    assert isinstance(node.base, N.IndicatorRef)
    assert node.base.output == "14.pct"


def test_offset_breaks_the_fusion_chain():
    node = parse("ATR1.14[-1].pct > 1").left
    assert isinstance(node, N.Field)  # Field(Offset(IndicatorRef))
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_indicator_ref_parse.py -q -k "fuse or chain"`
Expected: first test FAILS (today `ATR1.14.pct` parses as `Field(IndicatorRef)`, output `"14"`); the other two may already pass.

- [ ] **Step 3: Implement**

In `parser.py`, in the DOT branch of the postfix loop, after the existing `node = N.IndicatorRef(...)` / `N.Field(...)` assignment block, the ref-building arm becomes:

```python
                elif is_ref:
                    node = N.IndicatorRef(node.name, field.value, node.start, field.end)
                    # A digits-named output may carry ONE dotted sub-name
                    # ("ATR1.14.pct"): fuse it into the output so downstream
                    # layers stay string-keyed. A fused output is no longer
                    # all-digits, so a further ".x" falls through to Field
                    # (-> field_on_indicator_ref), and offsets in between
                    # break the chain the same way.
                    if (field.value.isdigit() and self.peek().type == "DOT"
                            and self.toks[self.i + 1].type == "NAME"):
                        self.next()
                        sub = self.next()
                        node = N.IndicatorRef(node.instance, f"{node.output}.{sub.value}",
                                              node.start, sub.end)
```

(Confirm the parser's lookahead spelling: it uses `self.toks[self.i + 1]` at line ~100 for the cross-fn check — reuse exactly that idiom. `field.value.isdigit()` is safe: output came from a NUMBER or NAME token, both ASCII by the lexer's classes.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_indicator_ref_parse.py tests/test_expr_parser.py tests/test_expr_validate.py -q`
Expected: all PASS. If a validate test asserted `field_on_indicator_ref` for a `X.<digits>.name` shape, update it to `unknown_indicator_output` per the spec (only that shape — offset variants keep the old code).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/strategy/expr/parser.py backend/tests/
git commit -m "feat(expr): backend parser fuses .name onto digits ref outputs"
```

### Task 2: Frontend grammar — same fusion

**Files:**
- Modify: `frontend/src/lib/expr/parser.ts` (`parsePostfix`, ~line 564)
- Test: `frontend/src/lib/expr/parser.test.ts`

**Interfaces:**
- Consumes: nothing (stacks independent until corpus).
- Produces: `analyze("ATR1.14.pct > 1", {instances})` errors only if the instance lacks that output; the `SLOPE.9.foo` test flips to `unknown_indicator_output`.

- [ ] **Step 1: Update/write the tests**

In `parser.test.ts`, replace the body of `it("rejects a field hung off a ref's output", ...)` (~line 337):

```ts
  it("fuses one dotted sub-name and rejects deeper chains", () => {
    // SLOPE.9.foo fuses to output "9.foo" — an unknown output now, not a field.
    expect(analyze("SLOPE.9.foo > 0", { instances: INSTANCES }).errors[0].code)
      .toBe("unknown_indicator_output");
    // An offset breaks the chain: the field hangs off the Offset, not the ref.
    expect(analyze("SLOPE.9[-1].foo > 0", { instances: INSTANCES }).errors[0].code)
      .toBe("field_on_indicator_ref");
    // A fused output takes no second level.
    expect(analyze("SLOPE.9.foo.x > 0", { instances: INSTANCES }).errors[0].code)
      .toBe("field_on_indicator_ref");
  });
```

(Keep the `SLOPE#p1n.50.foo @4H` nested_tf test as-is; the nested-pin check still precedes output validation — verify it still passes in Step 4.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/expr/parser.test.ts`
Expected: the new first assertion FAILS (`field_on_indicator_ref` today).

- [ ] **Step 3: Implement**

In `parsePostfix`, the IndicatorRef-building arm becomes:

```ts
        } else if (isRef && node.kind === "Call") {
          node = { kind: "IndicatorRef", instance: node.name, output: field.value, start: node.start, end: field.end };
          // A digits-named output may carry ONE dotted sub-name
          // ("ATR1.14.pct"): fuse it into the output so downstream layers stay
          // string-keyed. A fused output is no longer all-digits, so a further
          // ".x" falls through to Field (-> field_on_indicator_ref), and
          // offsets in between break the chain the same way. Mirrors parser.py.
          if (/^[0-9]+$/.test(field.value) && this.peek().type === "DOT" && this.peekAt(1)?.type === "NAME") {
            this.next();
            const sub = this.next();
            node = { kind: "IndicatorRef", instance: node.instance, output: `${node.output}.${sub.value}`, start: node.start, end: sub.end };
          }
        } else {
```

First check how parser.ts does two-token lookahead (the x-fusion or cross-fn check); if there is no `peekAt`, index the token array directly the way the backend does (`this.toks[this.i + 1]` equivalent — find the field name used for the token list and cursor). Match the file's existing idiom exactly.

Note the fused-ref node's `instance`/`output` reads: TypeScript narrows `node` to the IndicatorRef variant after the assignment on the previous line, so `node.instance` is legal; if the narrowing fails, hoist `const instance = node.name` before building the first ref.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/expr/parser.test.ts src/lib/expr/corpus.test.ts src/lib/expr/highlight.test.ts src/lib/expr/lint.test.ts 2>/dev/null || cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run src/lib/expr/`
Expected: all PASS (corpus has no `X.digits.name` entries yet, so it must not change behavior).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/expr/parser.ts frontend/src/lib/expr/parser.test.ts
git commit -m "feat(expr): frontend parser fuses .name onto digits ref outputs"
```

### Task 3: Backend ATR module — pctSource config, price_of, pct series, outputs, warmup

**Files:**
- Modify: `backend/auto_trader/indicators/core.py` (add `price_of`)
- Modify: `backend/auto_trader/indicators/atr.py` (AtrConfig, parse_atr_config, atr_outputs, atr_pane_series, atr_warmup)
- Test: `backend/tests/test_indicator_ref_evaluate.py` (end-to-end), plus wherever `parse_atr_config` is already unit-tested — find with `grep -rln parse_atr_config backend/tests` and extend that file; if none, put unit tests in `backend/tests/test_indicator_ref_evaluate.py` too.

**Interfaces:**
- Consumes: Task 1's grammar (for the end-to-end `series_of` test).
- Produces: `price_of(candle, source) -> float`; `AtrConfig(length, smoothing, pct_source)`; `atr_outputs(cfg) == (str(len), f"{len}.pct")`; `atr_pane_series(cfg, f"{len}.pct", candles, bar_hours)`; `atr_warmup(cfg, f"{len}.pct") == cfg.length`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_indicator_ref_evaluate.py`:

```python
ATR_PAYLOAD = {"ATR1": {"type": "ATR", "calcParams": [5],
                        "extendData": {"smoothing": "ema", "pctSource": "hl2"}}}


def test_atr_pct_output_honors_smoothing_and_pct_source():
    from auto_trader.indicators.atr import atr_pane_series, parse_atr_config
    from auto_trader.indicators.core import atr_smoothed_series, price_of
    candles = mk(40)
    cfg = parse_atr_config([5], {"smoothing": "ema", "pctSource": "hl2"})
    assert cfg.pct_source == "hl2"
    got = atr_pane_series(cfg, "5.pct", candles, 1.0)
    base = atr_smoothed_series(candles, 5, "ema")
    for g, a, c in zip(got, base, candles):
        if a is None:
            assert g is None
        else:
            assert g == pytest.approx(a / ((c.high + c.low) / 2) * 100)


def test_atr_pct_source_defaults_to_close_on_garbage():
    from auto_trader.indicators.atr import parse_atr_config
    assert parse_atr_config([5], {"pctSource": "bogus"}).pct_source == "close"
    assert parse_atr_config([5], None).pct_source == "close"


def test_price_of_composite_sources():
    from auto_trader.indicators.core import price_of
    c = Candle(time=datetime(2024, 1, 1, tzinfo=timezone.utc),
               open=10.0, high=20.0, low=8.0, close=14.0, volume=1.0)
    assert price_of(c, "open") == 10.0
    assert price_of(c, "high") == 20.0
    assert price_of(c, "low") == 8.0
    assert price_of(c, "close") == 14.0
    assert price_of(c, "hl2") == 14.0
    assert price_of(c, "hlc3") == pytest.approx((20 + 8 + 14) / 3)
    assert price_of(c, "ohlc4") == pytest.approx((10 + 20 + 8 + 14) / 4)
    assert price_of(c, "hlcc4") == pytest.approx((20 + 8 + 14 + 14) / 4)
    assert price_of(c, "junk") == 14.0


def test_atr_ref_pct_end_to_end_and_warmup():
    from auto_trader.indicators.atr import atr_warmup, parse_atr_config
    candles = mk(40)
    instances = resolve_instances(ATR_PAYLOAD)
    got = series_of(expr("ATR1.5.pct > 1"), candles, "HOUR", {}, instances)
    assert len(got) == len(candles)
    assert any(v is not None for v in got)
    cfg = parse_atr_config([5], {})
    assert atr_warmup(cfg, "5") == 5
    assert atr_warmup(cfg, "5.pct") == 5
    assert atr_warmup(cfg, "bogus") == 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_indicator_ref_evaluate.py -q -k "atr_pct or price_of or atr_ref"`
Expected: FAIL — `price_of` doesn't exist; `AtrConfig` has no `pct_source`; `"5.pct"` is not a known output.

- [ ] **Step 3: Implement**

`core.py`, next to `atr_smoothed_series`:

```python
def price_of(c: Candle, source: str) -> float:
    """mtf.ts::priceOf — the bar price a composite source names; unknown -> close."""
    if source == "open":
        return c.open
    if source == "high":
        return c.high
    if source == "low":
        return c.low
    if source == "hl2":
        return (c.high + c.low) / 2
    if source == "hlc3":
        return (c.high + c.low + c.close) / 3
    if source == "ohlc4":
        return (c.open + c.high + c.low + c.close) / 4
    if source == "hlcc4":
        return (c.high + c.low + c.close + c.close) / 4
    return c.close
```

`atr.py`:

```python
PCT_SOURCES = ("open", "high", "low", "close", "hl2", "hlc3", "ohlc4", "hlcc4")


@dataclass(frozen=True, slots=True)
class AtrConfig:
    length: int
    smoothing: str
    pct_source: str
```

In `parse_atr_config`, add to the return (after the smoothing line; reuse the existing `ext` dict):

```python
    pct_source = ext.get("pctSource")
    return AtrConfig(
        length=length,
        smoothing=smoothing if smoothing in SMOOTHINGS else "rma",
        pct_source=pct_source if pct_source in PCT_SOURCES else "close",
    )
```

`atr_outputs` (update its docstring to mention the pct output rides the same retune-breaks-loudly convention):

```python
def atr_outputs(cfg: AtrConfig) -> tuple[str, ...]:
    return (str(cfg.length), f"{cfg.length}.pct")
```

`atr_pane_series`:

```python
def atr_pane_series(
    cfg: AtrConfig, output: str, candles: Sequence[Candle], bar_hours: float
) -> list[float | None]:
    if cfg.smoothing == "rma":
        base = atr_series(candles, cfg.length)
    else:
        base = atr_smoothed_series(candles, cfg.length, cfg.smoothing)
    if output != f"{cfg.length}.pct":
        return base
    # The legend's ATR% readout: pane-smoothed ATR over the pane's % Source.
    out: list[float | None] = []
    for a, c in zip(base, candles):
        p = price_of(c, cfg.pct_source)
        out.append((a / p) * 100.0 if a is not None and p > 0 else None)
    return out
```

(Add `price_of` to the existing `from auto_trader.indicators.core import ...` line.)

`atr_warmup`:

```python
def atr_warmup(cfg: AtrConfig, output: str) -> int:
    return cfg.length if output in (str(cfg.length), f"{cfg.length}.pct") else 0
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_indicator_ref_evaluate.py tests/test_expr_atr_risk_parity.py tests/test_indicator_ref_parse.py -q`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/indicators/core.py backend/auto_trader/indicators/atr.py backend/tests/test_indicator_ref_evaluate.py
git commit -m "feat(indicators): ATR pane exposes a pct output honoring smoothing and % source"
```

### Task 4: Frontend — atrOutputs/atrWarmup grow the pct output; completion matches dotted prefixes

**Files:**
- Modify: `frontend/src/lib/atr.ts` (`atrOutputs`, `atrWarmup`)
- Modify: `frontend/src/lib/expr/complete.ts` (`REF_DOT_RE`)
- Test: `frontend/src/lib/expr/complete.test.ts`, plus the file that already tests `atrOutputs`/`atrWarmup` (find with `grep -rln atrOutputs frontend/src --include='*.test.ts'`; if none exists, add assertions to `frontend/src/lib/indicators/atr.test.ts`).

**Interfaces:**
- Consumes: `ExprInstance.outputs` plumbing (already generic in `exprInstances.ts`).
- Produces: `atrOutputs([14]) == ["14", "14.pct"]`; `atrWarmup([14], "14.pct") == 14`; typing `ATR1.14.p` still offers the `14.pct` output.

- [ ] **Step 1: Write the failing tests**

In the file found above (assume `frontend/src/lib/indicators/atr.test.ts`; follow its import style):

```ts
  it("exposes the pct output alongside the value output", () => {
    expect(atrOutputs([14])).toEqual(["14", "14.pct"]);
    expect(atrWarmup([14], "14.pct")).toBe(14);
    expect(atrWarmup([14], "14")).toBe(14);
    expect(atrWarmup([14], "bogus")).toBe(0);
  });
```

In `complete.test.ts` — find how existing instance-ref completion tests build `instances` (an `ExprInstance[]` with `id`/`outputs`/`detail`; copy an existing fixture) and add:

```ts
  it("completes a dotted pct output prefix", () => {
    const instances = [{ id: "ATR1", outputs: ["14", "14.pct"], timeframe: null, detail: "RMA" }];
    const labels = (doc: string) =>
      completionsFor(doc, doc.length, { instances }).map((o) => o.label);
    expect(labels("ATR1.")).toEqual(expect.arrayContaining(["14", "14.pct"]));
    expect(labels("ATR1.14.p")).toContain("14.pct");
    expect(completionAnchor("ATR1.14.p", 9, { instances })).toBe(5);
  });
```

(Verify the `ExprInstance` field names against `catalog.ts` before writing the fixture; adjust to the real shape.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/indicators/atr.test.ts src/lib/expr/complete.test.ts`
Expected: both new tests FAIL (`atrOutputs` returns one name; `REF_DOT_RE` can't span the inner dot).

- [ ] **Step 3: Implement**

`lib/atr.ts` (extend the atrOutputs docstring: the pct output rides the same length-named convention; both rename on retune):

```ts
export function atrOutputs(calcParams: unknown[] | undefined): string[] {
  const length = atrLength(calcParams);
  return [String(length), `${length}.pct`];
}

export function atrWarmup(calcParams: unknown[] | undefined, output: string): number {
  const length = atrLength(calcParams);
  return output === String(length) || output === `${length}.pct` ? length : 0;
}
```

`complete.ts` — let the output part of a typed ref prefix carry dots (comment why):

```ts
// The output part may itself contain a dot ("14.pct"), so the tail class
// includes "." — the instance-id part still cannot, keeping the split stable.
const REF_DOT_RE = /([A-Za-z_][A-Za-z0-9_#%]*)\.([A-Za-z0-9_.]*)$/;
```

Check the two `REF_DOT_RE` consumers (`completionAnchor` line ~252 and the options builder): both treat group 1 as the instance id and group 2 as the typed output prefix; with the greedy id class unchanged, `"ATR1.14.p"` now matches id `"ATR1"`, prefix `"14.p"` — confirm the options builder filters `outputs` by `startsWith(prefix)` so `"14.pct"` survives.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/expr/ src/lib/indicators/atr.test.ts src/lib/exprInstances.test.ts 2>/dev/null; cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run src/lib/expr/ src/lib/indicators/atr.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/atr.ts frontend/src/lib/expr/complete.ts frontend/src/lib/expr/complete.test.ts frontend/src/lib/indicators/atr.test.ts
git commit -m "feat(expr): ATR pane pct output in ref outputs and completion"
```

### Task 5: Corpus parity entries

**Files:**
- Modify: `frontend/src/lib/expr/corpus.json`

**Interfaces:**
- Consumes: Tasks 1–4 (fusion on both stacks; ATR outputs on both stacks).
- Produces: drift guard for the fused-ref grammar.

- [ ] **Step 1: Add entries**

Follow the existing SLOPE-instance entry shape (`instances` key). Append:

```json
  { "expr": "ATR1.14.pct > 1", "isExit": false, "error": null,
    "instances": {"ATR1": {"type":"ATR","calcParams":[14],"extendData":{"smoothing":"ema","pctSource":"hl2"}}},
    "literals": [
      {"ordinal":0,"value":1,"from":16,"to":17,"label":"threshold"}
    ] },
  { "expr": "ATR1.14.bogus > 1", "isExit": false, "error": {"code":"unknown_indicator_output","from":0,"to":13},
    "instances": {"ATR1": {"type":"ATR","calcParams":[14],"extendData":{}}},
    "literals": [] },
  { "expr": "ATR1.14.pct.x > 1", "isExit": false, "error": {"code":"field_on_indicator_ref","from":0,"to":13},
    "instances": {"ATR1": {"type":"ATR","calcParams":[14],"extendData":{}}},
    "literals": [] }
```

Spans are hand-computed — if a corpus run disagrees, first check whether BOTH stacks agree with each other; fix the fixture only when they do. (The `field_on_indicator_ref` span may anchor on the field node rather than the root — take the actual agreed span. Check whether existing error entries include literals for valid sub-parts and match that convention.)

- [ ] **Step 2: Run both corpus suites**

Run: `cd frontend && npx vitest run src/lib/expr/corpus.test.ts`
Run: `cd backend && python -m pytest tests/test_expr_parser_corpus.py -q`
Expected: both PASS. Stack disagreement = real bug; stop and fix the stack, not the fixture.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/expr/corpus.json
git commit -m "test(expr): corpus entries for fused ATR pct ref outputs"
```

### Task 6: Full scoped verification

**Files:** none (verification only)

- [ ] **Step 1: Backend**

Run: `cd backend && python -m pytest tests/ -q -k "expr or indicator_ref or atr"`
Expected: all PASS.

- [ ] **Step 2: Frontend**

Run: `cd frontend && npx vitest run src/lib/expr/ src/lib/indicators/ src/lib/exprInstances.test.ts 2>/dev/null; npx vitest run src/lib/expr/ src/lib/indicators/; npx tsc --noEmit -p .`
Expected: vitest PASS on the expr and indicators suites; tsc exit 0. Do NOT run the full frontend suite (known non-green baseline).

- [ ] **Step 3: Finish**

Clean tree apart from committed work → done.
