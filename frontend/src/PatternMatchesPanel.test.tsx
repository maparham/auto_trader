// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import PatternMatchesPanel from "./PatternMatchesPanel";
import type { PatternMatch, PatternSearchResult } from "./lib/patternSearch";

// The unreachable-match rows toast instead of jumping; keep the real notifier
// (and its DOM) out of the panel's tests.
const toasted = vi.fn();
vi.mock("./lib/notify", () => ({ toast: (...args: unknown[]) => toasted(...args) }));

const bar = (ts: number, o: number, h: number, l: number, c: number) => ({ ts, o, h, l, c });

// The scanned series' newest bar, which the reach estimate measures back from.
const NEWEST_TS = 1_700_002_000;

const match = (over: Partial<PatternMatch> = {}): PatternMatch => ({
  ts: 1_700_000_000,
  endTs: 1_700_000_900,
  distance: 0.113,
  bars: [bar(1_700_000_000, 10, 12, 9, 11), bar(1_700_000_900, 11, 13, 10, 12)],
  forward: [bar(1_700_001_200, 12, 13, 11, 12.5)],
  forwardComplete: true,
  forwardPct: 4.17,
  ...over,
});

const result = (over: Partial<PatternSearchResult> = {}): PatternSearchResult => ({
  matches: [match()],
  scanned: 412_031,
  series: { oldestTs: 1_600_000_000, newestTs: 1_700_002_000, bars: 412_040 },
  elapsedMs: 118,
  cold: false,
  ...over,
});

const props = {
  epic: "US100", resolution: "MINUTE_5", broker: "capital", priceSide: "bid",
  timezone: "UTC", onJump: vi.fn(), onDismiss: vi.fn(), onCopy: vi.fn(),
  mode: "ohlc" as const, onModeChange: vi.fn(),
  forwardBars: 20, onForwardBarsChange: vi.fn(),
  scope: "all" as const, onScopeChange: vi.fn(),
};

// This repo runs vitest WITHOUT jest globals, so Testing Library's automatic
// cleanup never registers and renders leak between tests. Same idiom as
// BacktestAnalysisPanel.test.tsx.
afterEach(cleanup);

