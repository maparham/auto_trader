// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import TradePills, { type TradePillItem } from "./TradePills";
import type { TradeView } from "../lib/trading";
import type { PendingEdit } from "../lib/signals";

// Two trades, each with an entry + TP pill, so overlap z-order (the "raised"
// trade-group class) can be asserted per pill.
const pill = (tradeId: string, field: TradePillItem["field"]): TradePillItem => ({
  tradeId,
  field,
  y: 100,
  kind: "position",
  side: "buy",
  qty: 1,
  level: 1.2345,
  expiresAt: null,
  pl: null,
  changed: false,
});

const PILLS: TradePillItem[] = [
  pill("A", "price"),
  pill("A", "tp"),
  pill("B", "price"),
  pill("B", "tp"),
];

function renderPills(over: Partial<Parameters<typeof TradePills>[0]> = {}) {
  const { container } = render(
    <TradePills
      pills={PILLS}
      precisionRef={{ current: 4 }}
      tradesRef={{ current: [] as TradeView[] }}
      pendingRef={{ current: {} as Record<string, PendingEdit> }}
      tradePillNodesRef={{ current: new Map() }}
      hoveredPillKey={null}
      focusedPillKey={null}
      selectedTradeId={null}
      tradePillLeft={10}
      {...over}
    />,
  );
  return { container };
}

const classesOf = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>(".trade-pill")).map((n) => n.className);

describe("TradePills trade-group raising", () => {
  it("raises every pill of the focused (selected) trade, not just the focused field", () => {
    const { container } = renderPills({ focusedPillKey: "A:price" });
    const [aEntry, aTp, bEntry, bTp] = classesOf(container);
    expect(aEntry).toContain("raised");
    expect(aEntry).toContain("focused");
    expect(aTp).toContain("raised"); // sibling pill of the selected trade rises too
    expect(aTp).not.toContain("focused");
    expect(bEntry).not.toContain("raised");
    expect(bTp).not.toContain("raised");
  });

  it("marks every pill of the click-selected trade with the selected class; hover alone doesn't", () => {
    const { container } = renderPills({ selectedTradeId: "A", focusedPillKey: "A:price", hoveredPillKey: "B:tp" });
    const [aEntry, aTp, bEntry, bTp] = classesOf(container);
    expect(aEntry).toContain("selected");
    expect(aTp).toContain("selected"); // whole trade group reads as selected
    expect(bEntry).not.toContain("selected");
    expect(bTp).not.toContain("selected"); // hovered ≠ selected
  });

  it("dims every other trade's pills while a trade is selected; none dimmed without a selection", () => {
    const { container } = renderPills({ selectedTradeId: "A", focusedPillKey: "A:price" });
    const [aEntry, aTp, bEntry, bTp] = classesOf(container);
    expect(aEntry).not.toContain("dimmed");
    expect(aTp).not.toContain("dimmed"); // the selected group stays at full strength
    expect(bEntry).toContain("dimmed");
    expect(bTp).toContain("dimmed");
    const none = renderPills({});
    expect(classesOf(none.container).some((c) => c.includes("dimmed"))).toBe(false);
  });

  it("raises the whole trade when one of its pills (e.g. TP) is hovered", () => {
    const { container } = renderPills({ hoveredPillKey: "B:tp" });
    const [aEntry, aTp, bEntry, bTp] = classesOf(container);
    expect(bTp).toContain("raised");
    expect(bTp).toContain("hovering");
    expect(bEntry).toContain("raised"); // associated entry pill rises with the hovered TP
    expect(aEntry).not.toContain("raised");
    expect(aTp).not.toContain("raised");
  });

  it("handles trade ids containing colons (splits on the LAST colon)", () => {
    const pills = [pill("deal:1", "price"), pill("deal:1", "tp")];
    const { container } = render(
      <TradePills
        pills={pills}
        precisionRef={{ current: 4 }}
        tradesRef={{ current: [] as TradeView[] }}
        pendingRef={{ current: {} as Record<string, PendingEdit> }}
        tradePillNodesRef={{ current: new Map() }}
        hoveredPillKey={"deal:1:tp"}
        selectedTradeId={null}
        focusedPillKey={null}
        tradePillLeft={10}
      />,
    );
    const [entry, tp] = classesOf(container);
    expect(entry).toContain("raised");
    expect(tp).toContain("raised");
  });
});

