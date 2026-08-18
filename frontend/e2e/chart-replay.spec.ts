import { test, expect } from "@playwright/test";
import { seedSingleChartDefault, stubStateApi } from "./helpers";

// Bar replay, end to end against the running dev server + backend (the same
// convention most specs in this directory use — real candles, no candle stub).
// A random jump has to find a real tradeable window, which a synthetic stub
// would only ever fake.
//
// Limits of what headless can assert: the time axis, the crosshair label and the
// OHLC tooltip are painted on CANVAS, so the "no absolute date anywhere" claim is
// only checkable here for the DOM chrome (the pill readout, and the withdrawal of
// the quick-range bar). The canvas side is covered by the masked-formatter unit
// tests (src/lib/timeFormat.test.ts, and src/lib/replayFormat.test.ts for the
// masked/real pairing) plus manual verification.

// Real backend + a real candle fetch, plus a full reload mid-test, does not fit
// the config's 30s default. Spec-local so the shared config stays untouched.
test.setTimeout(90_000);

// The ONE console error allowed through, and only because it is a property of
// the port the suite is served on rather than of the app: the agent-UI bridge
// opens ws://<host>/ws/agent-ui, and routers/agent.py closes any connection
// whose Origin is outside guard.py's CORS allowlist — which is hardcoded to
// :5173. Served there the socket connects and this never fires; served from any
// other port (E2E_BASE_URL=http://localhost:5174, say) the browser logs a 403
// handshake failure per reconnect attempt. Deliberately anchored to that one
// path and that one failure mode, so any other console error still fails.
const ENV_NOISE = /ws\/agent-ui.*WebSocket handshake/;