describe("PatternMatchesPanel", () => {
  it("tags every row with its own bar count, since scales make lengths differ", () => {
    const three = match({
      ts: 1_700_005_000,
      endTs: 1_700_005_600,
      bars: [
        bar(1_700_005_000, 10, 12, 9, 11),
        bar(1_700_005_300, 11, 13, 10, 12),
        bar(1_700_005_600, 12, 13, 11, 12.5),
      ],
    });
    render(
      <PatternMatchesPanel
        {...props}
        result={result({ matches: [match(), three] })}
        loading={false}
        error={null}
      />,
    );
    expect(screen.getByText("2 bars")).toBeTruthy();
    expect(screen.getByText("3 bars")).toBeTruthy();
  });


  it("states what was searched, so a thin source is visible", () => {
    render(<PatternMatchesPanel {...props} result={result()} loading={false} error={null} />);
    expect(screen.getByText(/412,040 bars/)).toBeTruthy();
    expect(screen.getByText(/capital \(bid\)/)).toBeTruthy();
    // Distinct from the bar count: flat and gapped windows are dropped before
    // ranking, and the gap between the two numbers is the point.
    expect(screen.getByText(/412,031 windows ranked/)).toBeTruthy();
  });

  it("states the scanned span, which is the whole disclosure for a thin source", () => {
    // The search is pinned to the chart's own broker and price side, which on
    // some sources is one month of history where another holds five years. This
    // line is the entire mitigation for that: if it renders wrong or empty, a
    // thin result set looks like a bug instead of looking thin.
    render(<PatternMatchesPanel {...props} result={result()} loading={false} error={null} />);
    expect(screen.getByText(/13 Sept 2020 to 14 Nov 2023/)).toBeTruthy();
  });

  it("renders a candle per bar, the aftermath dimmed, with a divider between", () => {
    const { container } = render(
      <PatternMatchesPanel {...props} result={result()} loading={false} error={null} />,
    );
    const m = match();
    expect(container.querySelectorAll(".pm-preview g")).toHaveLength(
      m.bars.length + m.forward.length,
    );
    expect(container.querySelectorAll(".pm-preview g.pm-fwd")).toHaveLength(m.forward.length);
    expect(container.querySelector(".pm-divider")).toBeTruthy();
  });

  it("colours a loss differently from a gain", () => {
    const res = result({ matches: [match(), match({ forwardPct: -2.5 })] });
    const { container } = render(
      <PatternMatchesPanel {...props} result={res} loading={false} error={null} />,
    );
    const cells = Array.from(container.querySelectorAll(".pm-pct"));
    expect(cells).toHaveLength(2);
    // Positionally, not by count: swapping the two branches keeps the count at
    // one while inverting the whole display, and a count assertion passes.
    expect(cells[0].className).not.toContain("neg");
    expect(cells[1].className).toContain("neg");
  });

  it("does not colour a missing outcome as a gain", () => {
    const res = result({
      matches: [match({ forward: [], forwardComplete: false, forwardPct: null })],
    });
    const { container } = render(
      <PatternMatchesPanel {...props} result={res} loading={false} error={null} />,
    );
    const cell = container.querySelector(".pm-pct");
    expect(cell?.className).toContain("pm-none");
    expect(cell?.className).not.toContain("neg");
    // "(partial)" beside "no bars after" is redundant and overflows the column.
    expect(cell?.textContent).toBe("no bars after");
  });

  it("names the horizon in the outcome column, so the number is not bare", () => {
    // The percentage is meaningless without knowing how many bars it covers.
    // The heading tracks the control rather than restating a constant, so the
    // two can never disagree.
    const { rerender } = render(
      <PatternMatchesPanel {...props} result={result()} loading={false} error={null} />,
    );
    expect(screen.getByText(/Next 20/)).toBeTruthy();
    rerender(
      <PatternMatchesPanel {...props} forwardBars={50} result={result()} loading={false} error={null} />,
    );
    expect(screen.getByText(/Next 50/)).toBeTruthy();
  });

  it("shows the worst distance in the set, so a thin set is visible too", () => {
    const res = result({ matches: [match({ distance: 0.11 }), match({ distance: 0.94 })] });
    render(<PatternMatchesPanel {...props} result={res} loading={false} error={null} />);
    // It appears twice: once in the header summary, once in its own row.
    expect(screen.getAllByText(/0\.94/).length).toBeGreaterThanOrEqual(2);
  });

  it("renders a row per match with its forward return", () => {
    render(<PatternMatchesPanel {...props} result={result()} loading={false} error={null} />);
    const rows = screen.getAllByRole("button", { name: /go to/i });
    expect(rows).toHaveLength(1);
    // Scoped to the row: the statistics strip echoes the same figure.
    expect(within(rows[0]).getByText("+4.17%")).toBeTruthy();
  });

  it("says when a match has less aftermath than asked for", () => {
    const res = result({ matches: [match({ forwardComplete: false })] });
    render(<PatternMatchesPanel {...props} result={res} loading={false} error={null} />);
    expect(screen.getByText(/partial/i)).toBeTruthy();
  });

  it("hands the whole match over when a row is clicked", () => {
    // Not just the two ends: the caller paints the forward window too, and it
    // reads that off match.forward.
    const onJump = vi.fn();
    const res = result();
    render(<PatternMatchesPanel {...props} onJump={onJump} result={res} loading={false} error={null} />);
    fireEvent.click(screen.getByRole("button", { name: /go to/i }));
    expect(onJump).toHaveBeenCalledWith(res.matches[0]);
    expect(onJump.mock.calls[0][0].forward).toEqual(res.matches[0].forward);
  });

  it("discloses that a long drag was matched on its last candles only", () => {
    const { rerender } = render(
      <PatternMatchesPanel {...props} result={result()} loading={false} error={null} />,
    );
    expect(screen.queryByText(/last 64 candles/i)).toBeNull();
    rerender(
      <PatternMatchesPanel {...props} truncatedTo={64} result={result()} loading={false} error={null} />,
    );
    expect(screen.getByText(/Matched on the last 64 candles of your selection\./)).toBeTruthy();
  });

  it("labels the row that is the user's own selection, and only that one", () => {
    // The selection is scanned like every other window and comes back at ~0.
    // Without the label the top row reads as an uncanny coincidence rather than
    // as the reference point it is.
    const self = match({ distance: 0, isSelection: true });
    const other = match({ ts: 1_600_500_000, endTs: 1_600_500_900 });
    const { container } = render(
      <PatternMatchesPanel {...props} result={result({ matches: [self, other] })} loading={false} error={null} />,
    );
    const flags = container.querySelectorAll(".pm-self-flag");
    expect(flags).toHaveLength(1);
    expect(flags[0].textContent).toBe("your selection");
    expect(container.querySelectorAll(".pm-row")[0].textContent).toContain("your selection");
  });

  it("jumps to a match from years back like any other", () => {
    // 400,000 five-minute bars behind the newest bar used to be marked "far
    // back" and refused, because the jump walked history one page at a time on
    // a fixed budget. It now covers the gap in concurrent windows, so the row
    // is an ordinary row: no marker, no toast, a jump.
    const onJump = vi.fn();
    const far = match({ ts: NEWEST_TS - 400_000 * 300, endTs: NEWEST_TS - 399_998 * 300 });
    const { container } = render(
      <PatternMatchesPanel
        {...props}
        onJump={onJump}
        result={result({ matches: [far] })}
        loading={false}
        error={null}
      />,
    );
    expect(container.querySelectorAll(".pm-far-flag")).toHaveLength(0);
    expect(container.querySelectorAll(".pm-row")[0].className).not.toContain("pm-far");
    fireEvent.click(screen.getByRole("button", { name: /go to/i }));
    expect(onJump).toHaveBeenCalledWith(far);
    expect(toasted).not.toHaveBeenCalled();
  });

  it("says so rather than showing an empty list", () => {
    render(<PatternMatchesPanel {...props} result={result({ matches: [] })} loading={false} error={null} />);
    expect(screen.getByText(/no similar sequence/i)).toBeTruthy();
  });

  it("shows the error instead of the list", () => {
    render(<PatternMatchesPanel {...props} result={null} loading={false} error="select at least 3 candles" />);
    expect(screen.getByText("select at least 3 candles")).toBeTruthy();
  });

  it("warns that the first search on a symbol is slower", () => {
    render(<PatternMatchesPanel {...props} result={null} loading={true} error={null} />);
    expect(screen.getByText(/first search on a symbol is slower/i)).toBeTruthy();
  });

  it("survives a click on the chart, band and results intact", () => {
    // Dismissing clears the painted band too, so click-away would throw the
    // ranked list away the moment the user panned to read a match's context.
    const onDismiss = vi.fn();
    render(<PatternMatchesPanel {...props} onDismiss={onDismiss} result={result()} loading={false} error={null} />);
    fireEvent.mouseDown(document.body);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("offers both metrics, showing which one produced these results", () => {
    render(<PatternMatchesPanel {...props} result={result()} loading={false} error={null} />);
    const candles = screen.getByRole("button", { name: /whole candles/i });
    const close = screen.getByRole("button", { name: /closing prices/i });
    expect(candles.getAttribute("aria-pressed")).toBe("true");
    expect(close.getAttribute("aria-pressed")).toBe("false");
  });

  it("asks for the other metric on a click", () => {
    const onModeChange = vi.fn();
    render(
      <PatternMatchesPanel {...props} onModeChange={onModeChange}
        result={result()} loading={false} error={null} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /closing prices/i }));
    expect(onModeChange).toHaveBeenCalledWith("close");
  });

  it("shows the horizon in use and asks for a new one", () => {
    const onForwardBarsChange = vi.fn();
    render(
      <PatternMatchesPanel {...props} onForwardBarsChange={onForwardBarsChange}
        result={result()} loading={false} error={null} />,
    );
    const select = screen.getByRole("combobox", { name: /aftermath/i }) as HTMLSelectElement;
    expect(select.value).toBe("20");
    fireEvent.change(select, { target: { value: "50" } });
    // A number, not the DOM's string: the request field is typed.
    expect(onForwardBarsChange).toHaveBeenCalledWith(50);
  });

  it("keeps the controls up while a search is running, so they can be changed again", () => {
    // They re-run the last range, which is exactly what the user does when the
    // first answer is not the one they wanted.
    render(<PatternMatchesPanel {...props} result={null} loading={true} error={null} />);
    expect(screen.getByRole("button", { name: /whole candles/i })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: /aftermath/i })).toBeTruthy();
  });

  it("copies a match to the pattern clipboard without jumping there", () => {
    const onCopy = vi.fn();
    const onJump = vi.fn();
    const m = match();
    render(
      <PatternMatchesPanel {...props} onCopy={onCopy} onJump={onJump} result={result({ matches: [m] })} loading={false} error={null} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Copy pattern from/ }));
    expect(onCopy).toHaveBeenCalledWith(m);
    // The copy is its own control: taking a pattern must not also jump the
    // chart away from where the user is.
    expect(onJump).not.toHaveBeenCalled();
  });

  it("keeps the copy control out of the jump row, so both stay reachable", () => {
    render(<PatternMatchesPanel {...props} result={result()} loading={false} error={null} />);
    const copy = screen.getByRole("button", { name: /^Copy pattern from/ });
    // A button nested in a button is invalid and unreachable by keyboard.
    expect(copy.closest(".pm-row")).toBeNull();
  });

  it("does not close on Escape: only the close button dismisses", () => {
    // Esc is heavily used to cancel chart tools; a panel of found matches must
    // not be collateral damage of one keypress.
    const onDismiss = vi.fn();
    render(<PatternMatchesPanel {...props} onDismiss={onDismiss} result={result()} loading={false} error={null} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

describe("PatternMatchesPanel sorting", () => {
  // Distance order, outcome order and date order all disagree, and one row has
  // no aftermath at all.
  const sortable = () =>
    result({
      matches: [
        match({ ts: 1_700_000_300, distance: 0.10, forwardPct: -1.5 }), // rank 1
        match({ ts: 1_700_000_100, distance: 0.20, forwardPct: 4.0 }),  // rank 2
        match({ ts: 1_700_000_400, distance: 0.30, forwardPct: null, forward: [] }), // rank 3
      ],
    });

  const ranks = () =>
    // .pm-row scoped: .pm-cols carries an empty .pm-rank as the grid spacer.
    Array.from(document.querySelectorAll(".pm-row .pm-rank")).map((n) => n.textContent);
  const dists = () =>
    Array.from(document.querySelectorAll(".pm-dist")).map((n) => n.textContent);
  // "Next 20" is also the aftermath control's label, so match the heading by role.
  const outcomeHead = () => screen.getByRole("button", { name: /^Next 20/ });

  it("opens on distance ascending, in the order the backend sent", () => {
    render(<PatternMatchesPanel {...props} result={sortable()} loading={false} error={null} />);
    expect(dists()).toEqual(["0.10", "0.20", "0.30"]);
    expect(ranks()).toEqual(["1", "2", "3"]);
  });

  it("reorders the rows when the outcome heading is clicked", () => {
    render(<PatternMatchesPanel {...props} result={sortable()} loading={false} error={null} />);
    fireEvent.click(outcomeHead());
    // Best first, and no aftermath last rather than read as 0%.
    expect(dists()).toEqual(["0.20", "0.10", "0.30"]);
  });

  it("keeps the similarity rank after sorting, so it is not the row number", () => {
    render(<PatternMatchesPanel {...props} result={sortable()} loading={false} error={null} />);
    fireEvent.click(outcomeHead());
    // The best analogue was only the 2nd closest, and the column says so.
    expect(ranks()).toEqual(["2", "1", "3"]);
  });

  it("flips the direction on a second click of the same heading", () => {
    render(<PatternMatchesPanel {...props} result={sortable()} loading={false} error={null} />);
    fireEvent.click(outcomeHead());
    fireEvent.click(outcomeHead());
    expect(ranks()).toEqual(["1", "2", "3"]);
    expect(dists()).toEqual(["0.10", "0.20", "0.30"]);
  });

  it("sorts by date, most recent first", () => {
    render(<PatternMatchesPanel {...props} result={sortable()} loading={false} error={null} />);
    fireEvent.click(screen.getByRole("button", { name: /^When/ }));
    expect(ranks()).toEqual(["3", "1", "2"]);
  });

  it("marks the active column with aria-sort and leaves the others alone", () => {
    render(<PatternMatchesPanel {...props} result={sortable()} loading={false} error={null} />);
    const when = screen.getByRole("button", { name: /^When/ });
    const dist = screen.getByRole("button", { name: /^Dist/ });
    expect(dist.getAttribute("aria-sort")).toBe("ascending");
    expect(when.getAttribute("aria-sort")).toBe("none");
    expect(outcomeHead().getAttribute("aria-sort")).toBe("none");

    fireEvent.click(outcomeHead());
    expect(outcomeHead().getAttribute("aria-sort")).toBe("descending");
    expect(dist.getAttribute("aria-sort")).toBe("none");

    fireEvent.click(outcomeHead());
    expect(outcomeHead().getAttribute("aria-sort")).toBe("ascending");
  });
});

describe("DTW mode", () => {
  it("offers a DTW metric button beside Candles and Close", () => {
    const onModeChange = vi.fn();
    render(
      <PatternMatchesPanel
        {...props}
        onModeChange={onModeChange}
        result={result()}
        loading={false}
        error={null}
      />,
    );
    const btn = screen.getByRole("button", { name: "Match with time warping" });
    expect(btn.textContent).toBe("DTW");
    fireEvent.click(btn);
    expect(onModeChange).toHaveBeenCalledWith("dtw");
  });

  it("marks the DTW button as the active metric when selected", () => {
    render(
      <PatternMatchesPanel
        {...props}
        mode="dtw"
        result={result()}
        loading={false}
        error={null}
      />,
    );
    const btn = screen.getByRole("button", { name: "Match with time warping" });
    expect(btn.getAttribute("aria-pressed")).toBe("true");
  });

  it("explains the distance differently in DTW mode", () => {
    render(
      <PatternMatchesPanel
        {...props}
        mode="dtw"
        result={result()}
        loading={false}
        error={null}
      />,
    );
    fireEvent.focus(screen.getByLabelText("About Distance").parentElement!);
    expect(document.body.textContent).toMatch(/warp/i);
  });

  it("keeps the rigid distance wording in the other modes", () => {
    render(
      <PatternMatchesPanel {...props} result={result()} loading={false} error={null} />,
    );
    fireEvent.focus(screen.getByLabelText("About Distance").parentElement!);
    expect(document.body.textContent).not.toMatch(/warp/i);
    expect(document.body.textContent).toMatch(/exact inversion/);
  });
});

describe("Shape mode", () => {
  it("offers a Shape metric button ahead of the others", () => {
    const onModeChange = vi.fn();
    render(
      <PatternMatchesPanel
        {...props}
        onModeChange={onModeChange}
        result={result()}
        loading={false}
        error={null}
      />,
    );
    const group = screen.getByRole("group", { name: "Metric" });
    const buttons = within(group).getAllByRole("button");
    expect(buttons[0].textContent).toBe("Shape");
    fireEvent.click(buttons[0]);
    expect(onModeChange).toHaveBeenCalledWith("shape");
  });

  it("marks the Shape button as the active metric when selected", () => {
    render(
      <PatternMatchesPanel
        {...props}
        mode="shape"
        result={result()}
        loading={false}
        error={null}
      />,
    );
    const btn = screen.getByRole("button", { name: "Match the overall price shape" });
    expect(btn.getAttribute("aria-pressed")).toBe("true");
  });

  it("explains that the overall shape outweighs bar detail", () => {
    render(
      <PatternMatchesPanel
        {...props}
        mode="shape"
        result={result()}
        loading={false}
        error={null}
      />,
    );
    fireEvent.focus(screen.getByLabelText("About Distance").parentElement!);
    expect(document.body.textContent).toMatch(/overall shape counts most/i);
  });
});

describe("jumped-row highlight", () => {
  const two = () =>
    result({ matches: [match(), match({ ts: 1_690_000_000, endTs: 1_690_003_000 })] });

  const rowButtons = () =>
    screen.getAllByRole("button", { name: /^Go to / });

  it("keeps the clicked row highlighted after the jump", () => {
    render(<PatternMatchesPanel {...props} result={two()} loading={false} error={null} />);
    fireEvent.click(rowButtons()[0]);
    expect(rowButtons()[0].className).toContain("pm-row-sel");
    expect(rowButtons()[0].getAttribute("aria-current")).toBe("true");
  });

  it("moves the highlight when another row is picked", () => {
    render(<PatternMatchesPanel {...props} result={two()} loading={false} error={null} />);
    fireEvent.click(rowButtons()[0]);
    fireEvent.click(rowButtons()[1]);
    expect(rowButtons()[0].className).not.toContain("pm-row-sel");
    expect(rowButtons()[1].className).toContain("pm-row-sel");
  });

  it("clears the highlight when a new result list arrives", () => {
    const view = render(
      <PatternMatchesPanel {...props} result={two()} loading={false} error={null} />,
    );
    fireEvent.click(rowButtons()[0]);
    view.rerender(
      <PatternMatchesPanel {...props} result={two()} loading={false} error={null} />,
    );
    expect(rowButtons()[0].className).not.toContain("pm-row-sel");
  });
});

describe("All mode", () => {
  const dists = (shape: number, ohlc: number | null, close: number, dtw: number) =>
    ({ shape, ohlc, close, dtw });
  const allResult = () =>
    result({
      matches: [
        match({ ts: 1_700_000_000, distance: 1.0, isSelection: true,
                distances: dists(0, 0, 0, 0) }),
        match({ ts: 1_650_000_000, distance: 2.5, distances: dists(0.61, 0.78, 0.66, 0.55) }),
        match({ ts: 1_600_000_000, distance: 2.75, distances: dists(0.72, null, 0.7, 0.6) }),
      ],
    });
  const allProps = { ...props, mode: "all" as const };

  it("offers an All tab alongside the four metrics", () => {
    render(<PatternMatchesPanel {...props} result={result()} loading={false} error={null} />);
    const seg = screen.getByRole("group", { name: "Metric" });
    expect(within(seg).getByText("All")).toBeTruthy();
  });

  it("shows one distance column per formula instead of Dist", () => {
    render(<PatternMatchesPanel {...allProps} result={allResult()} loading={false} error={null} />);
    // Scoped to the header row: the panel's close button and the metric tabs
    // also answer to some of these names.
    const cols = document.querySelector(".pm-cols")!;
    for (const label of ["Shape", "Cndl", "Close", "DTW", "Avg"]) {
      expect(within(cols as HTMLElement).getByRole("button", { name: label })).toBeTruthy();
    }
    expect(screen.queryByRole("button", { name: "Dist" })).toBeNull();
    // The preview column renames so two columns are not both called Shape.
    expect(screen.getByText("Preview")).toBeTruthy();
  });

  it("renders every formula's distance on a row, with a dash where one could not score", () => {
    render(<PatternMatchesPanel {...allProps} result={allResult()} loading={false} error={null} />);
    const row = screen.getAllByRole("button", { name: /^Go to/ })[1];
    expect(row.textContent).toContain("0.61");
    expect(row.textContent).toContain("0.78");
    expect(row.textContent).toContain("0.66");
    expect(row.textContent).toContain("0.55");
    // The Avg cell: (0.61 + 0.78 + 0.66 + 0.55) / 4.
    expect(row.textContent).toContain("0.65");
    const third = screen.getAllByRole("button", { name: /^Go to/ })[2];
    expect(third.textContent).toContain("–");
    // Its average covers only the formulas that scored it: (0.72+0.7+0.6)/3.
    expect(third.textContent).toContain("0.67");
  });

  it("sorts by a formula column's own numbers", () => {
    render(<PatternMatchesPanel {...allProps} result={allResult()} loading={false} error={null} />);
    const cols = document.querySelector(".pm-cols")! as HTMLElement;
    fireEvent.click(within(cols).getByRole("button", { name: "DTW" }));
    const ranks = screen
      .getAllByRole("button", { name: /^Go to/ })
      .map((b) => b.querySelector(".pm-rank")!.textContent);
    // Ascending DTW: selection 0, then 0.55, then 0.6 — the arrival order here,
    // but proven by flipping:
    expect(ranks).toEqual(["1", "2", "3"]);
    fireEvent.click(within(cols).getByRole("button", { name: "DTW" }));
    const flipped = screen
      .getAllByRole("button", { name: /^Go to/ })
      .map((b) => b.querySelector(".pm-rank")!.textContent);
    expect(flipped).toEqual(["3", "2", "1"]);
  });

  it("does not report a worst-shown distance, which would really be a mean rank", () => {
    render(<PatternMatchesPanel {...allProps} result={allResult()} loading={false} error={null} />);
    expect(screen.queryByText(/worst shown/)).toBeNull();
  });
});

describe("summary statistics strip", () => {
  const statsResult = () =>
    result({
      matches: [
        match({ ts: 1_700_000_000, distance: 0.001, isSelection: true, forwardPct: 9 }),
        match({ ts: 1_650_000_000, distance: 0.3, forwardPct: 2.0 }),
        match({ ts: 1_600_000_000, distance: 0.5, forwardPct: -1.0 }),
        match({ ts: 1_550_000_000, distance: 0.7, forwardPct: null, forwardComplete: false }),
      ],
    });

  it("summarizes the matches excluding the selection row", () => {
    render(<PatternMatchesPanel {...props} result={statsResult()} loading={false} error={null} />);
    const strip = document.querySelector(".pm-stats")!;
    expect(strip.textContent).toContain("3");
    expect(strip.textContent).toContain("matches");
    // 1 of 2 outcomes up; the selection's +9% must not be in the figures.
    expect(strip.textContent).toContain("1/2");
    expect(strip.textContent).toContain("(50%)");
    expect(strip.textContent).toContain("+0.50%");
    // median distance over 0.3/0.5/0.7.
    expect(strip.textContent).toContain("0.50");
  });

  it("renders a lean chip when the outcomes are one-sided and the closest half agrees", () => {
    const res = result({
      matches: [
        match({ isSelection: true, forwardPct: 9 }),
        ...Array.from({ length: 12 }, (_, i) =>
          match({ ts: 1_600_000_000 + i, forwardPct: i === 11 ? -1 : 1 + i * 0.1 })
        ),
      ],
    });
    render(<PatternMatchesPanel {...props} result={res} loading={false} error={null} />);
    const chip = document.querySelector(".pm-verdict")!;
    expect(chip.textContent).toContain("lean: up");
    expect(chip.classList.contains("pm-verdict-up")).toBe(true);
  });

  it("renders the mixed chip on a coin-flip history", () => {
    const res = result({
      matches: Array.from({ length: 12 }, (_, i) =>
        match({ ts: 1_600_000_000 + i, forwardPct: i % 2 ? 1 : -1 })
      ),
    });
    render(<PatternMatchesPanel {...props} result={res} loading={false} error={null} />);
    expect(document.querySelector(".pm-verdict")!.textContent).toContain("mixed");
  });

  it("says the sample is too small rather than judging seven outcomes", () => {
    const res = result({
      matches: Array.from({ length: 7 }, (_, i) => match({ ts: 1_600_000_000 + i, forwardPct: 2 })),
    });
    render(<PatternMatchesPanel {...props} result={res} loading={false} error={null} />);
    expect(document.querySelector(".pm-verdict")!.textContent).toContain("small");
  });

  it("is absent while loading and when there are no matches", () => {
    render(<PatternMatchesPanel {...props} result={statsResult()} loading={true} error={null} />);
    expect(document.querySelector(".pm-stats")).toBeNull();
    cleanup();
    render(
      <PatternMatchesPanel
        {...props}
        result={result({ matches: [] })}
        loading={false}
        error={null}
      />,
    );
    expect(document.querySelector(".pm-stats")).toBeNull();
  });
});

describe("resizing", () => {
  it("drags the left-edge splitter to set the sidebar width", () => {
    render(<PatternMatchesPanel {...props} result={result()} loading={false} error={null} />);
    const panel = document.querySelector(".pattern-matches") as HTMLElement;
    // jsdom has no layout; give the panel its CSS default footprint.
    panel.getBoundingClientRect = () =>
      ({ width: 400, height: 300, top: 0, left: 600, right: 1000, bottom: 300 }) as DOMRect;
    const handle = panel.querySelector(".pm-resize")!;
    fireEvent.mouseDown(handle, { clientX: 600 });
    // Dragging 60px toward the chart widens the docked panel by 60.
    fireEvent.mouseMove(window, { clientX: 540 });
    expect(panel.style.width).toBe("460px");
  });

  it("stops tracking on mouseup and respects the minimum width", () => {
    render(<PatternMatchesPanel {...props} result={result()} loading={false} error={null} />);
    const panel = document.querySelector(".pattern-matches") as HTMLElement;
    panel.getBoundingClientRect = () =>
      ({ width: 400, height: 300, top: 0, left: 600, right: 1000, bottom: 300 }) as DOMRect;
    const handle = panel.querySelector(".pm-resize")!;
    fireEvent.mouseDown(handle, { clientX: 600 });
    // Dragging far into the panel clamps at the minimum instead of inverting.
    fireEvent.mouseMove(window, { clientX: 2000 });
    expect(panel.style.width).toBe("340px");
    fireEvent.mouseUp(window);
    fireEvent.mouseMove(window, { clientX: 500 });
    expect(panel.style.width).toBe("340px");
  });

  describe("layout-wide results", () => {
    const src = (cellId: string, epic: string, label: string, over: object = {}) => ({
      cellId, epic, resolution: "X", label,
      scanned: 1000, series: { oldestTs: 1_600_000_000, newestTs: NEWEST_TS, bars: 1001 },
      elapsedMs: 5, cold: false, error: null,
      ...over,
    });
    const merged = () =>
      result({
        matches: [
          match({ source: { cellId: "a", epic: "US100", resolution: "MINUTE_5", label: "5m" } }),
          match({
            ts: 1_700_000_300,
            source: { cellId: "b", epic: "GOLD", resolution: "MINUTE_15", label: "15m" },
          }),
        ],
        sources: [src("a", "US100", "5m"), src("b", "GOLD", "15m")],
      });

    it("offers the scope toggle and reports a change", () => {
      render(<PatternMatchesPanel {...props} result={result()} loading={false} error={null} />);
      const cell = screen.getByRole("button", { name: /only this chart/i });
      fireEvent.click(cell);
      expect(props.onScopeChange).toHaveBeenCalledWith("cell");
    });

    it("tags each row with the chart its match came from when results span charts", () => {
      render(<PatternMatchesPanel {...props} result={merged()} loading={false} error={null} />);
      expect(screen.getByText("US100 · 5m")).toBeTruthy();
      expect(screen.getByText("GOLD · 15m")).toBeTruthy();
    });

    it("shows no chart tags on a single-series result", () => {
      render(<PatternMatchesPanel {...props} result={result()} loading={false} error={null} />);
      expect(screen.queryByText(/US100 · /)).toBeNull();
    });

    it("folds the per-series footnotes away by default: one line per open chart dwarfs the results", () => {
      render(<PatternMatchesPanel {...props} result={merged()} loading={false} error={null} />);
      expect(screen.getByText(/2 charts on capital \(bid\)/)).toBeTruthy();
      expect(screen.queryByText(/US100 5m/)).toBeNull();
    });

    it("footnotes every searched series once unfolded, including one that failed", () => {
      const withError = result({
        matches: merged().matches,
        sources: [
          src("a", "US100", "5m"),
          src("b", "GOLD", "15m", {
            scanned: null, series: null, elapsedMs: null, error: "no stored history",
          }),
        ],
      });
      render(<PatternMatchesPanel {...props} result={withError} loading={false} error={null} />);
      fireEvent.click(screen.getByRole("button", { name: /2 charts on/ }));
      expect(screen.getByText(/US100 5m/)).toBeTruthy();
      expect(screen.getByText(/GOLD 15m: no stored history/)).toBeTruthy();
    });

    it("a failed series still surfaces on the folded summary line", () => {
      // Folding must not let a chart silently contribute nothing.
      const withError = result({
        matches: merged().matches,
        sources: [
          src("a", "US100", "5m"),
          src("b", "GOLD", "15m", {
            scanned: null, series: null, elapsedMs: null, error: "no stored history",
          }),
        ],
      });
      render(<PatternMatchesPanel {...props} result={withError} loading={false} error={null} />);
      expect(screen.getByText(/1 failed/)).toBeTruthy();
    });
  });
});
