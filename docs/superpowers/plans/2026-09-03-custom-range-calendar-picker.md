# Custom Range Calendar Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A calendar popover on the backtest "Time range" row: drag a date span on a month grid, click off weekends/holidays, and drag a daily time window — all writing the existing `RangeConfig`/`RecurrenceMask` model, plus one new mask field (`excludeDates`) carried front and back.

**Architecture:** The `RecurrenceMask` pipeline already runs end-to-end (front `isActive` mirrors backend `is_active`; `computePeriodBands` walks `isActive`, so chart shading follows for free). We add `excludeDates` as one more AND-ed membership test in both mirrors and the DTO, then build a self-contained `RangeCalendarPopover` component (month grid + 24h time strip) that the settings modal opens from a calendar-glyph button on the always-visible From/To row; every write goes through the modal's existing `setRange`/`setMask` helpers. The popover is portaled with fixed positioning (the modal body scrolls), following `SessionFillMenu`'s in-file precedent.

**Tech Stack:** React 18 + TypeScript (vitest; jsdom for component tests), FastAPI/pydantic backend (pytest).

**Spec:** `docs/superpowers/specs/2026-07-06-custom-range-calendar-picker-design.md`

## Rulings (spec-vs-code deltas, decided at plan time)

1. **`rangeDateLabel` does not exist** (spec line ~145 assumed it). The From/To fields always resolve to a rolling window (`pickerFromMs/pickerToMs`). No "Pick a from and to date" prompt to preserve — drop that requirement.
2. **No "read-only strip under a session preset"** (spec §time-strip). `SessionFillMenu` is a one-shot fill: `mask.session` is never persisted and nothing is disabled by a preset. Ruling: the strip is always editable (except the daily-TF guard); the preset just fills values, as everywhere else in the modal.
3. **No "Custom row"** — `RANGE_MODES` has no Custom entry; `"custom"` mode is a side effect of editing From/To. The calendar-glyph button lives on the always-visible `.bt-range-row`, next to the existing "Pick range on chart" button.
4. **Timezone**: the spec says "render in the mask tz". In this codebase the mask is ALWAYS read in `chartTimezone` (`withChartTz` overwrites `mask.tz` before every run; `maskPreview` overrides it too). Ruling: the calendar renders days, writes day-boundary `fromMs/toMs`, and formats `excludeDates` strings in **`chartTimezone`**. (The native From/To inputs stay browser-local — a pre-existing mismatch the calendar does not try to fix.)
5. **DST**: day boundaries and date strings computed via per-date `Intl` parts (the `en-CA` formatter + `tzOffsetMs` pattern already in `backtestSchedule.ts`) — never a cached single offset.
6. **Span gesture is two-click only** (the spec offered press-drag AND click-then-click; the chart "Pick range" precedent is two-click). Press-drag rectangle selection is deferred — it adds pointer-capture complexity for no new capability. Cost if wrong: a user who tries to drag gets the first click's arm state; the second click still completes the span.

## Global Constraints