describe("TradePills overlap vertical spread", () => {
  const cascadeRender = (pills: TradePillItem[], over: Partial<Parameters<typeof TradePills>[0]> = {}) =>
    render(
      <TradePills
        pills={pills}
        precisionRef={{ current: 4 }}
        tradesRef={{ current: [] as TradeView[] }}
        pendingRef={{ current: {} as Record<string, PendingEdit> }}
        tradePillNodesRef={{ current: new Map() }}
        hoveredPillKey={null}
        selectedTradeId={null}
        focusedPillKey={null}
        tradePillLeft={10}
        {...over}
      />,
    ).container;

  it("spreads colliding pills vertically around the cluster's centre; separated pills keep their own y", () => {
    const container = cascadeRender([
      { ...pill("A", "price"), y: 100 },
      { ...pill("B", "price"), y: 110 }, // within 22px of A's entry → collides
      { ...pill("B", "tp"), y: 300 }, // far away → stays put
    ]);
    const tops = Array.from(container.querySelectorAll<HTMLElement>(".trade-pill")).map((n) => n.style.top);
    // cluster mean y = 105, 24px rows → column starts at 105 - 12 = 93
    expect(tops[0]).toBe("93px");
    expect(tops[1]).toBe("117px");
    expect(tops[2]).toBe("300px"); // non-colliding pill untouched
  });

  it("chains transitively: three stacked pills form one centred column", () => {
    const container = cascadeRender([
      { ...pill("A", "price"), y: 100 },
      { ...pill("B", "price"), y: 115 },
      { ...pill("C", "price"), y: 130 }, // clears A but collides with B → same cluster
    ]);
    const tops = Array.from(container.querySelectorAll<HTMLElement>(".trade-pill")).map((n) => n.style.top);
    // mean y = 115 → rows at 91 / 115 / 139
    expect(tops).toEqual(["91px", "115px", "139px"]);
  });

  it("shows a leader tick from the pill's edge to its line, only when the line clears the pill body", () => {
    // Four pills on one line → rows 64/88/112/136 around mean 100. The outer rows'
    // lines fall outside their 22px bodies (tick shown, edge→line); the inner rows
    // still cover the line (no tick). A far pill is undisplaced (no tick).
    const container = cascadeRender([
      { ...pill("A", "price"), y: 100 },
      { ...pill("B", "price"), y: 100 },
      { ...pill("C", "price"), y: 100 },
      { ...pill("D", "price"), y: 100 },
      { ...pill("D", "tp"), y: 300 },
    ]);
    const leaders = Array.from(container.querySelectorAll<HTMLElement>(".tp-leader"));
    expect(leaders).toHaveLength(5);
    expect(leaders[0].style.display).not.toBe("none"); // row 64: bottom edge 75 → line 100
    expect(leaders[0].style.top).toBe("75px");
    expect(leaders[0].style.height).toBe("25px");
    expect(leaders[1].style.display).toBe("none"); // row 88 still covers the line
    expect(leaders[2].style.display).toBe("none"); // row 112 still covers the line
    expect(leaders[3].style.display).not.toBe("none"); // row 136: line 100 → top edge 125
    expect(leaders[3].style.top).toBe("100px");
    expect(leaders[3].style.height).toBe("25px");
    expect(leaders[4].style.display).toBe("none"); // undisplaced pill
  });

  it("merges a neighbour that a spread column would collide with", () => {
    // A/B cluster alone would spread to 93/117; C at 135 is ≥22 from B's line but only
    // 18px from the 117 row — the second pass merges all three into one column
    // (mean 115 → rows 91/115/139).
    const container = cascadeRender([
      { ...pill("A", "price"), y: 100 },
      { ...pill("B", "price"), y: 110 },
      { ...pill("C", "price"), y: 135 },
    ]);
    const tops = Array.from(container.querySelectorAll<HTMLElement>(".trade-pill")).map((n) => n.style.top);
    expect(tops).toEqual(["91px", "115px", "139px"]);
  });

  it("clamps a spread column at the top of the pane", () => {
    // Mean 7.5 would start the column at -4.5; the clamp holds the first row at 11
    // (half a pill) so nothing renders above the pane edge.
    const container = cascadeRender([
      { ...pill("A", "price"), y: 5 },
      { ...pill("B", "price"), y: 10 },
    ]);
    const tops = Array.from(container.querySelectorAll<HTMLElement>(".trade-pill")).map((n) => n.style.top);
    expect(tops).toEqual(["11px", "35px"]);
  });
});
