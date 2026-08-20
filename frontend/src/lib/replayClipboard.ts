// The one gate both "copy to the system clipboard" commands share.
//
// The system clipboard is a real disclosure channel: paste into any text editor
// and the JSON is right there in full. On a blind cell the payloads carry real
// epochs — a drawing's points ARE bar timestamps, and an indicator's config can
// hold one too (PREV_HL's anchor, the same field the settings panel masks).
//
// It lives here, rather than beside either caller, because the same drawing
// envelope is written from TWO places on purpose: ChartCore's Ctrl/Cmd+C
// (chart/useIndicatorCommands) and the drawing right-click menu (Toolbar), which
// are documented as interchangeable. Gating one and not the other is not a scope
// choice, it is a hole — the first review of this feature found exactly that.
// One import means a third copy path has to walk past this comment.
//
// Refused rather than redacted: stripping the timestamps leaves a payload that
// pastes to the wrong place (points fall back to dataIndex, a different bar on
// any other cell), and a copy that silently produces a misplaced drawing is
// worse than one that explains itself.
//
// MASKED, not merely replaying: an unmasked session has the real dates on its
// axis already, so a copy carrying them discloses nothing new. And per-cell, so
// a session on a sibling does not stop you copying from a live chart.

import { maskedReplayFor, maskedReplaySignal } from "./maskedReplay";
import { toast } from "./notify";

const MESSAGE = "Chart replay is running: exit the session to copy (a copy carries real dates).";

/** True when the copy must NOT happen; toasts the reason on its way out. */
export function refuseClipboardCopy(cellId: string): boolean {
  if (maskedReplayFor(maskedReplaySignal.value, cellId) == null) return false;
  toast(MESSAGE);
  return true;
}
