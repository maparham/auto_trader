// The dealing confirm gate: a confirm-kind action's execution is parked here
// until the user clicks Approve or Reject in the browser (AgentConfirmHost),
// or the timeout elapses (counts as Reject). One pending request at a time:
// a second concurrent ask auto-rejects so an agent can't queue-stack prompts.
import { Signal } from "../lib/signals";

export interface AgentConfirmState {
  action: string;
  description: string;
  args: Record<string, unknown>;
}

export const agentConfirmSignal = new Signal<AgentConfirmState | null>(null);

const DEFAULT_TIMEOUT_MS = 120_000;

interface Pending {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Drops the abort listener so a settled request stops watching its signal. */
  cleanup: () => void;
}

let pending: Pending | null = null;

export function requestAgentConfirm(req: {
  action: string;
  description: string;
  args: Record<string, unknown>;
  timeoutMs?: number;
  /** Aborting dismisses the dialog as rejected: see the abort note below. */
  signal?: AbortSignal;
}): Promise<boolean> {
  if (pending) return Promise.resolve(false);
  // Already-aborted invocations never park a dialog in the first place.
  if (req.signal?.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolveAgentConfirm(false), req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    // An aborted invocation (op:"abort", or the bridge draining on socket close)
    // has already been reported to the agent as failed. Dismissing the dialog
    // here is what stops a later Approve from executing the order anyway.
    // Guarded on identity: a request that already settled must not reject
    // whichever dialog happens to be open now.
    const onAbort = () => { if (pending === entry) resolveAgentConfirm(false); };
    const entry: Pending = {
      resolve, timer,
      cleanup: () => req.signal?.removeEventListener("abort", onAbort),
    };
    pending = entry;
    req.signal?.addEventListener("abort", onAbort);
    agentConfirmSignal.set({ action: req.action, description: req.description, args: req.args });
  });
}

export function resolveAgentConfirm(approved: boolean): void {
  if (!pending) return;
  clearTimeout(pending.timer);
  const { resolve, cleanup } = pending;
  pending = null;
  cleanup();
  agentConfirmSignal.set(null);
  resolve(approved);
}
