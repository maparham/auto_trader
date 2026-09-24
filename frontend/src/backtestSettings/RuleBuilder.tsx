import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RangeChip } from "../components/RangeChip";
import RuleExpressionInput from "../components/RuleExpressionInput";
import RulePalette from "../components/RulePalette";
import Tooltip from "../components/Tooltip";
import { cloneRule, type Combine, type Rule, type RuleGroup } from "../lib/backtestConfig";
import type { ExprInstance } from "../lib/expr/catalog";
import { analyze } from "../lib/expr/parser";
import { sweepLiteralTarget } from "../lib/expr/sweepLiterals";
import { toast } from "../lib/notify";
import { requestConfirm } from "../lib/signals";
import type { RangeAxis, SweepAxis } from "../lib/sweep";
import { CheckSmallIcon, CopyAllIcon, KebabIcon, TrashIcon } from "./icons";
import { Section } from "./Section";

// Per-row actions collapsed into one ⋮ menu (the inline icons were too small to
// notice). Portaled like the operator dropdown so the panel's overflow can't
// clip it. Includes a Disable/Enable toggle — a disabled rule is kept but
// dropped from the run (activeGroup filters it).
const RULE_MENU_WIDTH = 168;
function RuleMenu({
  enabled,
  onDuplicate,
  onCopy,
  onToggleEnabled,
  onRemove,
}: {
  enabled: boolean;
  onDuplicate: () => void;
  onCopy: () => void;
  onToggleEnabled: () => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  function toggle() {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.right - RULE_MENU_WIDTH, window.innerWidth - RULE_MENU_WIDTH - 8));
      setPos({ top: r.bottom + 4, left });
    }
    setOpen((v) => !v);
  }

  function run(fn: () => void) {
    fn();
    setOpen(false);
  }

  return (
    <div className="bt-rule-menu">
      <Tooltip content="Rule actions">
        <button
          ref={btnRef}
          type="button"
          className={`bt-rule-menu-btn${open ? " open" : ""}`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Rule actions"
          onClick={toggle}
        >
          <KebabIcon />
        </button>
      </Tooltip>
      {open &&
        pos &&
        createPortal(
          <ul
            ref={popRef}
            className="dropdown bt-rule-menu-list"
            role="menu"
            style={{ position: "fixed", top: pos.top, left: pos.left }}
          >
            <li role="menuitem" onClick={() => run(onDuplicate)}>Duplicate</li>
            <li role="menuitem" onClick={() => run(onCopy)}>Copy</li>
            <li role="menuitem" onClick={() => run(onToggleEnabled)}>{enabled ? "Disable" : "Enable"}</li>
            <li role="menuitem" className="bt-rule-menu-danger" onClick={() => run(onRemove)}>Remove</li>
          </ul>,
          document.body,
        )}
    </div>
  );
}

// Task 13 Stage A: one rule row is now just an expression string (+ enabled).
// The loose shape lets this section accept both the new minimal `{ expr }` rows
// and the coexisting structured `Rule` rows the modal still stores in its config
// (a `Rule` is assignable to `ExprRow` because `expr`/`enabled` are optional).
type ExprRow = { expr?: string; enabled?: boolean };
type ExprGroupLike = { combine?: Combine; rules: ExprRow[] };

