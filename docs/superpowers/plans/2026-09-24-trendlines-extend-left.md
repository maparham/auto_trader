# TRENDLINES Extend Left Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new TRENDLINES setting, Extend Left (calcParams slot 28), that starts each line at the nearest earlier pool pivot it touches, counting the crossings on the way, and falls back to the unextended line when the extension breaks a ceiling.

**Architecture:** A new optional `i0` start field on `TrendLine`, read through `lineStart(line) = line.i0 ?? line.i1` wherever the code means "where the line starts"; the anchors `(i1, p1, i2, p2)` never move, so geometry is bit-identical. The seed step gains two pure helpers, `findLeftStart` and `extendedCopy`, mirrored in Python, and a fallback on `overCeilings`.

**Tech Stack:** TypeScript (vitest), Python 3.14 (pytest, uv), React settings UI.

**Spec:** `docs/superpowers/specs/2026-09-24-trendlines-extend-left-design.md`

## Global Constraints

- TS (`frontend/src/lib/indicators/trendlines.ts`, `trendlinesOutputs.ts`) and Python (`backend/auto_trader/indicators/trendlines.py`) stay value-identical; the parity golden (`backend/tests/fixtures/indicator_golden.json`, written by `frontend/src/lib/indicatorParityGolden.test.ts`) must match bit for bit.
- Extend Left OFF (slot absent or 0) is identity: every existing test, fixture and the existing golden series stay byte-identical.
- Slot 28, 0 = off (default), 1 = on, parsed as `zeroInt` clamped to 1.
- The walk reaches back at most Max Projection bars (`i1 - idx > maxProjBars` stops it), never past Lookback (`withinLookback(idx, i, cfg)`), and uses the NEAREST touching pool pivot only.
- Pool entries AT `i1` are skipped. Touch test is `touchWeight(cand, pj, pv, kj, cfg.touchMult * atr[pj], cfg.pierceMult * atr[pj]) > 0`, `atr[pj]` null skips the entry.
- Extended line: crossings recounted over `(i0, i]`; if `overCeilings(extended, cfg)` the unextended line is kept.
- Geometry and identity keep `i1` (projectAt, sideSign, touchWeight, slope, back clearance, the `a.i1 - b.i1` origin tie-break, `lineKey`, `meetsAt`, `drawnPivotIdxs`).
- Tooltip copy, exact: ["Starts each line at the nearest earlier swing it touched.", "The line keeps its angle; that swing counts as a touch.", "Breaks on the way count as crossings.", "Skipped if the longer line fails a filter when it is found."]
- No em dashes or "--" in any UI text or comment you add.
- Shared worktree: never `git stash`, `git clean`, `git restore`, `git checkout -- <file>`; stage explicit paths only. Other sessions have uncommitted files; leave them alone.
- Never run the whole frontend suite; run only the named test files. Typecheck with `cd frontend && npx tsc -b` and judge by errors in the files you touched (pre-existing errors elsewhere are not yours).
- Commit trailers: end every commit message with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01GLPf2MujwmBApyNGaHJVQN`.

## Review Focus

1. A pane saved before slot 28 existed (27 or 28 params, a `null` hole at 27 from JSON): must parse as Extend Left off and Lookback 0. Test in Task 1.
2. An MTF stash line without `i0`: every start reader must fall back to `i1`. Test in Task 1 (`lineStart`).
3. A touching pivot exactly `maxProjBars` back is used; one bar further is not. Test in Task 2.
4. A bar holding both a high and a low pool entry at `i1`: the other extreme at the anchor bar must not become the start. Test in Task 2.
5. Extension that breaks Max Span keeps the line, unextended, rather than dropping it. Test in Task 2 (EURUSD).

---

### Task 1: Slot 28 and the start field (no behaviour change)

**Files:**
- Modify: `frontend/src/lib/indicators/trendlinesOutputs.ts` (TrendlinesConfig ~line 154, TRENDLINES_DEFAULTS ~188, the slot list comment ~220, parseTrendlinesConfig ~296)
- Modify: `frontend/src/lib/indicators/trendlines.ts` (TrendLine ~107-139, isLive ~324, overCeilings ~354, isMajor ~399-406, rankLines ~247-256, compareSurvival ~286-295, sameTrend ~1546, lineExtent jLeft ~2109, clone ~3125)
- Modify: `backend/auto_trader/indicators/trendlines.py` (_DEFAULTS line 66, TrendlinesConfig ~78-135, parse ~229, TrendLine ~138-157, same_trend ~272, rank_key ~503, survival_key ~519, is_live ~640, over_ceilings ~656, is_major ~672)
- Modify: `frontend/src/lib/indicatorParityGolden.test.ts` (TL_CFG ~124: add `extendLeft: 0`)
- Test: `frontend/src/lib/indicators/trendlines.test.ts`, `backend/tests/test_trendlines_indicator.py`

**Interfaces:**
- Produces (TS): `TrendlinesConfig.extendLeft: number`; `TrendLine.i0?: number`; `export function lineStart(line: TrendLine): number`.
- Produces (Python): `TrendlinesConfig.extend_left: int = 0` (placed after `lookback_bars`, before `timeframe`); `TrendLine.i0: int | None = None` (last field); `def line_start(line: TrendLine) -> int`.

- [ ] **Step 1: Write the failing TS tests** (append to `trendlines.test.ts`; import `lineStart` from `./trendlines` and `parseTrendlinesConfig` from `./trendlinesOutputs` if not already imported)

```ts
describe("Extend Left plumbing", () => {
  it("parses slot 28 as 0/1, off when absent", () => {
    expect(parseTrendlinesConfig([]).extendLeft).toBe(0);
    const base = new Array(28).fill(undefined);
    expect(parseTrendlinesConfig([...base, 1]).extendLeft).toBe(1);
    expect(parseTrendlinesConfig([...base, 5]).extendLeft).toBe(1);
    expect(parseTrendlinesConfig([...base, 0]).extendLeft).toBe(0);
    expect(parseTrendlinesConfig([...base, -1]).extendLeft).toBe(0);
  });

  it("reads a JSON hole at slot 27 as Lookback off", () => {
    const saved = JSON.parse(JSON.stringify(Object.assign(new Array(29).fill(0), { 27: undefined, 28: 1 })));
    const cfg = parseTrendlinesConfig(saved);
    expect(cfg.lookbackBars).toBe(0);
    expect(cfg.extendLeft).toBe(1);
  });

  it("lineStart falls back to i1 for a line without i0", () => {
    const l = { ...mixed };
    delete (l as { i0?: number }).i0;
    expect(lineStart(l)).toBe(l.i1);
    expect(lineStart({ ...mixed, i0: mixed.i1 - 3 })).toBe(mixed.i1 - 3);
  });
});
```

(`mixed` is the existing fixture line near the top of `trendlines.test.ts`.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlines.test.ts -t "Extend Left plumbing"`
Expected: FAIL (`lineStart` is not exported / `extendLeft` undefined).