- `excludeDates?: string[]` — `"YYYY-MM-DD"` in the mask's tz; absent/empty = none excluded. Backend field `exclude_dates: frozenset[str] = frozenset()` (the dataclass is `frozen=True`). DTO `excludeDates: list[str] = []`. A bar is inactive iff its tz-local date string is in the set — one membership test AND-ed with the existing filters, in BOTH mirrors (front `isActive`, back `is_active`), which must not diverge.
- The frontend date-string formatter must go through `cachedFormat` (`backtestSchedule.ts`) — `computePeriodBands` funnels every bar through `isActive`, and per-call formatter construction is the documented perf trap.
- All popover writes go through the modal's `setRange`/`setMask`; no new from/to source. The chart "Pick range" drag keeps working unchanged.
- Selecting a span: `fromMs` = first day 00:00, `toMs` = last day 24:00 (exclusive end) in `chartTimezone`; sets `mode: "custom"`; auto-enables the mask and seeds `daysOfWeek: [1,2,3,4,5]` ONLY if the user has no weekday selection yet.
- Weekday-column-header click toggles the recurring weekday (`daysOfWeek`); date-cell click toggles that specific date (`excludeDates`). A "Weekends" toggle restores Sat+Sun.
- Time strip: drag writes `timeOfDay` (`{startMin,endMin}`, overnight wrap allowed); disabled when `resSeconds >= 86400`; calendar + excludeDates stay active at daily+.
- Popover: portaled `.dropdown.bt-calendar-pop` with `position: fixed` and `z-index: 2100` (the compound-selector rule — a bare class loses to `.dropdown`'s own z-index and renders behind the modal); dismiss on outside-pointerdown (capture) + Escape + window resize/scroll(capture), matching `SessionFillMenu`.
- Baseline to keep green: `cd frontend && npm run test:unit` (3880 tests), `npx tsc -b` (88 pre-existing errors — add none), `cd backend && .venv/bin/pytest` (or `uv run pytest`) green.
- Commit after each task. Frontend paths relative to `frontend/`, backend to `backend/`, unless noted.

---

### Task 1: Backend `exclude_dates`

**Files:**
- Modify: `backend/auto_trader/engine/schedule.py` (dataclass + `is_active`)
- Modify: `backend/auto_trader/api/schemas.py` (`RecurrenceMaskDTO` + `to_mask()`)
- Test: `backend/tests/test_schedule.py` (append), Create: `backend/tests/test_mask_dto.py`

**Interfaces:**
- Produces: `RecurrenceMask.exclude_dates: frozenset[str]`; `RecurrenceMaskDTO.excludeDates: list[str] = []`. Task 2's frontend mirror must match the semantics exactly (date string of the bar's tz-local calendar day).

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_schedule.py` (its `_utc` helper exists at the top):

```python
def test_exclude_dates_blocks_matching_local_date():
    # 2024-01-01 23:00 UTC is 2024-01-02 08:00 in Tokyo — the TOKYO date matters.
    m = RecurrenceMask(enabled=True, tz="Asia/Tokyo", exclude_dates=frozenset({"2024-01-02"}))
    assert is_active(m, _utc(2024, 1, 1, 23, 0)) is False
    assert is_active(m, _utc(2024, 1, 1, 10, 0)) is True  # still 2024-01-01 in Tokyo


def test_exclude_dates_ands_with_other_filters():
    m = RecurrenceMask(
        enabled=True, tz="UTC",
        days_of_week=(1, 2, 3, 4, 5),
        exclude_dates=frozenset({"2024-01-03"}),  # a Wednesday
    )
    assert is_active(m, _utc(2024, 1, 3, 12, 0)) is False  # weekday but excluded
    assert is_active(m, _utc(2024, 1, 4, 12, 0)) is True   # Thursday, not excluded
    assert is_active(m, _utc(2024, 1, 6, 12, 0)) is False  # Saturday (weekday filter)


def test_exclude_dates_default_empty_changes_nothing():
    m = RecurrenceMask(enabled=True, tz="UTC")
    assert m.exclude_dates == frozenset()
    assert is_active(m, _utc(2024, 1, 3, 12, 0)) is True
```

Create `backend/tests/test_mask_dto.py`:

```python
from auto_trader.api.schemas import RecurrenceMaskDTO


def test_exclude_dates_round_trips_through_to_mask():
    dto = RecurrenceMaskDTO(enabled=True, excludeDates=["2024-01-02", "2024-12-25"])
    mask = dto.to_mask()
    assert mask.exclude_dates == frozenset({"2024-01-02", "2024-12-25"})


def test_exclude_dates_defaults_empty():
    assert RecurrenceMaskDTO(enabled=True).to_mask().exclude_dates == frozenset()
```

- [ ] **Step 2: Run to verify FAIL** — `cd backend && .venv/bin/pytest tests/test_schedule.py tests/test_mask_dto.py -q` (fall back to `uv run pytest ...` if `.venv/bin/pytest` is missing). Expected: TypeError (unknown field) / attribute errors.

- [ ] **Step 3: Implement**

`schedule.py` — add to the dataclass after `days_of_month`:

```python
    # Specific tz-local calendar dates ("YYYY-MM-DD") that never trade —
    # manual holiday click-off from the range calendar. Empty = none excluded.
    exclude_dates: frozenset[str] = frozenset()
```

In `is_active`, after the `days_of_month` check (order matters only for symmetry with the frontend mirror — keep it after `days_of_month`, before the time window):

```python
    if mask.exclude_dates and local.strftime("%Y-%m-%d") in mask.exclude_dates:
        return False
```

`schemas.py` — in `RecurrenceMaskDTO` after `daysOfMonth`: `excludeDates: list[str] = []`, and in `to_mask()`: `exclude_dates=frozenset(self.excludeDates),`.

- [ ] **Step 4: Run to verify PASS**, then the full backend suite: `cd backend && .venv/bin/pytest -q` — green.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/engine/schedule.py backend/auto_trader/api/schemas.py backend/tests/test_schedule.py backend/tests/test_mask_dto.py
git commit -m "feat(backtest): exclude_dates on the recurrence mask (backend)"
```