export function RuleGroupSection({
  title,
  info,
  group,
  onChange,
  emptyHint,
  onCopy,
  onPaste,
  pickIndicator,
  instances,
  isExit = false,
  sweep,
}: {
  title: string;
  info?: string;
  group: ExprGroupLike;
  onChange: (g: RuleGroup) => void;
  emptyHint: string;
  // Retained for call-site compatibility with the coded/live rule surfaces; the
  // expression editor does not read them.
  defaultAvwapAnchor?: number;
  baseResolution?: string;
  // The rule clipboard (useRuleClipboard): one copy handler for a single rule
  // ([r]) and a whole group alike, one paste resolver for what to append.
  onCopy?: (rules: Rule[]) => void;
  onPaste?: () => Promise<Rule[] | null>;
  // "Pick from chart" for THIS group: armedRow is the row armed
  // in this group (or null), arm/disarm toggle it. Absent with no chart.
  pickIndicator?: {
    armedRow: number | null;
    arm: (row: number) => void;
    disarm: () => void;
  };
  // The live chart's referenceable panes ("SLOPE" with its current outputs), for
  // instance-reference lint + completion in each row's editor. Injected, never
  // imported: the pane's own settings are the source of truth.
  instances?: readonly ExprInstance[];
  // Exit groups gate whether `entry` is a valid reference in the expression.
  isExit?: boolean;
  sweep?: {
    axes: SweepAxis[];
    side: "long" | "short";
    group: "entry" | "exit";
    editable: boolean;
    onToggle: (target: string, current: number) => void;
    onAxisChange: (target: string, patch: Partial<Pick<RangeAxis, "from" | "to" | "step">>) => void;
  };
}) {
  // Which row's insert palette is open (one at a time), or null when none. The
  // palette is a portaled floating modal, so it renders once for the group off
  // this index rather than inside the row's markup; Esc and click-away are
  // FloatingModal's, not ours. Each group instance (entry/exit, long/short)
  // holds its own index, but only one palette is ever up: opening one fires a
  // mousedown outside every other panel, which closes them.
  const [paletteRow, setPaletteRow] = useState<number | null>(null);

  // Emit the group back to the parent. The stored config still types groups as
  // `RuleGroup`; the cast bridges the coexistence window (Stage C rewrites the
  // config's rule model to the expression shape, dropping the cast).
  // Emitting off a ref rather than the render's `group` matters for the async
  // paste: the clipboard read can sit behind a permission prompt while the user
  // edits the group, and a pre-await snapshot would overwrite those edits.
  const groupRef = useRef(group);
  groupRef.current = group;
  const emit = (rules: ExprRow[]) => onChange({ ...groupRef.current, rules } as RuleGroup);

  // Wipe every rule in this group, gated behind a confirm (unlike the per-row
  // delete, which is cheap to undo by re-adding one rule).
  function clearAll() {
    requestConfirm({
      title: "Delete all rules",
      message: `Remove all ${group.rules.length} rule${group.rules.length === 1 ? "" : "s"} from ${title}?`,
      confirmLabel: "Delete all",
      onConfirm: () => emit([]),
    });
  }
  // Copy the whole group's rules. The copy lands on the clipboard, so the click
  // has no visible effect of its own — flash the button into a ✓ so it doesn't
  // read as a dead control.
  const [copiedAll, setCopiedAll] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
  function copyAll() {
    onCopy?.(group.rules as Rule[]);
    setCopiedAll(true);
    window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopiedAll(false), 1200);
  }
  // Paste appends whatever the clipboard resolves to — one rule or a whole
  // group, copied in this window or another app instance (the resolver also
  // recreates any chart panes the pasted expressions reference).
  async function paste() {
    const rules = (await onPaste?.()) ?? null;
    if (!rules?.length) {
      toast("Nothing to paste — copy a rule first");
      return;
    }
    emit([...groupRef.current.rules, ...rules.map(cloneRule)]);
  }
  // Write one field of a single row back, cloning the row so unrelated rows keep
  // their identity. Expr rows are flat, so a spread is a full copy.
  function patchRule(i: number, patch: Partial<ExprRow>) {
    const rules = group.rules.slice();
    rules[i] = { ...rules[i], ...patch };
    emit(rules);
  }
  function addRule() {
    emit([...group.rules, { expr: "", enabled: true }]);
  }
  function removeRule(i: number) {
    // Any reshuffle invalidates `paletteRow` — it addresses a row by index, so a
    // surviving index can silently come to mean a different rule (delete row 1
    // with the palette open on row 2 and it would insert into the old row 3).
    setPaletteRow(null);
    emit(group.rules.filter((_, idx) => idx !== i));
  }
  // Insert an independent copy right after the source row, so a duplicated rule
  // reads as a variation of the one above it rather than landing at the bottom.
  function duplicateRule(i: number) {
    setPaletteRow(null); // same index-shift hazard as removeRule
    const rules = group.rules.slice();
    rules.splice(i + 1, 0, { ...rules[i] });
    emit(rules);
  }
  // Palette insert (Stage A): append the picked token to the row's expression.
  // A cursor-aware insert is a later refinement; append keeps the wiring simple.
  function insertInto(i: number, text: string) {
    patchRule(i, { expr: (group.rules[i].expr ?? "") + text });
  }

  return (
    <Section
      title={title}
      info={info}
      // Group-wide actions (copy-all / clear-all) sit beside the section title.
      // Keeping them off their own row means a single-rule group doesn't leave an
      // empty band between the heading and its one rule.
      extra={
        group.rules.length > 0 ? (
          <div className="bt-groophead-actions">
            {/* Nothing to combine below two rules, so the switch stays out of the
                way until a second rule shows up. A group that predates the field
                (combine undefined) reads as AND — the backend's default too. */}
            {group.rules.length >= 2 && (
              <div className="seg bt-combine-seg" role="radiogroup" aria-label="Combine rules with">
                {(["AND", "OR"] as const).map((c) => (
                  <Tooltip
                    key={c}
                    content={
                      c === "AND"
                        ? "Fire only when every rule in this group is true."
                        : "Fire when any rule in this group is true."
                    }
                  >
                    <button
                      type="button"
                      role="radio"
                      aria-checked={(group.combine ?? "AND") === c}
                      className={(group.combine ?? "AND") === c ? "seg-on" : ""}
                      onClick={() => onChange({ ...group, combine: c } as RuleGroup)}
                    >
                      {c}
                    </button>
                  </Tooltip>
                ))}
              </div>
            )}
            <Tooltip content={copiedAll ? "Copied" : "Copy all rules in this group"}>
              <button
                className={"bt-rule-toggle bt-copyall" + (copiedAll ? " bt-copied" : "")}
                onClick={copyAll}
                aria-label="Copy all rules"
              >
                {copiedAll ? <CheckSmallIcon /> : <CopyAllIcon />}
              </button>
            </Tooltip>
            <Tooltip content="Delete all rules in this group">
              <button
                className="bt-rule-toggle bt-clearall"
                onClick={clearAll}
                aria-label="Delete all rules"
              >
                <TrashIcon />
              </button>
            </Tooltip>
          </div>
        ) : undefined
      }
    >
      {group.rules.length === 0 && (
        <div className="al-note bt-empty-rules">{emptyHint}</div>
      )}
      {group.rules.map((rule, i) => {
        // Expr rows only touch `expr`/`enabled`; the alias keeps the copy handler
        // typed against the stored `Rule` shape.
        const r = rule as Rule;
        // A disabled row is frozen: the editor goes read-only, and the two
        // controls that write into it (palette insert, pick-from-chart) go with
        // it — otherwise they'd keep editing an expression you can't type in.
        const off = rule.enabled === false;
        return (
        <Fragment key={i}>
        <div className={`bt-rule-row${off ? " bt-rule-disabled" : ""}`}>
          <div className="bt-rule-main">
            <RuleExpressionInput
              value={rule.expr ?? ""}
              onChange={(expr) => patchRule(i, { expr })}
              isExit={isExit}
              instances={instances}
              readOnly={off}
              placeholder="e.g. EMA(9) > EMA(21)"
            />
            <div className="bt-rule-actions">
              <Tooltip
                content={
                  off
                    ? "Enable this rule to edit it"
                    : "Insert an indicator, candle field, or timeframe"
                }
              >
                {/* Open-only, never a toggle: the palette modal closes itself on
                    a capture-phase mousedown outside its panel, which lands
                    before this click — a toggle would close then reopen. */}
                <button
                  type="button"
                  className={`bt-rule-toggle bt-palette-toggle${paletteRow === i ? " on" : ""}`}
                  onClick={() => setPaletteRow(i)}
                  disabled={off}
                  aria-label="Insert from palette"
                  aria-haspopup="dialog"
                  aria-expanded={paletteRow === i}
                >
                  +
                </button>
              </Tooltip>
              {pickIndicator && (
                <Tooltip
                  content={
                    off
                      ? "Enable this rule to edit it"
                      : pickIndicator.armedRow === i
                        ? "Click an indicator on the chart, or click here to cancel"
                        : "Pick an indicator from the chart"
                  }
                >
                  <button
                    type="button"
                    className={`bt-rule-toggle bt-pick-toggle${pickIndicator.armedRow === i ? " on" : ""}`}
                    onClick={() =>
                      pickIndicator.armedRow === i ? pickIndicator.disarm() : pickIndicator.arm(i)
                    }
                    disabled={off}
                    aria-label="Pick an indicator from the chart"
                    aria-pressed={pickIndicator.armedRow === i}
                  >
                    ◎
                  </button>
                </Tooltip>
              )}
              <RuleMenu
                enabled={!off}
                onDuplicate={() => duplicateRule(i)}
                onCopy={() => onCopy?.([r as Rule])}
                onToggleEnabled={() => {
                  // Turning a row off closes anything it had open, so the frozen
                  // row can't be left with a live palette or an armed picker.
                  if (!off) {
                    if (paletteRow === i) setPaletteRow(null);
                    if (pickIndicator?.armedRow === i) pickIndicator.disarm();
                  }
                  patchRule(i, { enabled: off });
                }}
                onRemove={() => removeRule(i)}
              />
            </div>
          </div>
        </div>
        {sweep?.editable && (() => {
          // lit: targets address rows by RAW full-list index i (the expr request
          // ships every row, disabled included), NOT activeRuleIndex(i).
          const { literals } = analyze(rule.expr ?? "", { isExit });
          if (!literals.length) return null;
          // A disabled rule's configured axes stay visible but PARKED: greyed,
          // still editable/removable, excluded from the combo count and the run
          // (a rule that never evaluates would sweep identical backtests). No
          // add-axis chips on a disabled row, and no row at all without axes.
          const parked = rule.enabled === false;
          const items = literals.map((lit) => {
            const target = sweepLiteralTarget(sweep.side, sweep.group, i, lit.ordinal);
            const axis = sweep.axes.find(
              (a) => a.target === target && a.kind === "range",
            ) as RangeAxis | undefined;
            return { lit, target, axis };
          }).filter((it) => !parked || it.axis);
          if (!items.length) return null;
          return (
            <div className={`sp-row sweep-axis-row bt-lit-sweep-row${parked ? " bt-lit-parked" : ""}`}>
              <span className="sp-label">{parked ? "sweep (off with rule)" : "sweep"}</span>
              <span className="bt-chip-row">
                {items.map(({ lit, target, axis }) =>
                  axis ? (
                    <span key={lit.ordinal} className="bt-lit-axis">
                      <span className="sp-label">{lit.label}</span>
                      <RangeChip
                        axis={axis}
                        onPatch={(p) => sweep.onAxisChange(target, p)}
                        onRemove={() => sweep.onToggle(target, lit.value)}
                      />
                    </span>
                  ) : (
                    <Tooltip key={lit.ordinal} asChild content={`Sweep ${lit.label}`}>
                      <button
                        type="button"
                        className="bt-chip"
                        onClick={() => sweep.onToggle(target, lit.value)}
                      >
                        {lit.label} {lit.value}
                      </button>
                    </Tooltip>
                  ),
                )}
              </span>
            </div>
          );
        })()}
        </Fragment>
        );
      })}
      <div className="bt-rule-foot">
        <button className="ghost" onClick={addRule}>
          + Add rule
        </button>
        {onPaste && (
          <Tooltip
            content={[
              "Paste the copied rule(s) into this group.",
              "Works across windows and tabs — chart indicators the rules use come along with their settings.",
            ]}
          >
            <button className="ghost bt-pasteall" onClick={() => void paste()}>
              <CopyAllIcon /> Paste
            </button>
          </Tooltip>
        )}
      </div>
      {/* One palette for the whole group — it portals to the body, so it doesn't
          belong to any row's markup; `paletteRow` is only the insert target.
          The row check is the backstop for a group emptied under it (clear-all);
          the edits that shift indices clear `paletteRow` themselves. */}
      {paletteRow !== null && group.rules[paletteRow] && (
        <RulePalette
          title={`Insert into rule ${paletteRow + 1}`}
          onInsert={(text) => insertInto(paletteRow, text)}
          onClose={() => setPaletteRow(null)}
        />
      )}
    </Section>
  );
}