- [ ] **Step 3: Implement TS config and field**

In `trendlinesOutputs.ts`:
- `TrendlinesConfig`: after `lookbackBars: number;` add
  ```ts
  // Start each line at the nearest earlier pool pivot it touches (within Max
  // Projection bars of its first anchor), counting the crossings on the way.
  // Skipped when the extended line would break a ceiling. 0 = off, 1 = on.
  extendLeft: number;
  ```
- `TRENDLINES_DEFAULTS`: after `lookbackBars: 0,` add `extendLeft: 0,`. It must be the LAST key: `indicatorMeta.ts` builds the default calcParams as `Object.values(TRENDLINES_DEFAULTS)`, so key order is slot order.
- Slot list comment (~220): append `extendLeft` after `lookbackBars` in the listed order.
- `parseTrendlinesConfig` return: after `lookbackBars: zeroInt(27, d.lookbackBars),` add `extendLeft: Math.min(1, zeroInt(28, d.extendLeft)),`.

In `trendlines.ts`:
- `TrendLine`: after `maxTouchIdx: number; ...` add
  ```ts
  /** Where the line STARTS when Extend Left moved it back past i1: the bar of
   * the nearest earlier pool pivot it touches. Absent when not extended, and
   * absent on MTF stashes persisted before it existed, so read it only
   * through lineStart. The anchors never move; this is not geometry. */
  i0?: number;
  ```
- Add next to `projectAt`:
  ```ts
  /** The bar a line starts on: i0 when Extend Left moved it back, else i1. */
  export function lineStart(line: TrendLine): number {
    return line.i0 ?? line.i1;
  }
  ```
- Replace the start-meaning uses (leave every other `.i1` alone):
  - `isLive`: `withinLookback(line.i1, i, cfg)` -> `withinLookback(lineStart(line), i, cfg)`
  - `overCeilings`: `line.lastTouchIdx - line.i1 > cfg.maxSpanBars` -> `line.lastTouchIdx - lineStart(line) > cfg.maxSpanBars`
  - `isMajor`:
    ```ts
    const start = lineStart(line);
    const span = line.lastTouchIdx - start;
    if (span < cfg.minSpanBars) return false;
    if (line.crossings < cfg.minCrossings) return false;
    return i >= start && i <= line.lastTouchIdx + cfg.maxProjBars && withinLookback(start, i, cfg);
    ```
  - `rankLines` and `compareSurvival`: `const spanA = a.lastTouchIdx - lineStart(a); const spanB = b.lastTouchIdx - lineStart(b);` (the later `a.i1 !== b.i1` origin tie-break stays on `i1`).
  - `sameTrend`: `const start = Math.max(lineStart(a), lineStart(b));`
  - `lineExtent`: `const s = lineStart(line); const jLeft = mode === "extended" ? s - cfg.maxProjBars : s;` and update its comment to "starts at the line's start (its first anchor, or the earlier touch Extend Left found)".
  - The "To drawing" clone (~3125): `const a = toPoint(xAtLine(lineStart(line)));`

In `indicatorParityGolden.test.ts`: add `extendLeft: 0,` after `lookbackBars: 0,` in `TL_CFG`.

- [ ] **Step 4: Run TS tests and typecheck**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlines.test.ts src/lib/indicators/trendlinesDxy.test.ts src/lib/indicators/trendlinesTsla.test.ts src/lib/indicators/trendlinesEurusd.test.ts src/lib/indicators/trendlinesKbh.test.ts src/lib/indicatorMeta.presets.test.ts`
Expected: PASS (no line has `i0` yet, so nothing moves). Also `grep -rln "TRENDLINES_DEFAULTS\|length).toBe(28)" frontend/src --include=*.test.ts` and run any other test file that pins the default calcParams length.
Run: `cd frontend && npx tsc -b`
Expected: no new errors in the files touched. Any TrendlinesConfig object literal that now misses `extendLeft` shows up here; add `extendLeft: 0` to it.

- [ ] **Step 5: Write the failing Python tests** (append to `backend/tests/test_trendlines_indicator.py`; add `line_start` to the import list)

```python
def test_extend_left_slot_parses_zero_one():
    assert parse_trendlines_config([], {}).extend_left == 0
    base = [None] * 28
    assert parse_trendlines_config(base + [1], {}).extend_left == 1
    assert parse_trendlines_config(base + [5], {}).extend_left == 1
    assert parse_trendlines_config(base + [0], {}).extend_left == 0
    assert parse_trendlines_config(base + [-1], {}).extend_left == 0