---

### Task 2: Frontend mask mirror — `excludeDates` in the model and `isActive`

**Files:**
- Modify: `src/lib/backtestConfig.ts` (`RecurrenceMask`)
- Modify: `src/lib/backtestSchedule.ts` (`isActive`, `localParts`, plus a new exported date-string helper)
- Test: `src/lib/backtestSchedule.test.ts` (append), `src/lib/backtestPeriods.test.ts` (append)

**Interfaces:**
- Produces: `RecurrenceMask.excludeDates?: string[]`; `export function tzDateString(tMs: number, tz: string): string` ("YYYY-MM-DD" in tz, DST-correct, cached formatter) — Tasks 3/4 use it to key calendar cells.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/backtestSchedule.test.ts` (its `utc` helper exists at the top):

```ts
describe("excludeDates", () => {
  it("blocks a bar whose tz-local date matches; other dates unaffected", () => {
    // 2024-01-01 23:00 UTC is already 2024-01-02 in Tokyo.
    const m = { enabled: true, tz: "Asia/Tokyo", excludeDates: ["2024-01-02"] };
    expect(isActive(m, utc(2024, 1, 1, 23, 0))).toBe(false);
    expect(isActive(m, utc(2024, 1, 1, 10, 0))).toBe(true);
  });

  it("ANDs with daysOfWeek and timeOfDay (overnight wrap intact)", () => {
    const m = {
      enabled: true, tz: "UTC",
      daysOfWeek: [1, 2, 3, 4, 5],
      timeOfDay: { startMin: 22 * 60, endMin: 2 * 60 }, // overnight
      excludeDates: ["2024-01-03"],
    };
    expect(isActive(m, utc(2024, 1, 3, 23, 0))).toBe(false); // excluded date
    expect(isActive(m, utc(2024, 1, 2, 23, 0))).toBe(true);  // in window, weekday, not excluded
    expect(isActive(m, utc(2024, 1, 2, 12, 0))).toBe(false); // outside window
  });

  it("resolveMask passes excludeDates through unchanged when inlining a session", () => {
    const r = resolveMask({ enabled: true, session: "NYSE", excludeDates: ["2024-07-04"] });
    expect(r.excludeDates).toEqual(["2024-07-04"]);
    expect(r.session).toBeUndefined();
  });

  it("tzDateString formats DST-transition days per-date, not via a cached offset", () => {
    // 2024-03-10 is the US spring-forward date; 2024-03-10 23:30 New York local
    // is 2024-03-11 03:30 UTC — the NY date string must still be 2024-03-10.
    expect(tzDateString(Date.UTC(2024, 2, 11, 3, 30), "America/New_York")).toBe("2024-03-10");
    expect(tzDateString(Date.UTC(2024, 2, 11, 3, 30), "UTC")).toBe("2024-03-11");
  });
});
```

(Import `tzDateString` in the test file's existing import list. If `resolveMask`'s `RecurrenceMask` type rejects `excludeDates` before Step 3, that's the RED.)

Append to `src/lib/backtestPeriods.test.ts` (read its fixtures first — it builds `barTimes` arrays):

```ts
it("computePeriodBands splits bands around an excluded date inside an active span", () => {
  // Hourly bars over 3 consecutive UTC days; the middle day is excluded.
  const barTimes: number[] = [];
  for (let d = 1; d <= 3; d++)
    for (let h = 0; h < 24; h++) barTimes.push(Date.UTC(2024, 0, d, h));
  const bands = computePeriodBands(
    {
      fromMs: Date.UTC(2024, 0, 1),
      toMs: Date.UTC(2024, 0, 4),
      mask: { enabled: true, tz: "UTC", excludeDates: ["2024-01-02"] },
    },
    barTimes,
  );
  expect(bands).toHaveLength(2);
  expect(bands[0].toMs).toBeLessThan(Date.UTC(2024, 0, 2));
  expect(bands[1].fromMs).toBeGreaterThanOrEqual(Date.UTC(2024, 0, 3));
});
```

- [ ] **Step 2: Run to verify FAIL** (`npx vitest run src/lib/backtestSchedule.test.ts src/lib/backtestPeriods.test.ts`).

- [ ] **Step 3: Implement**

`backtestConfig.ts` — in `RecurrenceMask` after `daysOfMonth`:

```ts
  // Specific tz-local calendar dates ("YYYY-MM-DD") that never trade — manual
  // holiday click-off from the range calendar. Absent/empty = none excluded.
  excludeDates?: string[];
