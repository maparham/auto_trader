// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen, act, waitFor } from "@testing-library/react";
import { installMemStorage } from "./lib/testMemStorage";
import type { TradeRow } from "./lib/tradeList";

installMemStorage();

// The review stage checks sheet symbols against the broker catalogue and
// offers suggestions for unmatched ones — canned here.
vi.mock("./lib/feed", async (orig) => ({
  ...(await orig<typeof import("./lib/feed")>()),
  fetchAllMarkets: () =>
    Promise.resolve([
      { epic: "MSFT", name: "Microsoft", status: null },
      { epic: "AAPL", name: "Apple", status: null },
      { epic: "FOOX", name: "Foo Industries", status: null },
      { epic: "MA", name: "Mastercard", status: null },
      { epic: "LLY", name: "Eli Lilly", status: null },
      { epic: "IBIT", name: "iShares Bitcoin", status: null },
    ]),
  searchInstruments: () =>
    Promise.resolve([{ epic: "FOOX", name: "Foo Industries", status: null }]),
}));

const { default: TradeListPanel } = await import("./TradeListPanel");
const { listTradeLists } = await import("./lib/tradeList");
const { confirmRequest } = await import("./lib/signals");

afterEach(cleanup);
beforeEach(() => {
  installMemStorage();
  confirmRequest.set(null);
});

const SHEET = JSON.stringify({
  service: "The Swing Trader",
  sheet: "CLOSED-2026",
  trades: [
    {
      symbol: "MA", side: "SHORT",
      entryDate: "08/24/2026", entryPrice: "$597.07",
      exitDate: "09/04/2026", exitPrice: "$579.40",
      pctPL: "2.96%", dollarPL: "$3,534.00",
    },
    {
      symbol: "LLY", side: "LONG",
      entryDate: "08/19/2026", entryPrice: "$1,292.53",
      exitDate: "08/21/2026", exitPrice: "$1,228.50",
      pctPL: "-4.95%", dollarPL: "-$6,403.00",
    },
  ],
});

const BARE = JSON.stringify([
  {
    symbol: "IBIT", side: "LONG",
    entryDate: "08/05/2026", entryPrice: 36.45,
    exitDate: "08/19/2026", exitPrice: 39.03,
  },
]);

function paste(text: string) {
  fireEvent.change(screen.getByPlaceholderText(/paste/i), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: /^import$/i }));
}

// JSON imports park in the review stage like CSVs do (there's just no column
// mapping to correct), so tests about the LIBRARY confirm it in one step.
function importNow(text: string) {
  paste(text);
  fireEvent.click(screen.getByRole("button", { name: /^import \d+ trades?$/i }));
}


