// Apply-time identity signatures for the template MERGE (see
// docs/superpowers/specs/2026-07-02-template-apply-merge-design.md).
//
// "Is this template item already on the chart?" is answered by comparing
// signatures computed on the fly from the persisted shapes — nothing new is
// stored, so there's no schema change and no id to keep in sync. Signatures
// deliberately EXCLUDE styling (color/width/visible): an existing EMA(20) in red
// and the template's EMA(20) in blue are the SAME indicator, and Apply must skip
// it (existing wins), not duplicate or restyle it.
//
// Node-safe on purpose: no klinecharts imports (type-only import from persist),
// so templates.test.ts / this module's own tests run in the node env unmocked.

import type { SavedOverlay } from "./persist";

// extendData keys that do NOT identify an indicator — display/bookkeeping state,
// not inputs. A DENYLIST (not an allowlist) so a future input field (a new source
// mode, band setting, …) is identity-relevant by default instead of silently
// ignored. Keep in step with the fields applyIndicator/settings write:
//  - userVisible : the eye-toggle intent
//  - visibility  : the per-interval visibility model
//  - indType     : bookkeeping (mirrors the instance's type, already in the sig)
const NON_IDENTIFYING_EXTEND_KEYS = new Set(["userVisible", "visibility", "indType"]);

// The identity-relevant slice of extendData with deterministically-ordered keys.
// (Values are compared structurally via JSON; nested objects come from the same
// stored round-trip on both sides, so their key order is stable in practice.)
function identifyingExtend(
  extendData: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(extendData ?? {}).sort()) {
    if (!NON_IDENTIFYING_EXTEND_KEYS.has(k)) out[k] = extendData![k];
  }
  return out;
}

// Identity of one indicator instance. `calcParams` must be the EFFECTIVE params —
// the caller normalizes an absent saved value to the type's defaults (see
// savedIndicatorSignature in templates.ts) so a default-length EMA matches a
// default-length EMA. `anchor` is AVWAP's placed anchor (ms); undefined when
// unplaced or not an AVWAP.
export interface IndicatorIdentity {
  type: string;
  calcParams?: number[];
  extendData?: Record<string, unknown>;
  anchor?: number;
}

export function indicatorSignature(x: IndicatorIdentity): string {
  return JSON.stringify([
    x.type,
    x.calcParams ?? null,
    identifyingExtend(x.extendData),
    x.anchor ?? null,
  ]);
}

// Round to absorb float noise (a pixel→price conversion can yield
// 18000.000000000004 for a stored 18000) while never colliding two prices a
// real tick apart — display precisions are ≤ ~5 decimals.
const round = (n: number) => Number(n.toFixed(8));

// Drawing identity: tool type + geometry. A trendline at the same coordinates is
// the same line whatever its color; styles/lock/zLevel/visible are NOT identity.
export function drawingSignature(d: SavedOverlay): string {
  return JSON.stringify([
    d.name,
    d.points.map((p) => [
      p.timestamp != null ? round(p.timestamp) : null,
      p.dataIndex != null ? round(p.dataIndex) : null,
      p.value != null ? round(p.value) : null,
    ]),
  ]);
}