```

`backtestSchedule.ts`:
- New export using the existing cache (`cachedFormat`, key `` `date|${tz}` ``, the same `en-CA` formatter pattern `windowUtcMs` uses — `new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })`; `en-CA` `.format()` yields exactly `YYYY-MM-DD`):

```ts
/** The tz-local calendar date of an instant, as "YYYY-MM-DD". Cached per-tz
 *  formatter (computePeriodBands funnels every bar through isActive). */
export function tzDateString(tMs: number, tz: string): string {
  return cachedFormat(`date|${tz}`, () =>
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }),
  ).format(tMs);
}
```

- In `isActive`, after the `daysOfMonth` check and before `timeOfDay` (mirror position of the backend check):

```ts
  if (m.excludeDates?.length && m.excludeDates.includes(tzDateString(tMs, tz))) return false;
```

(`resolveMask` needs no change — it spreads `...rest`, so the field passes through; the test pins that.)

- [ ] **Step 4: Run to verify PASS**, then full `npm run test:unit` + `npx tsc -b` (no new errors).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/backtestConfig.ts frontend/src/lib/backtestSchedule.ts frontend/src/lib/backtestSchedule.test.ts frontend/src/lib/backtestPeriods.test.ts
git commit -m "feat(backtest): excludeDates in the frontend mask mirror"
```

---

### Task 3: `RangeCalendarPopover` — the component

**Files:**
- Create: `src/RangeCalendarPopover.tsx`
- Create: `src/RangeCalendarPopover.test.tsx` (jsdom: first line `// @vitest-environment jsdom`)
- Modify: `src/App.css` (styles appended near the other `bt-*` blocks, ~line 2145+)

**Interfaces:**
- Consumes: `tzDateString` (Task 2), `SESSION_PRESETS` not needed; `DayTimeWindow`, `RecurrenceMask` types from `lib/backtestConfig`.
- Produces (Task 4 mounts this):

```ts
export interface RangeCalendarProps {
  fromMs?: number;             // current span (whole-day bounds not assumed)
  toMs?: number;
  mask: RecurrenceMask | undefined;
  tz: string;                  // chartTimezone — days render/write in this zone
  timeStripDisabled: boolean;  // resSeconds >= 86400
  // Writers — Task 4 maps these onto setRange/setMask:
  onSpan: (fromMs: number, toMs: number) => void;          // whole-day bounds in tz
  onMaskPatch: (patch: Partial<RecurrenceMask>) => void;
  onClose: () => void;
  anchor: { top: number; left: number };                   // fixed-position origin
}
export default function RangeCalendarPopover(props: RangeCalendarProps): JSX.Element;
```

The component owns only view state (displayed month, in-progress drag). All model writes go through the two callbacks.

- [ ] **Step 1: Write the failing tests** (`src/RangeCalendarPopover.test.tsx`, RTL like `BacktestSettingsModal.test.tsx` — read its idioms first). Cases:

1. **Renders a month grid in tz**: with `anchor={{top:0,left:0}}`, `tz:"UTC"`, displayed month derived from `fromMs` (or "today" when absent): weekday headers Mon…Sun; the grid contains a cell for each day of the shown month (query by accessible name or `data-date` attribute — give each cell `data-date="YYYY-MM-DD"`).
2. **Two-click span selection**: click day A then day B (A<B) → `onSpan(Date.UTC of A 00:00, Date.UTC of B+1 00:00)`; and when `mask?.daysOfWeek` is empty/absent it ALSO calls `onMaskPatch({ enabled: true, daysOfWeek: [1,2,3,4,5] })`; when `daysOfWeek` already set, no `daysOfWeek` in the patch (assert `onMaskPatch` called with `{enabled:true}` only, or not at all if mask already enabled — pick one behavior and pin it: patch `{enabled:true}` when `!mask?.enabled`).
3. **Reverse order works**: clicking B then A produces the same span.
4. **Weekday header click** → `onMaskPatch({ daysOfWeek: <toggled array> })` (toggling Sat=6 off a full set, on again).
5. **Date-cell modifier-free second gesture — holiday toggle**: a plain click on a day INSIDE the current span (props `fromMs/toMs` covering it) toggles `excludeDates` via `onMaskPatch({ excludeDates: [...] })` instead of starting a new span. (Disambiguation rule, pinned: **click inside the current span = exclude-toggle; click outside = start a new span selection**. First click outside arms the span start; second click completes it.)
6. **Excluded/weekend rendering**: cells whose date is in `mask.excludeDates`, or whose weekday is off in `daysOfWeek`, carry class `off` when inside the span.
7. **"Weekends" toggle button**: when Sat/Sun are off → click calls `onMaskPatch({ daysOfWeek: [0,1,2,3,4,5,6] })`; when on → `[1,2,3,4,5]`.
8. **Month paging**: ‹ / › buttons change the displayed month label (e.g. "January 2024" → "February 2024") without calling `onSpan`.
9. **Time strip**: with `timeStripDisabled:false`, pointer-drag from 25% to 75% of the strip width → `onMaskPatch({ timeOfDay: { startMin: 360, endMin: 1080 } })` (snap to 30-min increments; 24h track ⇒ 25%→06:00, 75%→18:00). With `timeStripDisabled:true`, the strip has class `is-off` and drags call nothing.
10. **Dismissal**: Escape and outside-pointerdown call `onClose`; a pointerdown inside does not.

