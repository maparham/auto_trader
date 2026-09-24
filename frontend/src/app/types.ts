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

// One-shot undo offer for the last merge: the pre-merge snapshot plus the
// scope moves to reverse.
export type PendingUndo = {
  prevTabs: ChartTab[];
  prevActiveId: string;
  pairs: Array<{ from: string; to: string }>;
  label: string;
  sigAfter: string;
  targetId: string; // the merged tab — the snackbar anchors under its chip
};
