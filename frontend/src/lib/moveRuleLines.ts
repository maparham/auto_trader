// On-chart lines for SL/TP move rules: a dashed trigger line per rule (and a faint
// target line when the rule moves the level to a price). Drawn by PositionLines
// next to the trade lines, from two sources: the order ticket's Move SL / Move TP
// draft (moveDraftSignal, only `on` fields) and the saved price-trigger rules of
// positions on the epic. Both kinds are draggable: a draft drag writes the draft
// (the ticket follows), a saved drag shows a local override until the drop
// patches the rule.
import type { AlertCondition, MoveRule, MoveTarget } from "./alertsApi";
import { loadMoveRules, patchMoveRule } from "./alertsApi";
import { toast } from "./notify";
import { setMoveLevel, type MoveDraftState } from "./moveRuleDraft";
import { DRAFT_LABEL_X_FALLBACK, STOP_COLOR, TP_COLOR, type LineSpec } from "./positionLines";
import { Signal, type TradeLineField } from "./signals";

export const MOVE_PREFIX = "move:";
const DRAFT_KEY = "draft";

type Field = "sl" | "tp";
type Which = "trigger" | "target";

/** Saved-rule line levels while their drag is in flight, by line id. */
export const moveLineOverrides = new Signal<Record<string, number>>({});

/** A trade line key as id + field. Trade keys split at the last ":"
 *  (`D1:stop`); a move line keeps its whole key as the id, field "price". */
export function parseTradeLineKey(key: string): { id: string; field: TradeLineField } {
  if (key.startsWith(MOVE_PREFIX)) return { id: key, field: "price" };
  const sep = key.lastIndexOf(":");
  return { id: key.slice(0, sep), field: key.slice(sep + 1) as TradeLineField };
}

function moveLineId(ruleKey: string, field: Field, which: Which): string {
  return `${MOVE_PREFIX}${ruleKey}:${field}:${which}`;
}

/** `move:<ruleKey>:<field>:<which>` parts; ruleKey may itself hold ":". */
function parseMoveLineId(id: string): { ruleKey: string; field: Field; which: Which } | null {
  if (!id.startsWith(MOVE_PREFIX)) return null;
  const parts = id.slice(MOVE_PREFIX.length).split(":");
  if (parts.length < 3) return null;
  const which = parts.pop() as Which;
  const field = parts.pop() as Field;
  if ((field !== "sl" && field !== "tp") || (which !== "trigger" && which !== "target")) return null;
  return { ruleKey: parts.join(":"), field, which };
}

function arrow(c: AlertCondition | undefined): string {
  if (c === "crossing_up" || c === "greater") return "↑";
  if (c === "crossing_down" || c === "less") return "↓";
  return "↕";
}

/** One line of rule text: `Move SL to BE when ↑ 1.1050` (indicator and line rules
 *  name their `label`). Used by the position row tooltip and the Alerts sidebar. */
export function moveRuleText(rule: MoveRule): string {
  const { field, target } = rule.action;
  const tgt = target.type === "price"
    ? target.value.toFixed(rule.precision)
    : target.offset > 0 ? `BE+${target.offset}` : "BE";
  let when: string;
  if (rule.triggerKind === "price_level") {
    const level = Number(rule.params.level);
    const lv = Number.isFinite(level) ? level.toFixed(rule.precision) : "?";
    when = `${arrow(rule.params.condition as AlertCondition | undefined)} ${lv}`;
  } else {
    when = rule.label || (rule.triggerKind === "line" ? "line" : "indicator");
  }
  return `Move ${field.toUpperCase()} to ${tgt} when ${when}`;
}

// The SL / TP line colors, faded: the trigger a little, the target more.
const TRIGGER_ALPHA = "b3"; // ~70%
const TARGET_ALPHA = "59"; // ~35%