test("chart replay: jump, step, mask, persist, exit", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !ENV_NOISE.test(m.text())) errors.push(m.text());
  });

  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();
  // Bars loaded, not merely a canvas mounted: replay reads the store, so a
  // canvas with no data would enter picking against an empty chart. Same probe
  // range-bar.spec.ts uses.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const c = (window as unknown as { __chart?: { getDataList(): unknown[] } }).__chart;
          return c ? c.getDataList().length : 0;
        }),
      { timeout: 30000 },
    )
    .toBeGreaterThan(0);

  // Enter picking mode.
  await page.locator(".replay-toggle").click();
  await expect(page.locator(".replay-start-panel")).toBeVisible();

  // Random jump with the default blind ("Hide dates") session — ReplayStartPanel
  // renders the checkbox from ChartCore's `pickMasked`, which starts true.
  await page.locator(".rsp-jump").click();
  const pill = page.locator(".replay-pill");
  await pill.waitFor({ timeout: 30000 });

  // The readout is masked: a relative day, never a real date.
  //
  // BOTH halves, the way the reveal-range assertion below already does it. The
  // positive alone is worthless here: Playwright's toHaveText matches a regex
  // PARTIALLY, so a start-anchored /^Day -?\d+/ passes just as happily on
  // "Day 4 2026-08-10 09:30" — a readout carrying the real date is the single
  // DOM surface this spec exists to guard, and it would sail through. The
  // negative is what actually holds the line: no four-digit year, anywhere.
  const readout = page.locator(".rp-readout");
  await expect(readout).toHaveClass(/masked/);
  await expect(readout).toHaveText(/^Day -?\d+ \d{2}:\d{2}$/);
  await expect(readout).not.toHaveText(/\d{4}/);

  // The quick-range bar (which navigates to "now" and carries a date picker) is
  // gone for the duration of the session.
  await expect(page.locator(".chart-range-bar")).toHaveCount(0);

  // THE invariant: a replay session must never paint a bar past the cursor.
  //
  // It is DOM-reachable, and nothing was asserting it. useReplay applies the
  // slice through `facade.setBars(...)`, so `__chart.getDataList()` during a
  // session IS the revealed slice — its last timestamp is the newest bar on
  // screen, and it must sit at or before the cursor. (cursorMs is the CLOSE of
  // that bar, so "before", never "equal to".)
  const lastBarTs = () =>
    page.evaluate(() => {
      const c = (window as unknown as { __chart?: { getDataList(): { timestamp: number }[] } }).__chart;
      const d = c?.getDataList() ?? [];
      return d.length ? d[d.length - 1].timestamp : 0;
    });
  const barCount = () =>
    page.evaluate(() => {
      const c = (window as unknown as { __chart?: { getDataList(): unknown[] } }).__chart;
      return c?.getDataList().length ?? 0;
    });
  const cursorMs = () =>
    page.evaluate(() => {
      const raw = localStorage.getItem("auto-trader.replaySessions");
      if (!raw) return 0;
      const all = JSON.parse(raw) as Record<string, { cursorMs: number }>;
      return Object.values(all)[0]?.cursorMs ?? 0;
    });

  // Wait for the record so `cursorMs()` has something to read.
  await expect.poll(() => cursorMs(), { timeout: 30000 }).toBeGreaterThan(0);
  // Then poll the invariant itself, the way the post-step check below already
  // does. The session record and the chart's bars are written by different
  // paths, so the record can land a frame before the replay slice replaces the
  // live series — and a single-shot read here catches the live last bar, which
  // is NOT behind the cursor. Roughly one run in five.
  await expect.poll(async () => (await lastBarTs()) < (await cursorMs())).toBe(true);

  // Stepping forward advances the cursor — by EXACTLY one bar, which the pair of
  // reads below proves: the bar count goes up by one and the invariant still
  // holds at the new cursor.
  const before = await readout.textContent();
  const barsBefore = await barCount();
  await page.locator('[aria-label="Step forward"]').click();
  await expect(readout).not.toHaveText(before ?? "");
  const stepped = await readout.textContent();
  expect(await barCount()).toBe(barsBefore + 1);
  await expect.poll(async () => (await lastBarTs()) < (await cursorMs())).toBe(true);

  // The session is persisted device-locally, keyed by cell scope.
  const saved = () =>
    page.evaluate(() => {
      const raw = localStorage.getItem("auto-trader.replaySessions");
      return raw ? Object.keys(JSON.parse(raw) as Record<string, unknown>).length : 0;
    });
  await expect.poll(saved).toBe(1);

  // A reload resumes the session: mode (the pill is back, not the range bar),
  // mask, and the cursor. The cursor check is the one with teeth — a resume that
  // restored the session but reset the cursor to its start would still satisfy
  // the other two, and the readout is masked, so re-rendering the SAME "Day N
  // HH:mm" is what says the stepped-to cursorMs (not just startMs) came back.
  await page.reload();
  await page.locator(".replay-pill").waitFor({ timeout: 30000 });
  await expect(page.locator(".rp-readout")).toHaveClass(/masked/);
  await expect(page.locator(".rp-readout")).toHaveText(stepped ?? "");
  await expect(page.locator(".chart-range-bar")).toHaveCount(0);

  // Exit through the report card: the reveal shows a real date range, and the
  // cell returns to live (the quick-range bar comes back).
  await page.locator('[aria-label="Exit replay"]').click();
  await expect(page.locator(".replay-report")).toBeVisible();
  const reveal = page.locator(".rr-reveal-range");
  // Both halves of the reveal's contract. The positive match is the default
  // "ymd" date format ("2026-07-10 09:30"); the "\d{2}/" alternative covers a
  // dmy/mdy preference. The negative is the one replayFormat.ts's header calls
  // out by name: handing this card the MASKED formatter is a one-word edit at
  // the call site that leaves every unit test green and renders "Day 4 09:30 to
  // Day 4 15:30" here.
  await expect(reveal).toHaveText(/\d{4}|\d{2}\//);
  await expect(reveal).not.toHaveText(/Day -?\d/);
  await page.locator(".rr-done").click();
  await expect(page.locator(".replay-pill")).toHaveCount(0);
  await expect(page.locator(".chart-range-bar")).toHaveCount(1);
  await expect.poll(saved).toBe(0);

  expect(errors).toEqual([]);
});

