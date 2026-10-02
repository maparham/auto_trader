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

// One-shot undo offer for the last merge or tab close: the pre-gesture tab
// snapshot plus the storage to put back (merge: scope moves to reverse;
// close: the closed tab's purged keys).
export type PendingUndo = {
  prevTabs: ChartTab[];
  prevActiveId: string;
  pairs: Array<{ from: string; to: string }>;
  purged?: Array<[string, string]>;
  label: string;
  sigAfter: string;
  // The snackbar anchors under this chip: the merged tab, or the tab that
  // took the closed one's place (absent: top-center fallback).
  targetId: string;
};
