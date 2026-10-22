// The Screener's unsaved draft and last completed result, kept in memory for
// the page session so closing the panel (or opening another side panel, which
// unmounts it) does not lose them. Keyed by broker: a draft built against one
// broker's catalogue (and a loaded screen's id) must not carry over to another,
// or Save would rewrite that screen under the wrong broker. Not persisted to
// localStorage on purpose; a reload starts clean.
import type { ScreenColumn, ScreenResult } from "./screens";

export interface ScreenerRanSpec { columns: ScreenColumn[]; resolution: string }

export interface ScreenerDraftState {
  currentId: string | null;
  name: string;
  resolution: string;
  symbolsText: string;
  expression: string;
  columns: ScreenColumn[];
  result: ScreenResult | null;
  ranSpec: ScreenerRanSpec | null;
}

export const EMPTY_SCREENER_DRAFT: ScreenerDraftState = {
  currentId: null,
  name: "",
  resolution: "DAY",
  symbolsText: "",
  expression: "",
  columns: [],
  result: null,
  ranSpec: null,
};

const drafts = new Map<string, ScreenerDraftState>();

export function getScreenerDraft(brokerId: string): ScreenerDraftState {
  return drafts.get(brokerId) ?? EMPTY_SCREENER_DRAFT;
}

export function setScreenerDraft(brokerId: string, state: ScreenerDraftState): void {
  drafts.set(brokerId, state);
}

/** Tests only: forget every broker's draft. */
export function resetScreenerDrafts(): void {
  drafts.clear();
}