def test_line_start_falls_back_to_i1():
    l = _mixed()
    assert l.i0 is None
    assert line_start(l) == l.i1
    l.i0 = l.i1 - 3
    assert line_start(l) == l.i1 - 3
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd backend && uv run pytest -q tests/test_trendlines_indicator.py -k "extend_left or line_start"`
Expected: FAIL (ImportError on `line_start`).

- [ ] **Step 7: Implement Python config and field**

- `_DEFAULTS`: append `, 0` (slot 28) to the tuple.
- `TrendlinesConfig`: after `lookback_bars: int = 0` add
  ```python
  # Start each line at the nearest earlier pool pivot it touches (within
  # max_proj_bars of i1), counting the crossings on the way; skipped when the
  # extended line would break a ceiling. 0 = off, 1 = on (mirrors the TS).
  extend_left: int = 0
  ```
- `parse_trendlines_config`: after `lookback_bars=zero_int(27, d[27]),` add `extend_left=min(1, zero_int(28, d[28])),`.
- `TrendLine`: after `touch_idxs: ...` add `i0: int | None = None  # start when Extend Left moved it back; read via line_start`.
- Add after `project_at`:
  ```python
  def line_start(line: TrendLine) -> int:
      """Mirrors TS lineStart: i0 when Extend Left moved the start back, else i1."""
      return line.i1 if line.i0 is None else line.i0
  ```
- Start-meaning uses:
  - `same_trend`: `start = max(line_start(a), line_start(b))`
  - `rank_key` and `survival_key`: `-(line.last_touch_idx - line_start(line))` (the `line.i1` origin element stays).
  - `is_live`: `within_lookback(line_start(line), i, cfg)`
  - `over_ceilings`: `line.last_touch_idx - line_start(line) > cfg.max_span_bars`
  - `is_major`:
    ```python
    start = line_start(line)
    if line.last_touch_idx - start < cfg.min_span_bars:
        return False
    if line.crossings < cfg.min_crossings:
        return False
    return (
        i >= start
        and i <= line.last_touch_idx + cfg.max_proj_bars
        and within_lookback(start, i, cfg)
    )
    ```

- [ ] **Step 8: Run Python tests and parity**

Run: `cd backend && uv run pytest -q tests/test_trendlines_indicator.py tests/test_indicator_parity.py`
Expected: PASS, golden unchanged.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/lib/indicators/trendlinesOutputs.ts frontend/src/lib/indicators/trendlines.ts frontend/src/lib/indicators/trendlines.test.ts frontend/src/lib/indicatorParityGolden.test.ts backend/auto_trader/indicators/trendlines.py backend/tests/test_trendlines_indicator.py
git commit -m "feat(trendlines): Extend Left slot 28 and the line start field

