// Shape of a built-in strategy's illustrated guide. The parameter table is NOT
// part of the guide — StrategyGuideModal builds it from the strategy's live
// `meta` params so it can never drift from the code.

import type { ReactNode } from "react";

export interface GuideSection {
  heading: string;
  /** Paragraphs (plain strings) or richer nodes. */
  body: ReactNode;
  /** Optional SVG diagram illustrating this section. */
  diagram?: ReactNode;
}

export interface StrategyGuide {
  /** One-line framing under the title. */
  tagline: string;
  sections: GuideSection[];
}
