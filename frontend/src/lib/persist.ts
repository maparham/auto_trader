// Typed localStorage helpers for chart state that survives a refresh.
//
// This module has been split into focused files under ./persist/; it stays a
// barrel so its many importers keep a single stable import path. See:
//  - persist/core       : broker keying, backend mirror, load/save, hydration,
//                         live updates, per-cell scope helpers
//  - persist/workspace  : chart tabs + cells, tab merge, named layouts
//  - persist/artifacts  : per-cell drawings/indicators/backtest/avwap + prefs
//  - persist/defaults   : global indicator/drawing defaults & presets, backtest
//                         configs, symbol/default templates
//  - persist/alerts     : price alerts + triggered-alert history

export * from "./persist/core";
export * from "./persist/workspace";
export * from "./persist/artifacts";
export * from "./persist/defaults";
export * from "./persist/alerts";
