// @vitest-environment jsdom
//
// pillsSig lets setPills skip a state update when nothing visible changed, but
// for an all-estimate bucket (moneyCount 0) `net` is always 0 and the pill's
// color comes from the estimates' own sign instead (toneValue). A signature
// that ignored that sign would hash two differently-signed all-estimate
// updates to the same bar identically, skip the re-render, and leave a stale
// win/loss color on screen — this pins that the sign flip IS picked up.
import { afterEach, describe, expect, it } from "vitest";
import { createRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import TradeExitAggMarkers, { type ExitPill, type TradeExitAggMarkersHandle } from "./TradeExitAggMarkers";
import type { JournalTrade } from "./lib/liveJournal";

afterEach(cleanup);

const estimateExit = (pnl: number): JournalTrade => ({
  ts: 1,
  epic: "OIL",
  leg: "long",
  entry: 70,
  exit: 70.5,
  quantity: 1,
  pnl,
  pnlIsMoney: false,
});

// Same key/position/count/net/moneyCount across both calls — only the
// estimate's sign differs, which is exactly the case the bug let through.
const pill = (estimatePnl: number): ExitPill => ({
  key: "exit-agg:1000",
  x: 10,
  y: 20,
  count: 1,
  net: 0,
  moneyCount: 0,
  exits: [estimateExit(estimatePnl)],
});

describe("TradeExitAggMarkers — all-estimate tone signature", () => {
  it("re-renders with the new tone when an all-estimate bucket's sign flips", () => {
    const ref = createRef<TradeExitAggMarkersHandle>();
    const { container } = render(<TradeExitAggMarkers handleRef={ref} />);

    act(() => ref.current!.setPills([pill(5)]));
    const bgWin = container.querySelector("span")!.style.background;

    act(() => ref.current!.setPills([pill(-5)]));
    const bgLoss = container.querySelector("span")!.style.background;

    expect(bgLoss).not.toBe(bgWin);
  });

  it("shows the exit count only for an all-estimate bucket, regardless of sign", () => {
    const ref = createRef<TradeExitAggMarkersHandle>();
    const { container } = render(<TradeExitAggMarkers handleRef={ref} />);
    act(() => ref.current!.setPills([pill(5)]));
    expect(container.querySelector("span")!.textContent).toBe("1");
  });
});