// The progressive strategy reveal (lib/replayReveal + the toggle in useReplay).
//
// Two failures a browser pass found while 2600+ unit tests were green, both
// invisible to a harness that mocks the drawing stack: the reveal published
// NOTHING at all, and toggling it back off painted the ENTIRE saved run onto the
// blind chart. So this asserts on what is actually drawn.
//
// `__chart.getOverlays({ name: "backtestMarker" })` is the probe — the same
// measurement made by hand in the browser. It is canvas-free (klinecharts keeps
// overlays as objects), so headless can read it.
//
// The fixture is built AROUND the cursor the random jump lands on, rather than
// at fixed dates: the session has to sit on real tradeable bars, and only the
// jump knows where those are. Two markers before the cursor and two after, so
// "revealed" and "the whole run" are different numbers.
test("chart replay: the strategy reveal shows only what the cursor has passed", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !ENV_NOISE.test(m.text())) errors.push(m.text());
  });

  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const c = (window as unknown as { __chart?: { getDataList(): unknown[] } }).__chart;
          return c ? c.getDataList().length : 0;
        }),
      { timeout: 30000 },
    )
    .toBeGreaterThan(0);

  // Start a masked session so the reveal is exercised under the mask it exists
  // to protect.
  await page.locator(".replay-toggle").click();
  await page.locator(".rsp-jump").click();
  await page.locator(".replay-pill").waitFor({ timeout: 30000 });

  // The cell's SCOPE, epic and resolution, read back out of the session record
  // rather than assumed.
  //
  // They cannot be assumed, and assuming them is what made the first version of
  // this test assert nothing: `seedSingleChartDefault` writes
  // `auto-trader.layout.L0`, but the app's per-broker migration discards that on
  // first load and falls back to a SCRATCH workspace whose tab id is minted at
  // random per run (`tab.tab-msy0dysn-1`, and a different one next time). So the
  // cell's real scope is not `tab.t1`, a saved backtest written under
  // `auto-trader.tab.t1.backtest.US100` is never the key `loadBacktestResult`
  // reads, and the Strategy button stays disabled forever.
  //
  // `auto-trader.replaySessions` is a flat map keyed by exactly that cell scope,
  // and the record carries the epic and resolution too — so once a session
  // exists, it is the authoritative answer to all three.
  const readSession = () =>
    page.evaluate(() => {
      const raw = localStorage.getItem("auto-trader.replaySessions");
      if (!raw) return null;
      const all = JSON.parse(raw) as Record<
        string,
        { cursorMs: number; epic: string; resolution: string }
      >;
      const entry = Object.entries(all)[0];
      if (!entry) return null;
      const [scope, rec] = entry;
      return { scope, epic: rec.epic, resolution: rec.resolution, cursorMs: rec.cursorMs };
    });
  await expect.poll(async () => (await readSession())?.cursorMs ?? 0, { timeout: 30000 }).toBeGreaterThan(0);
  const session = (await readSession())!;
  const cursor = session.cursorMs;

  // The fixture's "already happened" fills go on REAL BAR TIMESTAMPS read off the
  // chart, never on wall-clock offsets from the cursor.
  //
  // That distinction is the whole difference between a spec that passes and one
  // that passes on weekdays. A random jump lands on a Sunday roughly one time in
  // three, and an index's Sunday cursor sits at the weekly open — so `cursor - 2h`
  // is inside the WEEKEND GAP, later than the newest real bar. `drawMarkers` culls
  // any fill outside the loaded window (`fillWithinLoadedWindow`), both markers
  // vanish, and the assertion reads 0 with nothing actually wrong. Measured: every
  // failing run had a Sunday cursor, every passing run a weekday.
  //
  // Two bars back from the newest revealed one is gap-proof by construction: a
  // loaded bar is in the window by definition, and it closed before the bar after
  // it, so the reveal's "this fill's own bar has closed" test always passes.
  // ...and the chart has to be showing the REPLAY SLICE before those timestamps
  // mean anything. The pill appears as soon as the mode flips, which is before
  // `barsFor` has fetched and `setBars` has swapped the live bars out — so a read
  // taken too early returns TODAY's bars, hundreds of hours past the cursor. The
  // fixture then lands outside the loaded window, every marker is culled, and the
  // test fails having exercised nothing. (Caught exactly that way: a run whose
  // "revealed" markers came back stamped 2026-08-18 against a 2026-07-29 cursor.)
  //
  // The invariant asserted earlier in this file is the readiness signal: a
  // replaying chart's newest bar sits strictly before the cursor.
  const lastBarOf = () =>
    page.evaluate(() => {
      const c = (window as unknown as { __chart?: { getDataList(): { timestamp: number }[] } }).__chart;
      const d = c?.getDataList() ?? [];
      return d.length ? d[d.length - 1].timestamp : 0;
    });
  await expect
    .poll(async () => {
      const last = await lastBarOf();
      return last > 0 && last < cursor;
    }, { timeout: 30000 })
    .toBe(true);

  const barTimes = await page.evaluate(() => {
    const c = (window as unknown as { __chart?: { getDataList(): { timestamp: number }[] } }).__chart;
    return (c?.getDataList() ?? []).map((b) => b.timestamp);
  });
  expect(barTimes.length).toBeGreaterThan(4);
  const revealedA = barTimes[barTimes.length - 3];
  const revealedB = barTimes[barTimes.length - 2];

  // The fill the NEXT step reveals sits on the first unpainted bar — and that
  // bar's timestamp is exactly `cursorMs`, because the cursor is defined as the
  // close of the newest revealed bar and the forward buffer has the next one
  // loaded. Gap-proof for the same reason: whatever follows, its close is later.
  await page.evaluate(
    ([cur, a, b, scope, epic, resolution]: [number, number, number, string, string, string]) => {
      const sec = (ms: number) => Math.floor(ms / 1000);
      const trade = (entry: number, exit: number, pnl: number) => ({
        side: "buy",
        quantity: 1,
        entry_time: sec(entry),
        entry_price: 100,
        exit_time: sec(exit),
        exit_price: 100 + pnl,
        pnl,
        leg: "long",
        reason: "target",
        stop_initial: null,
        stop_final: null,
        target: null,
        mae: 0,
        mfe: pnl,
        mae_r: null,
        mfe_r: null,
      });
      const result = {
        epic,
        // The CHART's resolution, so backtestRenderFlags picks "native" markers
        // (one overlay per fill) and the counts below are what gets drawn.
        resolution,
        markers: [
          { time: sec(a), side: "buy", price: 100, reason: "entry", leg: "long" },
          { time: sec(b), side: "sell", price: 105, reason: "target", leg: "long" },
          // Exactly AT the cursor: this is the bar the next step reveals, so it
          // is out now and in one step later. That transition is what proves the
          // drawn set is a function of the cursor rather than a one-shot paint.
          { time: sec(cur), side: "buy", price: 106, reason: "entry", leg: "long" },
        ],
        // One closed trade whose exit has happened, one that closes on the bar
        // the next step reveals. Both anchored to real bars, same as the markers.
        trades: [trade(a, b, 5), trade(cur, cur, 5)],
        equity: [a, b, cur].map((t, i) => ({ time: sec(t), value: 1000 + i })),
        summary: { net_pnl: 10, n_trades: 2, win_rate: 1, max_drawdown: 0 },
        metrics: {
          return_pct: 1,
          profit_factor: null,
          expectancy: 5,
          avg_win: 5,
          avg_loss: 0,
          avg_win_loss_ratio: null,
          largest_win: 5,
          largest_loss: 0,
          max_drawdown_pct: 0,
          avg_duration_bars: 1,
          max_consec_wins: 2,
          max_consec_losses: 0,
        },
      };
      localStorage.setItem(`auto-trader.${scope}.backtest.${epic}`, JSON.stringify(result));
    },
    [cursor, revealedA, revealedB, session.scope, session.epic, session.resolution] as [
      number,
      number,
      number,
      string,
      string,
      string,
    ],
  );

  // Reload so the cell picks the saved backtest up and resumes the session at
  // the same cursor. (This also re-exercises the resumed-session path, which is
  // one of the two the reveal was measured dead on.)
  await page.reload();
  await page.locator(".replay-pill").waitFor({ timeout: 30000 });
  await expect(page.locator(".rp-readout")).toHaveClass(/masked/);

  const markerCount = () =>
    page.evaluate(() => {
      const c = (window as unknown as { __chart?: { getOverlays(f: object): unknown[] } }).__chart;
      return c ? c.getOverlays({ name: "backtestMarker" }).length : -1;
    });

  // Nothing drawn before the toggle: a replaying cell publishes no backtest of
  // its own accord (that gate is backtestPanelActionForReplay).
  await expect.poll(markerCount, { timeout: 30000 }).toBe(0);

  // The resumed session's own bars have to be ON the chart before the toggle is
  // meaningful. The Strategy button enables off localStorage, which is ready long
  // before the candle fetch comes back, so without this the click can land on an
  // empty chart — a state no user can reach by hand, and not the one under test.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const c = (window as unknown as { __chart?: { getDataList(): unknown[] } }).__chart;
          return c ? c.getDataList().length : 0;
        }),
      { timeout: 30000 },
    )
    .toBeGreaterThan(0);

  const strategy = page.locator('[aria-label="Reveal strategy"]');
  await expect(strategy).toBeEnabled();
  await strategy.click();

  // ON: the two fills the cursor has passed, and ONLY those. Strictly less than
  // the saved run's four — this is the assertion that was inoperative in the
  // browser (it stayed at 0 forever).
  await expect.poll(markerCount, { timeout: 30000 }).toBe(2);
  await expect(strategy).toHaveClass(/rp-on/);

  // ...and the readout is still masked while the reveal is on: revealing the
  // STRATEGY must not reveal the DATES.
  await expect(page.locator(".rp-readout")).toHaveText(/^Day -?\d+ \d{2}:\d{2}$/);
  await expect(page.locator(".rp-readout")).not.toHaveText(/\d{4}/);

  // PROGRESSIVE: one step forward reveals the fill stamped at the old cursor, so
  // the drawn set grows. This is the half that says the reveal tracks the cursor
  // rather than painting once — it is what stopped working in the browser.
  await page.locator('[aria-label="Step forward"]').click();
  await expect.poll(markerCount, { timeout: 30000 }).toBe(3);

  // OFF, mid-session: the slice comes DOWN. It must not be replaced by the whole
  // saved run — that was the blindness Critical, and it is why this asserts 0
  // rather than "not 2": a rehydrate here would leave the two past markers drawn
  // (they are inside the loaded window) and read as unchanged.
  await strategy.click();
  await expect(strategy).not.toHaveClass(/rp-on/);
  await expect.poll(markerCount, { timeout: 30000 }).toBe(0);
  // The session is still running — this was never an exit.
  await expect(page.locator(".replay-pill")).toHaveCount(1);

  // Back on again at the same cursor: the reveal must redraw rather than trust a
  // stale dedup signature. Three now, not two — the step above advanced the
  // cursor past the third fill.
  await strategy.click();
  await expect.poll(markerCount, { timeout: 30000 }).toBe(3);

  expect(errors).toEqual([]);
});