Use `fireEvent.pointerDown/pointerMove/pointerUp` for the strip; give the strip a fixed layout via `getBoundingClientRect` mock (RTL/jsdom has no layout — mock `HTMLElement.prototype.getBoundingClientRect` for the strip element or accept a `data-testid` and stub its rect; note the chosen mechanism in the test file).

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement**

Component sketch (the executor fills in; key mechanics are binding):
- **Portal + fixed**: `createPortal(<div className="dropdown bt-calendar-pop" style={{ position: "fixed", top: anchor.top, left: anchor.left }}>…, document.body)`.
- **Dismissal effect** — copy `SessionFillMenu`'s (BacktestSettingsModal.tsx:3868-3885): `mousedown`(capture, skip inside)/`resize`/`scroll`(capture) close + a `keydown` Escape listener. Use `pointerdown` for the outside check to match the tests.
- **Day math in tz** (DST-safe, Ruling 5): build the month grid from a cursor `{year, month}`; each cell's date string is authored directly (`` `${y}-${pad(m)}-${pad(d)}` ``), and its UTC instant for `onSpan` is computed by the `windowUtcMs` guess-correct idiom: `guess = Date.UTC(y, m-1, d)` then `utc = guess - tzOffsetMs(tz, guess)`. `tzOffsetMs` is module-private in `backtestSchedule.ts` — **export it** (one-line change, keep the name) rather than duplicating. `toMs` for day D = start-of-day D+1.
- **Today/selection classes**: cell classes `in-span`, `off` (weekend-or-excluded within span), `today`.
- **Weekday headers**: buttons Mon…Sun mapping to JS `getDay` values `[1,2,3,4,5,6,0]`.
- **Time strip**: a `div` track with a filled window segment; drag converts clientX fraction → minutes snapped to 30; end<start allowed (wrap) — render the wrap as two filled segments. Labels `HH:MM – HH:MM` via `minToTime` (exported from backtestSchedule).
- **CSS** (`App.css`, after the `.bt-heatstrip` block ~2180): `.dropdown.bt-calendar-pop { position: fixed; z-index: 2100; width: max-content; min-width: 0; padding: 10px; }` plus grid styles (7-col `display:grid`), `.bt-cal-cell`, `.bt-cal-cell.in-span`, `.bt-cal-cell.off { opacity:.35; text-decoration: line-through; }`, `.bt-cal-head`, `.bt-timestrip { position:relative; height:14px; border-radius:4px; background: var(--muted-bg, #e5e7eb); }`, `.bt-timestrip .win { position:absolute; top:0; bottom:0; background: var(--accent, #2b7); border-radius:4px; }`, `.bt-timestrip.is-off { opacity:.45; pointer-events:none; }`. Follow existing token usage (`--surface-2`, `--border`, `--accent`).