No behaviour change: i0 is never set yet, lineStart reads i1.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GLPf2MujwmBApyNGaHJVQN"
```

---

### Task 2: The extension in TS, with the EURUSD daily acceptance

**Files:**
- Modify: `frontend/src/lib/indicators/trendlines.ts` (new helpers near `touchGaps`; seed loop tail ~851-858)
- Create: `frontend/src/lib/indicators/trendlinesEurusdDaily.fixture.json`
- Create: `frontend/src/lib/indicators/trendlinesEurusdDaily.test.ts`
- Test: `frontend/src/lib/indicators/trendlines.test.ts`

**Interfaces:**
- Consumes: `lineStart`, `TrendLine.i0`, `cfg.extendLeft` (Task 1); existing `touchWeight`, `stepCrossing`, `touchGaps`, `overCeilings`, `withinLookback` (make `withinLookback` exported if the helper lives in a way that needs it; it is module-local today, which is fine for a helper in the same file).
- Produces:
  ```ts
  export interface LeftStart { idx: number; kind: PivotKind; w: number }
  export function findLeftStart(
    cand: TrendLine, q: number, poolIdxs: readonly number[], poolKinds: readonly PivotKind[],
    highs: readonly number[], lows: readonly number[], atr: readonly (number | null)[],
    i: number, cfg: TrendlinesConfig,
  ): LeftStart | null;
  export function extendedCopy(cand: TrendLine, s: LeftStart, closes: readonly number[], i: number): TrendLine;
  ```

- [ ] **Step 1: Write the failing unit tests** (append to `trendlines.test.ts`; import `findLeftStart`, `extendedCopy`, `lineStart`)

```ts
describe("Extend Left: findLeftStart / extendedCopy", () => {
  // Rising line: value at bar j is 100 + (j - 10). ATR 1 everywhere, pierce
  // 0.25, no gap band, so only an extreme ON (or just through) the line counts.
  const line: TrendLine = {
    i1: 10, p1: 100, k1: "low", i2: 20, p2: 110, k2: "low",
    touches: 2, touchIdxs: [10, 20], touchKinds: ["low", "low"], lastTouchIdx: 20,
    crossings: 0, crossIdxs: [], lastSign: 0, maxTouchGap: 10, minTouchGap: 10, maxTouchIdx: 20,
  };
  const n = 30;
  const atr = new Array<number | null>(n).fill(1);
  const flatHighs = new Array<number>(n).fill(200);
  const flatLows = new Array<number>(n).fill(0);
  const c = (over: Partial<TrendlinesConfig> = {}): TrendlinesConfig =>
    ({ ...TRENDLINES_DEFAULTS, touchMult: 0, pierceMult: 0.25, maxProjBars: 100, extendLeft: 1, ...over });

  it("returns the nearest touching pool pivot", () => {
    const lows = [...flatLows]; lows[2] = 92; lows[5] = 95; // both ON the line
    const idxs = [2, 5, 10, 20]; const kinds: PivotKind[] = ["low", "low", "low", "low"];
    expect(findLeftStart(line, 2, idxs, kinds, flatHighs, lows, atr, 25, c())).toEqual({ idx: 5, kind: "low", w: 1 });
  });

  it("skips non-touching pivots and returns null when none touch", () => {
    const idxs = [2, 5, 10, 20]; const kinds: PivotKind[] = ["low", "low", "low", "low"];
    expect(findLeftStart(line, 2, idxs, kinds, flatHighs, flatLows, atr, 25, c())).toBeNull();
  });

  it("reaches exactly maxProjBars back and no further", () => {
    const lows = [...flatLows]; lows[4] = 94;
    const idxs = [4, 10, 20]; const kinds: PivotKind[] = ["low", "low", "low"];
    expect(findLeftStart(line, 1, idxs, kinds, flatHighs, lows, atr, 25, c({ maxProjBars: 6 }))?.idx).toBe(4);
    expect(findLeftStart(line, 1, idxs, kinds, flatHighs, lows, atr, 25, c({ maxProjBars: 5 }))).toBeNull();
  });

  it("stops at the Lookback edge", () => {
    const lows = [...flatLows]; lows[4] = 94;
    const idxs = [4, 10, 20]; const kinds: PivotKind[] = ["low", "low", "low"];
    expect(findLeftStart(line, 1, idxs, kinds, flatHighs, lows, atr, 25, c({ lookbackBars: 20 }))).toBeNull();
  });

  it("never uses the other extreme of the anchor bar", () => {
    const highs = [...flatHighs]; highs[10] = 100; // the anchor bar's high sits ON the line
    const idxs = [10, 10, 20]; const kinds: PivotKind[] = ["high", "low", "low"];
    expect(findLeftStart(line, 1, idxs, kinds, highs, flatLows, atr, 25, c())).toBeNull();
  });

  it("extendedCopy sets i0, adds the touch and recounts crossings from i0", () => {
    // Closes: under the line from 5 to 7, above from 8 on: one crossing (at 8).
    const closes = Array.from({ length: n }, (_, j) => (j >= 5 && j <= 7 ? 100 + (j - 10) - 1 : 100 + (j - 10) + 1));
    const cand = { ...line, touchIdxs: [...line.touchIdxs], touchKinds: [...line.touchKinds] };
    const ext = extendedCopy(cand, { idx: 5, kind: "low", w: 1 }, closes, 25);
    expect(lineStart(ext)).toBe(5);
    expect(ext.touches).toBe(3);
    expect(ext.touchIdxs).toEqual([10, 20, 5]);
    expect(ext.touchKinds).toEqual(["low", "low", "low"]);
    expect(ext.crossings).toBe(1);
    expect(ext.crossIdxs).toEqual([8]);
    expect(ext.minTouchGap).toBe(5);
    expect(ext.maxTouchGap).toBe(10);
    expect(cand.i0).toBeUndefined(); // a copy, the candidate is untouched
    expect(cand.touchIdxs).toEqual([10, 20]);
  });
});
```

(Import `TRENDLINES_DEFAULTS` from `./trendlinesOutputs` and `PivotKind` / `TrendlinesConfig` types if the file does not already.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlines.test.ts -t "findLeftStart"`
Expected: FAIL (not exported).

- [ ] **Step 3: Implement the helpers** (in `trendlines.ts`, after `touchGaps`)

