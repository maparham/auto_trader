// The two "Buy limit at X" / "Sell limit at X" entries shared by the chart's
// axis "+" menu and its empty-chart right-click menu.
//
// Lifted out of ChartCore because of what they do during a REPLAY session.
// `stageChartOrder` drafts into the app's real OrderTicket, which submits to the
// broker — so a user practising blind could read a level off a bar from two
// years ago, pick "Buy limit at ...", press Submit, and end up with a live order
// resting against their account at a price with no relationship to the current
// market. That is the one path on this feature that costs real money, and
// neither menu can see that the cell is replaying, so the decision belongs
// somewhere both of them go through.
//
// Pure and parameterised on its two sinks, which is the other half of the point:
// a useCallback buried in ChartCore cannot be tested, and "the menu quietly does
// the right thing" is exactly the kind of claim that needs a test rather than a
// reading.
import type { MenuItem } from "../ContextMenu";
import type { ReplayApi } from "../chart/useReplay";
import type { OrderSide } from "./trading";

export interface LimitItemDeps {
  /** Level already quantized to instrument precision, and its display form. */
  level: number;
  label: string;
  /** This cell's session. `canTrade` is false while the cursor is rewound. */
  replay: { active: boolean; canTrade: boolean };
  /** Stage a REAL broker draft into the app's order ticket. */
  stage(a: { side: OrderSide; price: number }): void;
  /** Write into this cell's replay ledger instead. */
  place: ReplayApi["place"];
  icons: { buy: MenuItem["icon"]; sell: MenuItem["icon"] };
}

export function limitOrderItems(d: LimitItemDeps): MenuItem[] {
  const item = (side: OrderSide): MenuItem => {
    const base = {
      label: `${side === "buy" ? "Buy" : "Sell"} limit at ${d.label}`,
      icon: side === "buy" ? d.icons.buy : d.icons.sell,
    };
    if (!d.replay.active) {
      return { ...base, onClick: () => d.stage({ side, price: d.level }) };
    }
    if (!d.replay.canTrade) {
      // Shown-but-unavailable rather than omitted. A menu that silently loses two
      // rows while rewound reads as a glitch and teaches the user nothing; the
      // reason says the same thing the ticket's own rewound note does. Offering a
      // live-looking item that no-ops would be the worst of the three.
      return {
        ...base,
        onClick: () => {},
        disabled: true,
        disabledReason: "Rewound: step forward to the latest replayed bar to trade.",
      };
    }
    return {
      ...base,
      onClick: () =>
        d.place({
          side,
          quantity: 1,
          type: "limit",
          price: d.level,
          stop: null,
          takeProfit: null,
        }),
    };
  };
  return [item("buy"), item("sell")];
}