- [ ] **Step 4: Run to verify PASS**, then full suite + tsc.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/RangeCalendarPopover.tsx frontend/src/RangeCalendarPopover.test.tsx frontend/src/App.css frontend/src/lib/backtestSchedule.ts
git commit -m "feat(backtest): range calendar popover component (month grid + time strip)"
```

---

### Task 4: Wire the popover into BacktestSettingsModal

**Files:**
- Modify: `src/BacktestSettingsModal.tsx` (the `rangePicker` block ~line 2010-2119; imports)
- Test: `src/BacktestSettingsModal.test.tsx` (append)

**Interfaces:**
- Consumes: `RangeCalendarPopover` + `RangeCalendarProps` (Task 3); the modal's existing `setRange`, `setMask`, `cfg`, `chartTimezone`, `resSeconds`, `pickerFromMs`, `pickerToMs`.

- [ ] **Step 1: Write the failing tests** (append to `BacktestSettingsModal.test.tsx`, using its `renderModal` helper at :104):

1. A button with `aria-label="Open range calendar"` renders on the range row; clicking it mounts the popover (query a `.bt-calendar-pop` element / a `data-testid`).
2. Selecting a span in the popover (two day-cell clicks) updates the From/To `datetime-local` inputs to the span's bounds and flips mode to custom (assert via the inputs' values changing; `chartTimezone:"UTC"` in `renderModal` keeps the arithmetic simple — note the From/To inputs render browser-local; set the test's TZ expectations accordingly or assert `onRun`-captured config instead: click the modal's Run button and inspect the captured `cfg.range.fromMs/toMs/mask` — sturdier, do that).
3. A date-cell exclusion lands in the run config: `cfg.range.mask.excludeDates` contains the clicked date.
4. Escape closes the popover.

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement**

In `BacktestSettingsModal.tsx`:
- State: `const [calOpen, setCalOpen] = useState(false);` + `const [calAnchor, setCalAnchor] = useState<{top:number;left:number}|null>(null);` + `const calBtnRef = useRef<HTMLButtonElement>(null);`.
- Button on the `rangePicker` row, right after the existing pick-range button, same visual family (`className="bt-pick-range"`, `aria-label="Open range calendar"`, the 15×15 calendar SVG from ChartRangeBar's trigger: `<rect x="1.5" y="2.5" width="13" height="12" rx="1.5"/><path d="M1.5 5.5h13M5 1v3M11 1v3"/>`). onClick: measure `calBtnRef.current.getBoundingClientRect()`, clamp left to viewport (`Math.max(8, Math.min(r.left, window.innerWidth - 320 - 8))`), `setCalAnchor({ top: r.bottom + 4, left })`, toggle `calOpen`.
- Mount: 

```tsx
{calOpen && calAnchor && (
  <RangeCalendarPopover
    fromMs={pickerFromMs}
    toMs={pickerToMs}
    mask={cfg.range.mask}
    tz={chartTimezone}
    timeStripDisabled={resSeconds >= 86400}
    anchor={calAnchor}
    onSpan={(fromMs, toMs) => setRange({ mode: "custom", fromMs, toMs })}
    onMaskPatch={(patch) => setMask(patch)}
    onClose={() => setCalOpen(false)}
  />
)}
```

- Place the mount right after the `rangePicker` JSX const or at the end of the returned tree (it portals anyway; keep it near the button for readability). Import the component.
- Nothing else changes: `BacktestButton` already sends `mask: resolveMask(...)`, which passes `excludeDates` through (Task 2's test pins it), and `computePeriodBands` shading follows via `isActive`.

- [ ] **Step 4: Run to verify PASS**, full `npm run test:unit`, `npx tsc -b` (no new errors), and `cd backend && .venv/bin/pytest -q` once more (nothing should have moved).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/BacktestSettingsModal.tsx frontend/src/BacktestSettingsModal.test.tsx
git commit -m "feat(backtest): calendar popover wired into the Time range row"
```

---

### Task 5: Browser sanity check (verification only)

- [ ] **Step 1:** `cd frontend && VITE_API_BASE= npm run dev -- --port 5174 --strictPort` against the running backend; open http://localhost:5174 in a THROWAWAY chart tab (close it after — app state is shared with the user's workspace).
- [ ] **Step 2:** Open Backtest settings → Time range row → calendar button. Verify: popover opens above the modal (not behind it — the z-index rule); two-click span sets From/To and enables the mask with Mon–Fri seeded; clicking a weekday header (Sat) toggles it; clicking a day inside the span strikes it through and (with the Periods toggle on after a run) carves a gap in the chart's shaded bands; the Weekends toggle restores Sat/Sun; the time strip drags a window and the From/To time inputs mirror it; at a 1D chart timeframe the strip is disabled but day cells still toggle; Escape and outside-click dismiss; the chart "Pick range" button still works; Run a short backtest and confirm the excluded date trades nothing (trade list/shading).
- [ ] **Step 3:** Close the test chart tab, kill the dev server, fix anything found (with tests), commit fixes.