function lineSpecsFor(o: {
  ruleKey: string;
  field: Field;
  level: number;
  condition: AlertCondition | undefined;
  target: MoveTarget;
  precision: number;
  labelX: number;
  overrides: Record<string, number>;
}): LineSpec[] {
  const base = o.field === "sl" ? STOP_COLOR : TP_COLOR;
  const name = o.field === "sl" ? "SL" : "TP";
  const tgtWord = o.target.type === "price" ? o.target.value.toFixed(o.precision) : "BE";
  const triggerId = moveLineId(o.ruleKey, o.field, "trigger");
  const common = { draggable: true, emphasized: true, fullWidth: true, labelX: o.labelX };
  const specs: LineSpec[] = [{
    ...common,
    key: triggerId,
    level: o.overrides[triggerId] ?? o.level,
    color: base + TRIGGER_ALPHA,
    label: `Move ${name} → ${tgtWord} ${arrow(o.condition)}`,
  }];
  if (o.target.type === "price") {
    const targetId = moveLineId(o.ruleKey, o.field, "target");
    specs.push({
      ...common,
      key: targetId,
      level: o.overrides[targetId] ?? o.target.value,
      color: base + TARGET_ALPHA,
      label: `New ${name}`,
    });
  }
  return specs;
}

/** Trigger / target lines for the ticket's draft and the saved price rules on `epic`. */
export function moveLineSpecs(o: {
  epic: string;
  draft: MoveDraftState | null;
  saved: MoveRule[];
  precision: number;
  labelX?: number;
}): LineSpec[] {
  const labelX = o.labelX ?? DRAFT_LABEL_X_FALLBACK;
  const overrides = moveLineOverrides.value;
  const specs: LineSpec[] = [];
  const d = o.draft && o.draft.epic === o.epic ? o.draft : null;
  for (const r of o.saved) {
    if (r.epic !== o.epic || r.triggerKind !== "price_level") continue;
    const field = r.action.field;
    // The ticket is editing this rule's field: its draft line stands in for it.
    // A draft that is off draws nothing, so the saved (still active) rule stays.
    if (d && d.dealId != null && d.dealId === r.action.dealId && d[field]?.on) continue;
    const level = Number(r.params.level);
    if (!Number.isFinite(level)) continue;
    specs.push(...lineSpecsFor({
      ruleKey: r.id, field, level,
      condition: r.params.condition as AlertCondition | undefined,
      target: r.action.target, precision: o.precision, labelX, overrides,
    }));
  }
  if (d) {
    for (const field of ["sl", "tp"] as const) {
      const f = d[field];
      if (!f?.on || !Number.isFinite(f.level)) continue;
      specs.push(...lineSpecsFor({
        ruleKey: DRAFT_KEY, field, level: f.level, condition: f.condition,
        target: f.target, precision: o.precision, labelX, overrides,
      }));
    }
  }
  return specs;
}

/** A move line dragged to `level`: a draft writes the draft, a saved rule an override. */
export function applyMoveLineDrag(id: string, level: number): void {
  const p = parseMoveLineId(id);
  if (!p) return;
  if (p.ruleKey === DRAFT_KEY) {
    setMoveLevel(p.field, p.which, level);
    return;
  }
  moveLineOverrides.set({ ...moveLineOverrides.value, [id]: level });
}

function clearOverride(id: string): void {
  if (!(id in moveLineOverrides.value)) return;
  const { [id]: _drop, ...rest } = moveLineOverrides.value;
  moveLineOverrides.set(rest);
}

/** A move line dropped: a saved rule is patched to the dragged level, then its
 *  override is cleared (the refreshed cache draws it from there). */
export async function endMoveLineDrag(id: string): Promise<void> {
  const p = parseMoveLineId(id);
  if (!p || p.ruleKey === DRAFT_KEY) return;
  const level = moveLineOverrides.value[id];
  const rule = loadMoveRules().find((r) => r.id === p.ruleKey);
  try {
    if (level == null || !rule) return;
    const err = p.which === "trigger"
      ? await patchMoveRule(rule.id, { params: { ...rule.params, level } })
      : await patchMoveRule(rule.id, { target: { type: "price", value: level } });
    if (err) toast(`Could not move the rule line: ${err}`, { tone: "error" });
  } finally {
    clearOverride(id);
  }
}

/** Drop a saved line's override without saving (a drag aborted mid-way). */
export function abortMoveLineDrag(id: string): void {
  clearOverride(id);
}
