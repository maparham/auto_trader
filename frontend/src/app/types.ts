// Shapes App passes to its hooks.
import type { Chart } from "klinecharts";
import type { ChartController } from "../lib/chartController";
import type { ChartTab } from "../lib/persist";

// Live chart instances + controllers, keyed by cell id (App's readyRef).
export type ReadyCells = Map<string, { chart: Chart; controller: ChartController }>;

// A ref App owns and keeps current; hooks only read (or advance) it.
export type Ref<T> = { current: T };

// The focused cell's live chart + controller (null until it mounts).
export type FocusedCell = { chart: Chart; controller: ChartController } | null;

// One-shot undo offer for the last merge or tab close. Merge: the pre-merge
// tab snapshot plus the scope moves to reverse. Close: just the closed tab,
// its old index and its purged keys; undo re-inserts that one tab into the
// CURRENT array, so edits made since (symbol/TF swaps elsewhere) survive.
export type PendingUndo = {
  prevTabs: ChartTab[];
  prevActiveId: string;
  pairs: Array<{ from: string; to: string }>;
  closed?: { tab: ChartTab; idx: number; purged: Array<[string, string]> };
  label: string;
  sigAfter: string;
  // The snackbar anchors under this chip: the merged tab, or the tab that
  // took the closed one's place (absent: top-center fallback).
  targetId: string;
};