```ts
/** Extend Left's start pivot: the NEAREST pool pivot before the line's first
 * anchor that the touch model counts. Newest first from pool position q - 1
 * (q is the anchor's own position), skipping an entry AT i1 (the other extreme
 * of the anchor bar), stopping once an entry is more than maxProjBars before
 * i1 (the reach a line has to the right of its last touch) or past Lookback.
 * Mirrored by Python find_left_start. */
export interface LeftStart { idx: number; kind: PivotKind; w: number }

export function findLeftStart(
  cand: TrendLine,
  q: number,
  poolIdxs: readonly number[],
  poolKinds: readonly PivotKind[],
  highs: readonly number[],
  lows: readonly number[],
  atr: readonly (number | null)[],
  i: number,
  cfg: TrendlinesConfig,
): LeftStart | null {
  for (let q0 = q - 1; q0 >= 0; q0--) {
    const pj = poolIdxs[q0];
    if (pj === cand.i1) continue;
    if (cand.i1 - pj > cfg.maxProjBars) break;
    if (!withinLookback(pj, i, cfg)) break;
    const tolP = atr[pj];
    if (tolP === null) continue;
    const kj = poolKinds[q0];
    const pv = kj === "high" ? highs[pj] : lows[pj];
    const w = touchWeight(cand, pj, pv, kj, cfg.touchMult * tolP, cfg.pierceMult * tolP);
    if (w > 0) return { idx: pj, kind: kj, w };
  }
  return null;
}

/** The candidate started at `s`: the start pivot added as a touch, the gaps
 * recomputed, and the crossings recounted over (s.idx, i] so breaks between
 * the start and the old anchor count. A copy; the candidate is untouched.
 * Mirrored by Python extended_copy. */
export function extendedCopy(
  cand: TrendLine,
  s: LeftStart,
  closes: readonly number[],
  i: number,
): TrendLine {
  const ext: TrendLine = {
    ...cand,
    i0: s.idx,
    touches: cand.touches + s.w,
    touchIdxs: [...cand.touchIdxs, s.idx],
    touchKinds: [...cand.touchKinds, s.kind],
    crossings: 0,
    crossIdxs: [],
    lastSign: 0,
  };
  for (let j = s.idx + 1; j <= i; j++) stepCrossing(ext, j, closes[j]);
  const gaps = touchGaps(ext.touchIdxs);
  ext.maxTouchGap = gaps.widest;
  ext.minTouchGap = gaps.narrowest;
  return ext;
}
```

- [ ] **Step 4: Wire it into the seed loop** (replace the tail that ends in `lines.push(cand);`)

```ts
        cand.maxTouchIdx = cand.i2;
        // Extend Left (spec 2026-09-24): start at the nearest earlier pivot
        // the line touches, crossings recounted from there; kept unextended
        // when that breaks a ceiling, so the option never removes a line.
        let seeded = cand;
        if (cfg.extendLeft > 0) {
          const s = findLeftStart(cand, q, pool.idxs, pool.kinds, highs, lows, atr, i, cfg);
          if (s !== null) {
            const ext = extendedCopy(cand, s, closes, i);
            if (!overCeilings(ext, cfg)) seeded = ext;
          }
        }
        lines.push(seeded);
        st.pairs++;
```

(`q`, `pool`, `highs`, `lows`, `atr`, `closes`, `i` are the names already in scope in that loop; read the loop to confirm before editing.)

- [ ] **Step 5: Run the unit tests**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlines.test.ts`
Expected: PASS.

- [ ] **Step 6: Create the EURUSD daily fixture** (needs the backend on :8000)

```bash
cd /Users/mahmoudparham/projects/auto_trader && python3 - <<'EOF'
import json, urllib.request
FROM, TO = 1662336000, 1790121600  # 2022-09-05 .. 2026-09-23 (closed bars only)
rows, end = {}, TO
while end > FROM:
    frm = max(FROM, end - 86400 * 900)
    u = ("http://localhost:8000/api/candles?epic=EURUSD&resolution=DAY&bars=1000"
         f"&broker=capital-live&from_ts={frm}&to_ts={end}")
    got = json.load(urllib.request.urlopen(u))
    got = got if isinstance(got, list) else got["candles"]
    for b in got:
        if FROM <= b["time"] <= TO:
            rows[b["time"]] = b
    end = frm - 1
out = [{"timestamp": t * 1000, "open": b["open"], "high": b["high"], "low": b["low"],
        "close": b["close"], "volume": b.get("volume") or 0.0} for t, b in sorted(rows.items())]
json.dump(out, open("frontend/src/lib/indicators/trendlinesEurusdDaily.fixture.json", "w"), separators=(",", ":"))
print(len(out), out[0]["timestamp"], out[-1]["timestamp"])
EOF
```

Expected: about 1260 bars, first 1662336000000, last 1790035200000 (2026-09-23). If the last bar is later, the API ignored `to_ts`; trim the file to `timestamp <= 1790035200000`.

- [ ] **Step 7: Write the acceptance test** (`trendlinesEurusdDaily.test.ts`)

```ts
// ACCEPTANCE for Extend Left (spec 2026-09-24): the owner's EURUSD daily
// drawing starts at the 2024-11-29 high. The Trendlines(1D) pane builds the
// same line from the 2025-03-26 low to the 2026-07-28 low; with Extend Left
// on it must start at the 2024-12-06 high, the nearest earlier swing it
// touches (94 bars back, pierced by 0.45 ATR), with the 2025-03-04 break
// counted as a crossing. Old resistance turned support.
import { describe, expect, it } from "vitest";
import type { KLineData } from "klinecharts";
import { computeTrendlines, lineStart, projectAt, type TrendLine } from "./trendlines";
import { parseTrendlinesConfig } from "./trendlinesOutputs";
import fixture from "./trendlinesEurusdDaily.fixture.json";

const bars = fixture as unknown as KLineData[];
const day = (i: number): string => new Date(bars[i].timestamp).toISOString().slice(0, 10);
// The owner's Trendlines(1D) pane on 2026-09-24, slots 0..26; 27 Lookback off.
const PANE = [8, 0, 2, 20, 100, 50, 2, 0, 40, 0, 0, 0.3, -0.3, 0, 0, 0, 2, 0.5, 0, 0, 1, 1, 3, 0, 12, 10, 3, 0];
const cfgWith = (extendLeft: number, patch: Record<number, number> = {}) => {
  const p = [...PANE, extendLeft];
  for (const [k, v] of Object.entries(patch)) p[Number(k)] = v;
  return parseTrendlinesConfig(p);
};
const find = (lines: TrendLine[]): TrendLine | undefined =>
  lines.find((l) => day(l.i1) === "2025-03-26" && day(l.i2) === "2026-07-28");

