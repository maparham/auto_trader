// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { WfoArchive } from "./WfoArchive";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const SUMMARIES: api.WfoArchiveSummary[] = [
  { id: "a", created_at: 1, epic: "EURUSD", timeframe: "HOUR", name: null, n_schemes: 1, robustness_score: 40.0, wfe_median: 0.3 },
  { id: "b", created_at: 2, epic: "EURUSD", timeframe: "HOUR", name: null, n_schemes: 2, robustness_score: 82.5, wfe_median: 0.8 },
  { id: "c", created_at: 3, epic: "GOLD", timeframe: "HOUR", name: null, n_schemes: 1, robustness_score: null, wfe_median: null },
];

describe("WfoArchive", () => {
  it("ranks by robustness score desc, nulls last", async () => {
    vi.spyOn(api, "listWfoArchives").mockResolvedValue(SUMMARIES);
    render(<WfoArchive onOpen={() => {}} />);
    await waitFor(() => expect(screen.getByText("82.5")).toBeTruthy());
    const rows = document.querySelectorAll(".wfo-arch-row");
    expect(rows[0].textContent).toContain("82.5");
    expect(rows[2].textContent).toContain("GOLD");
  });

  it("opens an archive on row click", async () => {
    vi.spyOn(api, "listWfoArchives").mockResolvedValue([SUMMARIES[1]]);
    const full = { id: "b", created_at: 2, epic: "EURUSD", timeframe: "HOUR", name: null, request: {}, result: { eval_mode: "sliced", objective: { metric: "sharpe", selection: "plateau" }, schedule: {}, axes: [], schemes: [] } };
    vi.spyOn(api, "getWfoArchive").mockResolvedValue(full as never);
    const onOpen = vi.fn();
    render(<WfoArchive onOpen={onOpen} />);
    await waitFor(() => screen.getByText("82.5"));
    fireEvent.click(document.querySelector(".wfo-arch-row")!);
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "b" })));
  });

  it("shows empty state", async () => {
    vi.spyOn(api, "listWfoArchives").mockResolvedValue([]);
    render(<WfoArchive onOpen={() => {}} />);
    await waitFor(() => expect(screen.getByText(/No walk-forward runs yet/)).toBeTruthy());
  });
});
