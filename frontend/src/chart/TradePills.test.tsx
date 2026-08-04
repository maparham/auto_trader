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
      hoveredPillRectKey={null}
      focusedPillKey={null}
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
        hoveredPillRectKey={null}
        focusedPillKey={null}
        tradePillLeft={10}
      />,
    );
    const [entry, tp] = classesOf(container);
    expect(entry).toContain("raised");
    expect(tp).toContain("raised");
  });
});