describe("TRENDLINES Extend Left on EURUSD daily", () => {
  it("holds the fixture it expects", () => {
    expect(day(0)).toBe("2022-09-05");
    expect(day(bars.length - 1)).toBe("2026-09-23");
  });

  it("off: the line starts at its first anchor", () => {
    const l = find(computeTrendlines(bars, cfgWith(0)).lines);
    expect(l).toBeDefined();
    expect(lineStart(l!)).toBe(l!.i1);
  });

  it("on: the line starts at the 2024-12-06 high, one more touch, the break counted", () => {
    const off = find(computeTrendlines(bars, cfgWith(0)).lines)!;
    const on = find(computeTrendlines(bars, cfgWith(1)).lines);
    expect(on).toBeDefined();
    expect(day(lineStart(on!))).toBe("2024-12-06");
    expect(on!.touches).toBe(off.touches + 1);
    expect(on!.crossings).toBe(off.crossings + 1);
    const last = bars.length - 1;
    expect(projectAt(on!, last)).toBe(projectAt(off, last));
  });

  it("respects Max Span: an extension that breaks it keeps the line unextended", () => {
    const off = find(computeTrendlines(bars, cfgWith(0)).lines)!;
    const span = off.lastTouchIdx - off.i1;
    // Slot 10 is Max Span: one bar more than the unextended span allows the
    // line but not its 94-bar extension.
    const on = find(computeTrendlines(bars, cfgWith(1, { 10: span + 1 })).lines);
    expect(on).toBeDefined();
    expect(lineStart(on!)).toBe(on!.i1);
  });
});
```

If an assertion's measured value differs (a date, a count), do NOT edit the expectation to match: report the measured numbers in your report and stop; the controller rules on it.

- [ ] **Step 8: Run the acceptance and the existing trendline fixtures**

Run: `cd frontend && npx vitest run src/lib/indicators/trendlinesEurusdDaily.test.ts src/lib/indicators/trendlines.test.ts src/lib/indicators/trendlinesDxy.test.ts src/lib/indicators/trendlinesTsla.test.ts src/lib/indicators/trendlinesEurusd.test.ts src/lib/indicators/trendlinesKbh.test.ts`
Expected: PASS. Then `cd frontend && npx tsc -b`: no new errors in touched files.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/lib/indicators/trendlines.ts frontend/src/lib/indicators/trendlines.test.ts frontend/src/lib/indicators/trendlinesEurusdDaily.test.ts frontend/src/lib/indicators/trendlinesEurusdDaily.fixture.json
git commit -m "feat(trendlines): Extend Left starts a line at the nearest earlier touch

Off by default (slot 28). Crossings are recounted from the new start; an
extension that breaks a ceiling keeps the line unextended. EURUSD daily
acceptance: the 2025-03-26 to 2026-07-28 line starts at 2024-12-06.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GLPf2MujwmBApyNGaHJVQN"
```

---

### Task 3: Python port and the parity golden

**Files:**
- Modify: `backend/auto_trader/indicators/trendlines.py` (helpers after `touch_gaps`; seed tail ~814-816)
- Modify: `frontend/src/lib/indicatorParityGolden.test.ts` (TL_VARIANTS)
- Modify: `backend/tests/test_indicator_parity.py` (`_TL_VARIANTS`)
- Regenerate: `backend/tests/fixtures/indicator_golden.json`
- Test: `backend/tests/test_trendlines_indicator.py`

**Interfaces:**
- Consumes: `line_start`, `TrendLine.i0`, `cfg.extend_left` (Task 1); the TS behaviour of Task 2.
- Produces:
  ```python
  def find_left_start(cand: TrendLine, q: int, pool_idxs: Sequence[int], pool_kinds: Sequence[str],
                      highs: Sequence[float], lows: Sequence[float], atr: Sequence[float | None],
                      i: int, cfg: TrendlinesConfig) -> tuple[int, str, float] | None
  def extended_copy(cand: TrendLine, start: tuple[int, str, float], closes: Sequence[float], i: int) -> TrendLine
  ```

- [ ] **Step 1: Write the failing Python tests** (append; import `find_left_start`, `extended_copy`, `line_start`, and `dataclasses.replace` is already imported as `replace`)

