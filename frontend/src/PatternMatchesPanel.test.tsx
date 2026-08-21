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
    expect(screen.getAllByRole("button", { name: /go to/i })).toHaveLength(1);
    expect(screen.getByText("+4.17%")).toBeTruthy();
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

  it("closes on Escape", () => {
    const onDismiss = vi.fn();
    render(<PatternMatchesPanel {...props} onDismiss={onDismiss} result={result()} loading={false} error={null} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalled();
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