describe("TradeListPanel library", () => {
  it("a pasted import is saved under the sheet's label and opens its table", () => {
    render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    importNow(SHEET);
    // table view: rows + the list's name in the header strip
    expect(screen.getByText("MA")).toBeTruthy();
    expect(screen.getByText("The Swing Trader CLOSED-2026")).toBeTruthy();
    expect(listTradeLists().map((l) => l.name)).toEqual(["The Swing Trader CLOSED-2026"]);
  });

  it("a pasted import with no label gets a dated default name", () => {
    render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    importNow(BARE);
    expect(listTradeLists()[0].name).toMatch(/^Imported \d{4}-\d{2}-\d{2}$/);
  });

  it("a file import is named after the file minus its extension", async () => {
    const { container } = render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    const input = container.querySelector('input[type="file"]')!;
    const file = new File([SHEET], "smart-money-stocks-etfs-2026.json", {
      type: "application/json",
    });
    Object.defineProperty(file, "text", { value: () => Promise.resolve(SHEET) });
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(await screen.findByRole("button", { name: /^import 2 trades$/i }));
    expect(screen.getByText("MA")).toBeTruthy();
    expect(listTradeLists()[0].name).toBe("smart-money-stocks-etfs-2026");
  });

  it("back returns to the library, where the saved list reopens on click", () => {
    render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    importNow(SHEET);
    fireEvent.click(screen.getByRole("button", { name: /lists/i }));
    // library row: name + trade count; no table
    expect(screen.queryByText("MA")).toBeNull();
    expect(screen.getByText(/2 trades/)).toBeTruthy();
    fireEvent.click(screen.getByText("The Swing Trader CLOSED-2026"));
    expect(screen.getByText("MA")).toBeTruthy();
  });

  it("the library survives a remount (persisted permanently)", () => {
    const first = render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    importNow(SHEET);
    first.unmount();
    render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    expect(screen.getByText("The Swing Trader CLOSED-2026")).toBeTruthy();
  });

  it("renames a list from the library", () => {
    render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    importNow(SHEET);
    fireEvent.click(screen.getByRole("button", { name: /lists/i }));
    fireEvent.click(screen.getByRole("button", { name: /rename/i }));
    const input = screen.getByDisplayValue("The Swing Trader CLOSED-2026");
    fireEvent.change(input, { target: { value: "My swing trades" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("My swing trades")).toBeTruthy();
    expect(listTradeLists()[0].name).toBe("My swing trades");
  });

  it("deletes a list after the shared confirm", () => {
    render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    importNow(SHEET);
    fireEvent.click(screen.getByRole("button", { name: /lists/i }));
    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    // Nothing deleted yet — the shared confirm dialog owns the decision.
    expect(listTradeLists()).toHaveLength(1);
    act(() => confirmRequest.value!.onConfirm());
    expect(listTradeLists()).toHaveLength(0);
    expect(screen.queryByText("The Swing Trader CLOSED-2026")).toBeNull();
  });

  it("clicking a trade row hands the trade to onSelect", () => {
    const picked: TradeRow[] = [];
    render(<TradeListPanel onSelect={(t) => picked.push(t)} onClose={() => {}} />);
    importNow(SHEET);
    fireEvent.click(screen.getByText("MA"));
    expect(picked).toHaveLength(1);
    expect(picked[0].symbol).toBe("MA");
  });

  it("shows the parse error for junk input and keeps the import form", () => {
    render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    paste("not a trade list");
    expect(screen.getByText(/csv needs a header row/i)).toBeTruthy();
    expect(screen.getByPlaceholderText(/paste/i)).toBeTruthy();
    expect(listTradeLists()).toHaveLength(0);
  });

  it("filters the table by symbol, case-insensitive, and shows the filtered count", () => {
    render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    importNow(SHEET);
    fireEvent.change(screen.getByPlaceholderText(/filter/i), { target: { value: "ll" } });
    expect(screen.queryByText("MA")).toBeNull();
    expect(screen.getByText("LLY")).toBeTruthy();
    expect(screen.getByText(/1 of 2/)).toBeTruthy();
    // clearing restores every row and the plain count
    fireEvent.change(screen.getByPlaceholderText(/filter/i), { target: { value: "" } });
    expect(screen.getByText("MA")).toBeTruthy();
    expect(screen.getByText(/2 trades/)).toBeTruthy();
  });

  it("resets the symbol filter when another list is opened", () => {
    render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    importNow(SHEET);
    fireEvent.change(screen.getByPlaceholderText(/filter/i), { target: { value: "ll" } });
    fireEvent.click(screen.getByRole("button", { name: /lists/i }));
    importNow(BARE); // second import opens its own table
    expect(screen.getByText("IBIT")).toBeTruthy();
    expect((screen.getByPlaceholderText(/filter/i) as HTMLInputElement).value).toBe("");
  });

  it("sorts the table by a column when its header is clicked", () => {
    render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    importNow(SHEET);
    const symbolsInOrder = () =>
      screen.getAllByRole("row").slice(1).map((r) => r.querySelector("td")?.textContent);
    expect(symbolsInOrder()).toEqual(["MA", "LLY"]);
    fireEvent.click(screen.getByRole("button", { name: /% P\/L/ }));
    fireEvent.click(screen.getByRole("button", { name: /% P\/L/ }));
    expect(symbolsInOrder()).toEqual(["LLY", "MA"]);
  });

  it("interprets naive datetimes in the dropdown timezone (default UTC)", () => {
    const TIMED = JSON.stringify([
      {
        symbol: "MA", side: "LONG",
        entryDate: "08/10/2026 09:45", entryPrice: 1,
        exitDate: "08/10/2026 15:30", exitPrice: 2,
      },
    ]);
    render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    const tzSelect = screen.getByLabelText(/timezone/i) as HTMLSelectElement;
    expect(tzSelect.value).toBe("UTC");
    importNow(TIMED);
    expect(listTradeLists()[0].trades[0].entryTs).toBe(Date.UTC(2026, 7, 10, 9, 45));
    // second import, parsed as New York wall-clock (EDT, UTC-4)
    fireEvent.click(screen.getByRole("button", { name: /lists/i }));
    fireEvent.change(screen.getByLabelText(/timezone/i), {
      target: { value: "America/New_York" },
    });
    importNow(TIMED);
    expect(listTradeLists()[0].trades[0].entryTs).toBe(Date.UTC(2026, 7, 10, 13, 45));
    expect(listTradeLists()[0].timezone).toBe("America/New_York");
  });

  it("Auto TF toggle is on by default and persists when switched off", async () => {
    const { loadAutoTf } = await import("./lib/tradeList");
    const first = render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    importNow(SHEET);
    const toggle = screen.getByRole("button", { name: /auto tf/i });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(loadAutoTf()).toBe(false);
    first.unmount();
    render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByText("The Swing Trader CLOSED-2026"));
    expect(
      screen.getByRole("button", { name: /auto tf/i }).getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("Same tab toggle is on by default and persists when switched off", async () => {
    const { loadSameTab } = await import("./lib/tradeList");
    render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    importNow(SHEET);
    const toggle = screen.getByRole("button", { name: /same tab/i });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(loadSameTab()).toBe(false);
  });

  it("shows the full timestamp for timed trades, in the list's import timezone", () => {
    const TIMED = JSON.stringify([
      {
        symbol: "MA", side: "LONG",
        entryDate: "08/10/2026 09:45", entryPrice: 1,
        exitDate: "08/10/2026 15:30", exitPrice: 2,
      },
    ]);
    render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText(/timezone/i), {
      target: { value: "America/New_York" },
    });
    importNow(TIMED);
    // displayed as the sheet's own wall-clock, not shifted to UTC
    expect(screen.getByText("2026-08-10 09:45")).toBeTruthy();
    expect(screen.getByText("2026-08-10 15:30")).toBeTruthy();
  });

  it("date-only trades keep showing just the date", () => {
    render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    importNow(SHEET);
    expect(screen.getByText("2026-08-24")).toBeTruthy();
    expect(screen.queryByText(/2026-08-24 00:00/)).toBeNull();
  });

  it("a clicked row stays highlighted until another row is clicked", () => {
    render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    importNow(SHEET);
    const rowOf = (sym: string) => screen.getByText(sym).closest("tr")!;
    expect(document.querySelector(".tl-selected")).toBeNull();
    fireEvent.click(screen.getByText("MA"));
    expect(rowOf("MA").className).toContain("tl-selected");
    fireEvent.click(screen.getByText("LLY"));
    expect(rowOf("LLY").className).toContain("tl-selected");
    expect(rowOf("MA").className).not.toContain("tl-selected");
    // sorting must not lose the selection (identity, not display position)
    fireEvent.click(screen.getByRole("button", { name: /% P\/L/ }));
    expect(rowOf("LLY").className).toContain("tl-selected");
  });

  it("✕ calls onClose", () => {
    const onClose = vi.fn();
    render(<TradeListPanel onSelect={() => {}} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("TradeListPanel CSV mapping review", () => {
  const CSV = [
    "Ticker,Side,Entry Date,Entry Price,Exit Date,Exit Price,Qty,Profit $",
    "MSFT,LONG,2026-08-10,500,2026-08-12,510,10,100",
    "AAPL,SHORT,2026-08-11,230,2026-08-13,225,5,25",
  ].join("\n");

  const colSelect = (header: string) =>
    screen.getByLabelText(`Map column "${header}"`) as HTMLSelectElement;

  it("a pasted CSV opens the mapping review instead of importing directly", () => {
    render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    paste(CSV);
    expect(listTradeLists()).toHaveLength(0); // nothing saved yet
    expect(colSelect("Ticker").value).toBe("symbol"); // guess preselected
    expect(colSelect("Qty").value).toBe("qty");
    expect(colSelect("Profit $").value).toBe("dollarPL");
    expect(screen.getByText("MSFT")).toBeTruthy(); // sample values shown
  });

  it("confirming the review imports with the (corrected) mapping", () => {
    render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    paste(CSV);
    // deliberately mis-map $ P/L onto Qty, ignore Profit $
    fireEvent.change(colSelect("Profit $"), { target: { value: "" } });
    fireEvent.change(colSelect("Qty"), { target: { value: "dollarPL" } });
    fireEvent.click(screen.getByRole("button", { name: /import 2 trades/i }));
    const saved = listTradeLists()[0];
    expect(saved.trades[0].dollarPL).toBe(10); // Qty column, per correction
    expect(screen.getByText("MSFT")).toBeTruthy(); // landed in the table
  });

  it("an invalid mapping disables the import and names the problem", () => {
    render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    paste(CSV);
    fireEvent.change(colSelect("Ticker"), { target: { value: "" } });
    const btn = screen.getByRole("button", { name: /^import \d+ trades?$/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(/not mapped to any column: Symbol/i)).toBeTruthy();
  });

  it("cancel discards the review without saving", () => {
    render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    paste(CSV);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(listTradeLists()).toHaveLength(0);
    expect(screen.getByPlaceholderText(/paste/i)).toBeTruthy(); // back on the form
  });

  it("the timezone can still be changed in the review stage", () => {
    const TIMED = [
      "Ticker,Side,Entry Date,Entry Price,Exit Date,Exit Price",
      "MSFT,LONG,2026-08-10 09:30,500,2026-08-12 16:00,510",
    ].join("\n");
    render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    paste(TIMED);
    fireEvent.change(screen.getByLabelText(/timezone/i), {
      target: { value: "America/New_York" },
    });
    fireEvent.click(screen.getByRole("button", { name: /import 1 trade/i }));
    const saved = listTradeLists()[0];
    expect(saved.trades[0].entryTs).toBe(Date.UTC(2026, 7, 10, 13, 30)); // 09:30 EDT
    expect(saved.timezone).toBe("America/New_York");
  });

  it("a CSV file import reviews too and keeps the filename-derived name", async () => {
    const { container } = render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    const input = container.querySelector('input[type="file"]')!;
    const file = new File([CSV], "my-trades-2026.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { value: () => Promise.resolve(CSV) });
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(await screen.findByRole("button", { name: /import 2 trades/i }));
    expect(listTradeLists()[0].name).toBe("my-trades-2026");
  });

  it("JSON opens the review too, with no column mapping to correct", () => {
    render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    paste(SHEET);
    expect(listTradeLists()).toHaveLength(0); // review first, nothing saved
    expect(screen.queryByLabelText(/^Map column/)).toBeNull(); // keys are exact
    fireEvent.click(screen.getByRole("button", { name: /import 2 trades/i }));
    expect(listTradeLists()).toHaveLength(1);
  });
});

describe("TradeListPanel symbol mapping in review", () => {
  const CSV2 = [
    "Ticker,Side,Entry Date,Entry Price,Exit Date,Exit Price",
    "MSFT,LONG,2026-08-10,500,2026-08-12,510",
    "FOO,SHORT,2026-08-11,230,2026-08-13,225",
  ].join("\n");

  it("checks symbols against the catalogue and remaps unmatched ones", async () => {
    const picked: TradeRow[] = [];
    render(<TradeListPanel onSelect={(t) => picked.push(t)} onClose={() => {}} />);
    paste(CSV2);
    // MSFT matches the (mocked) catalogue; FOO doesn't.
    expect(await screen.findByText(/1 of 2 symbols match a market/i)).toBeTruthy();
    const input = screen.getByLabelText('Map symbol "FOO"') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "FOOX" } });
    fireEvent.click(screen.getByRole("button", { name: /import 2 trades/i }));
    // map persisted on the saved list; table still shows the sheet's symbol
    expect(listTradeLists()[0].symbolMap).toEqual({ FOO: "FOOX" });
    expect(screen.getByText("FOO")).toBeTruthy();
    // clicking the row hands App the MAPPED epic
    fireEvent.click(screen.getByText("FOO"));
    expect(picked[0].symbol).toBe("FOOX");
  });

  it("all-matched sheets show the quiet line and no mapping inputs", async () => {
    const ALL = [
      "Ticker,Side,Entry Date,Entry Price,Exit Date,Exit Price",
      "MSFT,LONG,2026-08-10,500,2026-08-12,510",
      "AAPL,SHORT,2026-08-11,230,2026-08-13,225",
    ].join("\n");
    render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    paste(ALL);
    expect(await screen.findByText(/2 of 2 symbols match a market/i)).toBeTruthy();
    expect(screen.queryByLabelText(/^Map symbol/)).toBeNull();
  });

  it("an unmatched symbol left blank imports unmapped", async () => {
    render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    paste(CSV2);
    await screen.findByLabelText('Map symbol "FOO"');
    fireEvent.click(screen.getByRole("button", { name: /import 2 trades/i }));
    expect(listTradeLists()[0].symbolMap).toBeUndefined();
  });
});

describe("TradeListPanel symbol remap autocomplete", () => {
  const CSV3 = [
    "Ticker,Side,Entry Date,Entry Price,Exit Date,Exit Price",
    "FOO,LONG,2026-08-10,500,2026-08-12,510",
  ].join("\n");

  it("typing live-filters the broker catalogue into the suggestions", async () => {
    render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    paste(CSV3);
    const input = await screen.findByLabelText('Map symbol "FOO"');
    const options = () =>
      Array.from(document.querySelectorAll('datalist[id="tl-sym-FOO"] option')).map(
        (o) => (o as HTMLOptionElement).value,
      );
    fireEvent.change(input, { target: { value: "AAP" } });
    expect(options()).toEqual(["AAPL"]); // epic match from the catalogue
    fireEvent.change(input, { target: { value: "micro" } });
    expect(options()).toEqual(["MSFT"]); // name match ("Microsoft"), case-insensitive
  });
});

describe("TradeListPanel rows without a market", () => {
  it("disables rows whose symbol (after mapping) is not in the catalogue", async () => {
    const picked: TradeRow[] = [];
    render(<TradeListPanel onSelect={(t) => picked.push(t)} onClose={() => {}} />);
    importNow(JSON.stringify([
      {
        symbol: "ZZZ", side: "LONG",
        entryDate: "08/05/2026", entryPrice: 10, exitDate: "08/19/2026", exitPrice: 12,
      },
      {
        symbol: "MSFT", side: "LONG",
        entryDate: "08/05/2026", entryPrice: 500, exitDate: "08/19/2026", exitPrice: 510,
      },
    ]));
    const zzzRow = screen.getByText("ZZZ").closest("tr")!;
    await waitFor(() => expect(zzzRow.className).toContain("tl-dead"));
    fireEvent.click(screen.getByText("ZZZ"));
    expect(picked).toHaveLength(0); // no market: no jump
    expect(zzzRow.className).not.toContain("tl-selected");
    fireEvent.click(screen.getByText("MSFT"));
    expect(picked).toHaveLength(1); // known symbol still jumps
  });
});

describe("TradeListPanel qty and drawdown columns", () => {
  const WITH_QTY = JSON.stringify([
    {
      symbol: "MSFT", side: "LONG",
      entryDate: "08/05/2026", entryPrice: 100, exitDate: "08/19/2026", exitPrice: 110,
      qty: 35, ddPct: -0.34, dollarPL: 218.3,
    },
  ]);

  it("shows Qty and DD % columns when the list carries them, with derived % P/L", () => {
    render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    importNow(WITH_QTY);
    expect(screen.getByText("Qty")).toBeTruthy();
    expect(screen.getByText("DD %")).toBeTruthy();
    expect(screen.getByText("35")).toBeTruthy();
    expect(screen.getByText("-0.34%")).toBeTruthy();
    expect(screen.getByText("6.24%")).toBeTruthy(); // 218.3 over 35×100
  });

  it("hides the columns for lists without qty or drawdown", () => {
    render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    importNow(SHEET);
    expect(screen.queryByText("Qty")).toBeNull();
    expect(screen.queryByText("DD %")).toBeNull();
  });
});

describe("TradeListPanel dollar totals", () => {
  // Sheets that report only a percentage (every Smart Money year before 2026)
  // carry no dollarPL at all; summing them to $0.00 reads as "broke even".
  const PCT_ONLY = JSON.stringify({
    trades: [
      { symbol: "MSFT", side: "LONG", entryDate: "08/10/2026", entryPrice: "$500",
        exitDate: "08/12/2026", exitPrice: "$510", pctPL: "+2.00%" },
    ],
  });

  it("dashes the total when no trade reports a dollar P/L", () => {
    render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    importNow(PCT_ONLY);
    fireEvent.click(screen.getByRole("button", { name: /lists/i }));
    expect(screen.queryByText(/\$0\.00/)).toBeNull();
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("still totals dollars when the sheet reports them", () => {
    render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    importNow(SHEET);
    fireEvent.click(screen.getByRole("button", { name: /lists/i }));
    expect(screen.getByText(/-\$2,869\.00/)).toBeTruthy(); // 3534 - 6403
  });
});

describe("TradeListPanel degenerate-row review", () => {
  // One clean row, one reversed (exit before entry), one $0.00 exit, one
  // unparseable banner row — a compressed version of a real closed-trades sheet.
  const MESSY = JSON.stringify({
    trades: [
      { symbol: "MA", side: "SHORT", entryDate: "08/24/2026", entryPrice: "$597.07",
        exitDate: "09/04/2026", exitPrice: "$579.40" },
      { symbol: "AXP", side: "SHORT", entryDate: "08/29/2025", entryPrice: "$342.45",
        exitDate: "02/13/2025", exitPrice: "$336.35" },
      { symbol: "RSX", side: "LONG", entryDate: "03/01/2022", entryPrice: "$8.02",
        exitDate: "01/12/2023", exitPrice: "$0.00" },
      { symbol: "Tax Selling", side: "To Offset", entryDate: "Huge 2020",
        entryPrice: "Profits", exitDate: "Tax Bill", exitPrice: "And Reduce" },
    ],
  });

  it("excludes every flagged category by default and counts what will import", () => {
    render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    paste(MESSY);
    expect(screen.getByRole("button", { name: /import 1 trade\b/i })).toBeTruthy();
  });

  it("keeping a category puts its rows back in the count and the import", () => {
    render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    paste(MESSY);
    fireEvent.click(screen.getByLabelText(/non-positive price/i));
    fireEvent.click(screen.getByRole("button", { name: /import 2 trades/i }));
    expect(listTradeLists()[0].trades.map((t) => t.symbol)).toEqual(["MA", "RSX"]);
  });

  it("records the excluded reasons on the saved list", () => {
    render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    paste(MESSY);
    fireEvent.click(screen.getByRole("button", { name: /import 1 trade\b/i }));
    expect(listTradeLists()[0].excluded).toEqual([
      { reason: "unparseable", count: 1 },
      { reason: "reversed", count: 1 },
      { reason: "nonPositivePrice", count: 1 },
    ]);
  });

  it("lists the offending rows so they can be eyeballed before dropping", () => {
    render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    paste(MESSY);
    expect(screen.getByText("AXP SHORT 2025-08-29 → 2025-02-13")).toBeTruthy();
    expect(screen.getByText("Tax Selling / To Offset / Huge 2020 / Profits")).toBeTruthy();
  });

  it("says 'row' when a category has a single offender", () => {
    render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    paste(MESSY);
    expect(screen.getByLabelText("1 unparseable row")).toBeTruthy();
    expect(screen.getByLabelText("1 row exiting before it enters")).toBeTruthy();
  });

  it("shows no flagged block for a clean sheet", () => {
    const { container } = render(<TradeListPanel onSelect={() => {}} onClose={() => {}} />);
    paste(SHEET);
    expect(container.querySelector(".tl-flagged")).toBeNull();
  });
});