```python
def _rising() -> TrendLine:
    # Value at bar j is 100 + (j - 10).
    return TrendLine(i1=10, p1=100.0, k1="low", i2=20, p2=110.0, k2="low", touches=2.0,
                     last_touch_idx=20, crossings=0, last_sign=0, max_touch_gap=10,
                     min_touch_gap=10, max_touch_idx=20, touch_idxs=[10, 20])


def _el_cfg(**over):
    base = replace(parse_trendlines_config([], {}), touch_mult=0.0, pierce_mult=0.25,
                   max_proj_bars=100, extend_left=1)
    return replace(base, **over)


_N = 30
_ATR = [1.0] * _N
_HI = [200.0] * _N
_LO = [0.0] * _N


def test_find_left_start_nearest():
    lows = list(_LO); lows[2] = 92.0; lows[5] = 95.0
    got = find_left_start(_rising(), 2, [2, 5, 10, 20], ["low"] * 4, _HI, lows, _ATR, 25, _el_cfg())
    assert got == (5, "low", 1.0)


def test_find_left_start_none_touch():
    assert find_left_start(_rising(), 2, [2, 5, 10, 20], ["low"] * 4, _HI, _LO, _ATR, 25, _el_cfg()) is None


def test_find_left_start_reach_and_lookback():
    lows = list(_LO); lows[4] = 94.0
    args = (_rising(), 1, [4, 10, 20], ["low"] * 3, _HI, lows, _ATR, 25)
    assert find_left_start(*args, _el_cfg(max_proj_bars=6))[0] == 4
    assert find_left_start(*args, _el_cfg(max_proj_bars=5)) is None
    assert find_left_start(*args, _el_cfg(lookback_bars=20)) is None


def test_find_left_start_skips_anchor_bar():
    highs = list(_HI); highs[10] = 100.0
    assert find_left_start(_rising(), 1, [10, 10, 20], ["high", "low", "low"], highs, _LO, _ATR, 25, _el_cfg()) is None


def test_extended_copy():
    closes = [100.0 + (j - 10) - 1 if 5 <= j <= 7 else 100.0 + (j - 10) + 1 for j in range(_N)]
    cand = _rising()
    ext = extended_copy(cand, (5, "low", 1.0), closes, 25)
    assert line_start(ext) == 5
    assert ext.touches == 3.0
    assert ext.touch_idxs == [10, 20, 5]
    assert ext.crossings == 1
    assert (ext.max_touch_gap, ext.min_touch_gap) == (10, 5)
    assert cand.i0 is None and cand.touch_idxs == [10, 20]
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && uv run pytest -q tests/test_trendlines_indicator.py -k "left_start or extended_copy"`
Expected: FAIL (ImportError).

- [ ] **Step 3: Implement the Python helpers** (after `touch_gaps`)

```python
def find_left_start(
    cand: TrendLine,
    q: int,
    pool_idxs: Sequence[int],
    pool_kinds: Sequence[str],
    highs: Sequence[float],
    lows: Sequence[float],
    atr: Sequence[float | None],
    i: int,
    cfg: TrendlinesConfig,
) -> tuple[int, str, float] | None:
    """Mirrors TS findLeftStart: the NEAREST pool pivot before i1 the touch
    model counts, skipping an entry at i1, no further back than max_proj_bars
    before i1 and never past Lookback. (idx, kind, weight) or None."""
    for q0 in range(q - 1, -1, -1):
        pj = pool_idxs[q0]
        if pj == cand.i1:
            continue
        if cand.i1 - pj > cfg.max_proj_bars:
            break
        if not within_lookback(pj, i, cfg):
            break
        tol_p = atr[pj]
        if tol_p is None:
            continue
        kj = pool_kinds[q0]
        pv = highs[pj] if kj == "high" else lows[pj]
        w = touch_weight(cand, pj, pv, kj, cfg.touch_mult * tol_p, cfg.pierce_mult * tol_p)
        if w > 0:
            return pj, kj, w
    return None


def extended_copy(
    cand: TrendLine, start: tuple[int, str, float], closes: Sequence[float], i: int
) -> TrendLine:
    """Mirrors TS extendedCopy: i0 set, the start pivot added as a touch, gaps
    recomputed, crossings recounted over (i0, i]. A copy."""
    idx, _kind, w = start
    ext = replace(
        cand,
        i0=idx,
        touches=cand.touches + w,
        touch_idxs=[*cand.touch_idxs, idx],
        crossings=0,
        last_sign=0,
    )
    step_crossings(ext, idx + 1, i, closes)
    ext.max_touch_gap, ext.min_touch_gap = touch_gaps(ext.touch_idxs)
    return ext
```

Add `from dataclasses import dataclass, field, replace` (extend the existing import). `within_lookback` and `touch_gaps` are defined later in the module than `touch_weight`; place these two helpers AFTER `touch_gaps` so every name exists at call time (Python resolves at call time anyway, but keep reading order sane).

- [ ] **Step 4: Wire the seed tail**

```python
                    cand.max_touch_gap, cand.min_touch_gap = touch_gaps(cand.touch_idxs)
                    cand.max_touch_idx = cand.i2
                    # Extend Left (mirrors TS): nearest earlier touch, crossings
                    # recounted from it; kept unextended if a ceiling breaks.
                    seeded = cand
                    if cfg.extend_left > 0:
                        s = find_left_start(
                            cand, q, pool_idxs, pool_kinds, highs, lows, atr, i, cfg
                        )
                        if s is not None:
                            ext = extended_copy(cand, s, closes, i)
                            if not over_ceilings(ext, cfg):
                                seeded = ext
                    lines.append(seeded)
```

- [ ] **Step 5: Run Python unit tests**

Run: `cd backend && uv run pytest -q tests/test_trendlines_indicator.py`
Expected: PASS.

- [ ] **Step 6: Add golden variants**

