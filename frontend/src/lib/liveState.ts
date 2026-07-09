import type { BacktestConfig } from "./backtestConfig";
import type { CodedStrategyConfig } from "./codedConfig";

export type LiveStatus = "disarmed" | "armed" | "lost-lease";

export interface ArmedSnapshot {
  strategyId: string;
  cfg: BacktestConfig;
  account: string;
  quantity: number;
  armedAtSec: number;
  // Coded mode only: the LIVE coded set (params/risk/exit groups) frozen at arm
  // time — every evaluate cycle reads THIS, never a live-reloaded value, so
  // editing the live panel while armed can't silently change a running trade
  // (surfaced instead via codedCfgsDiffer against the snapshot in the panel).
  coded?: CodedStrategyConfig;
}

export interface LiveLogEntry {
  ts: number;
  text: string;
}

export interface LiveState {
  status: LiveStatus;
  snapshot: ArmedSnapshot | null;
  draft: BacktestConfig;
  account: string;
  quantity: number;
  pendingEdits: boolean;
  positionVintage: ArmedSnapshot | null;
  lastEvalSec: number | null;
  log: LiveLogEntry[];
}

// Deep copy of a config so a frozen snapshot can't be mutated via the draft.
// BacktestConfig is plain JSON (rules/operands are flat value objects), so a
// structured clone is a full copy.
function freeze(cfg: BacktestConfig): BacktestConfig {
  return structuredClone(cfg);
}

export function initialLiveState(
  draft: BacktestConfig,
  account: string,
  quantity: number,
): LiveState {
  return {
    status: "disarmed",
    snapshot: null,
    draft,
    account,
    quantity,
    pendingEdits: false,
    positionVintage: null,
    lastEvalSec: null,
    log: [],
  };
}

export function armSnapshot(
  state: LiveState,
  strategyId: string,
  armedAtSec: number,
  coded?: CodedStrategyConfig,
): LiveState {
  const snapshot: ArmedSnapshot = {
    strategyId,
    cfg: freeze(state.draft),
    account: state.account,
    quantity: state.quantity,
    armedAtSec,
    coded: coded ? structuredClone(coded) : undefined,
  };
  return { ...state, status: "armed", snapshot, pendingEdits: false };
}

export function disarm(state: LiveState): LiveState {
  return { ...state, status: "disarmed", snapshot: null, pendingEdits: false, positionVintage: null };
}

export function editDraft(state: LiveState, cfg: BacktestConfig): LiveState {
  const pendingEdits = state.status === "armed";
  return { ...state, draft: cfg, pendingEdits };
}

export function markLost(state: LiveState): LiveState {
  return { ...state, status: "lost-lease" };
}

export function setPositionVintage(state: LiveState, vintage: ArmedSnapshot | null): LiveState {
  return { ...state, positionVintage: vintage };
}

export function appendLog(state: LiveState, ts: number, text: string): LiveState {
  return { ...state, log: [...state.log, { ts, text }].slice(-200) };
}

/** The rules the engine should act under RIGHT NOW: while a position is open it
 *  finishes under the snapshot it was opened with (its vintage); otherwise the
 *  current armed snapshot governs (new entries). Spec: re-arm affects only future
 *  entries. */
export function activeRules(state: LiveState): ArmedSnapshot | null {
  return state.positionVintage ?? state.snapshot;
}
