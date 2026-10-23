// The one open "which output?" chooser for a pick from chart. A pick whose
// pane offers several sensible outputs (an RSI pane with divergence on) sets
// this instead of inserting; PickChoiceHost shows the menu at the click point
// and calls onChoose with the token the user picks. One shared signal, so the
// backtest and screener panels need no menu of their own.
import type { PickChoice } from "./exprChartToken";
import { Signal } from "./signals";

export interface PickChoiceRequest {
  options: PickChoice[];
  onChoose: (token: string) => void;
}

export const pickChoiceRequest = new Signal<PickChoiceRequest | null>(null);