In `indicatorParityGolden.test.ts` `TL_VARIANTS`, after `LOOKBACK`:
```ts
      // Extend Left: extended lines gain a touch and a longer span, so a
      // touches floor of 3 lets more of them emit; the Max Crossings pairing
      // exercises the ceiling fallback to the unextended line.
      EXTEND: { extendLeft: 1, minTouches: 3 },
      EXTEND_CROSS: { extendLeft: 1, maxCrossings: 1 },
```
In `backend/tests/test_indicator_parity.py` `_TL_VARIANTS`, after `"LOOKBACK"`:
```python
    "EXTEND": dict(extend_left=1, min_touches=3),
    "EXTEND_CROSS": dict(extend_left=1, max_crossings=1),
```
The golden test asserts each variant moves the output against the base; if `EXTEND` does not move it on this 500-bar walk, try `{ extendLeft: 1, minTouches: 3, minSpanBars: 30 }` and mirror the same change in Python. Additionally assert, in the TS golden test next to the variant loop, that `EXTEND_CROSS` differs from `CROSS_MAX`:
```ts
    expect(JSON.stringify(computeTrendlines(candles, { ...TL_CFG, extendLeft: 1, maxCrossings: 1 }).points))
      .not.toBe(JSON.stringify(computeTrendlines(candles, { ...TL_CFG, maxCrossings: 1 }).points));
```
If that fails (the extension changed nothing under Max Crossings 1 on this walk), drop the assertion and say so in your report; do not weaken anything else.

- [ ] **Step 7: Regenerate the golden and check parity**

Run: `cd frontend && npx vitest run src/lib/indicatorParityGolden.test.ts`
Then: `git diff --stat backend/tests/fixtures/indicator_golden.json` (only new `TL_EXTEND*` keys should appear; existing series byte-identical: check with `git diff backend/tests/fixtures/indicator_golden.json | grep '^-' | grep -v '^---' | head` printing nothing but possibly a moved closing brace line).
Run: `cd backend && uv run pytest -q tests/test_indicator_parity.py tests/test_trendlines_indicator.py`
Expected: PASS, bit for bit.

- [ ] **Step 8: Commit**

```bash
git add backend/auto_trader/indicators/trendlines.py backend/tests/test_trendlines_indicator.py backend/tests/test_indicator_parity.py frontend/src/lib/indicatorParityGolden.test.ts backend/tests/fixtures/indicator_golden.json
git commit -m "feat(trendlines): Extend Left in the Python port, parity golden variants

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GLPf2MujwmBApyNGaHJVQN"
```

---

### Task 4: Settings toggle

**Files:**
- Modify: `frontend/src/lib/indicatorMeta.ts` (TRENDLINES inputs, right after the Lookback entry ~949-958)
- Test: `frontend/src/lib/indicatorMeta.presets.test.ts` (append a describe block)

**Interfaces:**
- Consumes: slot 28 (Task 1). The settings modal already renders a `type: "boolean", source: "calcParam"` input as a checkbox writing 0/1 (`IndicatorSettings.tsx` ~872).

- [ ] **Step 1: Write the failing test**

```ts
// add resolveInputs to the existing import from "./indicatorMeta"
describe("Extend Left input", () => {
it("TRENDLINES has an Extend Left toggle on slot 28", () => {
  const inp = resolveInputs("TRENDLINES", undefined).find((x) => x.index === 28);
  expect(inp).toMatchObject({ label: "Extend Left", type: "boolean", source: "calcParam", default: false });
  expect(inp?.tip).toEqual([
    "Starts each line at the nearest earlier swing it touched.",
    "The line keeps its angle; that swing counts as a touch.",
    "Breaks on the way count as crossings.",
    "Skipped when it would break a filter, like Max Crossings.",
  ]);
});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/lib/indicatorMeta.presets.test.ts`
Expected: FAIL (`inp` undefined).

- [ ] **Step 3: Add the input** right after the Lookback entry:

```ts
      {
        key: "p28",
        label: "Extend Left",
        type: "boolean",
        source: "calcParam",
        index: 28,
        default: false,
        tip: [
          "Starts each line at the nearest earlier swing it touched.",
          "The line keeps its angle; that swing counts as a touch.",
          "Breaks on the way count as crossings.",
          "Skipped when it would break a filter, like Max Crossings.",
        ],
      },
```

- [ ] **Step 4: Run the test and typecheck**

Run `cd frontend && npx vitest run src/lib/indicatorMeta.presets.test.ts`: PASS (the existing preset tests too: `TL_DEFAULT_PARAMS` is `Object.values(TRENDLINES_DEFAULTS)`, so the Task 1 default grew the base to 29 slots). `cd frontend && npx tsc -b`: no new errors in touched files.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicatorMeta.ts frontend/src/lib/indicatorMeta.presets.test.ts
git commit -m "feat(trendlines): Extend Left toggle in the settings

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GLPf2MujwmBApyNGaHJVQN"
```

---

### Task 5: Benchmark and live check (controller)

- [ ] **Step 1: Benchmark** with a temporary `frontend/src/__bench_tl.test.ts` (deleted after, never committed): `computeTrendlines` on the TSLA and KBH fixtures at defaults, Extend Left 0 and 1, 5 runs each after a warm-up, printed with `--silent=false --reporter=verbose`. Expected with Extend Left 1: TSLA <= 50 ms, KBH <= 250 ms. Python: time `compute_trendlines` on the same two fixtures, 0 vs 1, and report.
- [ ] **Step 2: Live check** through the chartkar bridge on the EURUSD tab (1D): set the Trendlines(1D) pane (`TRENDLINES3`) slot 28 to 1 with `indicator.set` (the owner asked for this line), then read the line's start through the page (`window.__chart` data list and the pane's drawn lines, or `chart.state`). Expect the line from the 2025-03-26 low to start at 2024-12-06. The pane is hidden right now; do not toggle its visibility, report that instead. No screenshot.
- [ ] **Step 3: Report** numbers to the owner. No commit.
