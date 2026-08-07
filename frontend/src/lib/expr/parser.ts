// Advisory TypeScript port of the backend strategy-expression pipeline
// (backend/auto_trader/strategy/expr/{lexer,parser,nodes,registry,validate,literals}.py).
//
// It exists so the editor can lint, highlight, and label numeric knobs entirely
// in the browser, in lockstep with what the backend accepts. `analyze` runs the
// same lexer, parser, validator, and literal extractor and returns tokens, the
// ordered numeric literals with their context labels, and the first error (if
// any). The backend stays the source of truth; a parity corpus (Task 9) pins
// this port to it, so every edge and error slug below mirrors the Python.

import {
  CANDLE_FIELDS,
  CROSS_FNS,
  INDICATOR_SPECS,
  PREDICATE_FNS,
  PATTERN_FN_SET,
  PATTERN_WARMUP,
  COUNT_FN,
  TIMEFRAMES,
  WRAPPER_ARITY,
  tfSeconds,
} from "./catalog";
import type { ExprInstance } from "./catalog";

export type { ExprInstance };

/** The live instance list, keyed by id — the shape the validator and warm-up
 * walk (mirrors the backend's `instances: dict[str, ResolvedInstance]`). */
type InstanceMap = ReadonlyMap<string, ExprInstance>;

const NO_INSTANCES: InstanceMap = new Map();

function instanceMap(instances?: readonly ExprInstance[]): InstanceMap {
  if (!instances || instances.length === 0) return NO_INSTANCES;
  return new Map(instances.map((i) => [i.id, i]));
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Token {
  type: string;
  from: number;
  to: number;
}

export interface LiteralSpan {
  ordinal: number;
  value: number;
  from: number;
  to: number;
  label: string;
}

export interface ExprError {
  code: string;
  message: string;
  from: number;
  to: number;
}

export interface AnalyzeResult {
  tokens: Token[];
  literals: LiteralSpan[];
  error: ExprError | null;
  /** `error` as a list, for callers that render diagnostics as a collection.
   * The pipeline is throw-based and first-error-wins (like the backend's), so
   * this is always length 0 or 1 — it never accumulates. */
  errors: ExprError[];
}

// Internal error carrier (mirrors backend errors.ExprError). Uses start/end to
// stay close to the Python; mapped to from/to at the analyze boundary.
class ExprErr {
  readonly code: string;
  readonly message: string;
  readonly start: number;
  readonly end: number;
  constructor(code: string, message: string, start: number, end: number) {
    this.code = code;
    this.message = message;
    this.start = start;
    this.end = end;
  }
}

const CANDLE_FIELD_SET = new Set<string>(CANDLE_FIELDS);
const CROSS_SET = new Set<string>(CROSS_FNS);
const PREDICATE_SET = new Set<string>(PREDICATE_FNS);

// ---------------------------------------------------------------------------
// AST (mirrors nodes.py). Discriminated union on `kind`.
// ---------------------------------------------------------------------------

interface NumNode { kind: "Num"; value: number; start: number; end: number; }
interface CandleNode { kind: "Candle"; field: string | null; start: number; end: number; }
interface EntryNode { kind: "Entry"; start: number; end: number; }
interface CallNode { kind: "Call"; name: string; args: Node[]; start: number; end: number; }
interface FieldNode { kind: "Field"; base: Node; name: string; start: number; end: number; }
interface OffsetNode { kind: "Offset"; base: Node; n: number; start: number; end: number; }
interface TfNode { kind: "Tf"; base: Node; tf: string; start: number; end: number; }
interface UnaryNode { kind: "Unary"; operand: Node; start: number; end: number; }
interface BinaryNode { kind: "Binary"; op: string; left: Node; right: Node; start: number; end: number; }
interface CompareNode { kind: "Compare"; op: string; left: Node; right: Node; start: number; end: number; }
interface CrossNode { kind: "Cross"; fn: string; a: Node; b: Node; start: number; end: number; }
interface ChainNode { kind: "Chain"; parts: Array<CompareNode | CrossNode>; start: number; end: number; }
interface PredicateNode { kind: "Predicate"; fn: string; base: Node; start: number; end: number; }
interface CountNode { kind: "Count"; cond: CompareNode | CrossNode | PredicateNode; window: Node; start: number; end: number; }
interface BarsSinceEntryNode { kind: "BarsSinceEntry"; start: number; end: number; }
// A configured chart-indicator instance's output, e.g. SLOPE#a1b2c3.slope0.
// Carries NO parameters: the pane's settings are the single source of truth.
interface IndicatorRefNode { kind: "IndicatorRef"; instance: string; output: string; start: number; end: number; }

type Node =
  | NumNode | CandleNode | EntryNode | CallNode | FieldNode | OffsetNode
  | TfNode | UnaryNode | BinaryNode | CompareNode | CrossNode
  | PredicateNode | CountNode | BarsSinceEntryNode | IndicatorRefNode;

type Row = CompareNode | CrossNode | ChainNode | PredicateNode;

// Mirrors nodes.py contains_tf case for case, INCLUDING the Chain case: no
// caller reaches it (a Chain is only ever a top-level Row, and the only call
// site — parsePostfix's "@" branch — never holds one), but the mirror is kept
// literal so a future caller cannot find a hole here that the backend closes.
function containsTf(node: Node | ChainNode): boolean {
  if (node.kind === "Tf") return true;
  if (node.kind === "Field" || node.kind === "Offset") return containsTf(node.base);
  if (node.kind === "Unary") return containsTf(node.operand);
  if (node.kind === "Call") return node.args.some(containsTf);
  if (node.kind === "Binary" || node.kind === "Compare") return containsTf(node.left) || containsTf(node.right);
  if (node.kind === "Cross") return containsTf(node.a) || containsTf(node.b);
  if (node.kind === "Chain") return node.parts.some(containsTf);
  if (node.kind === "Predicate") return containsTf(node.base);
  if (node.kind === "Count") return containsTf(node.cond) || containsTf(node.window);
  return false;
}

/** A chain part's (left, right) operands regardless of its shape. */
function partOperands(p: CompareNode | CrossNode): [Node, Node] {
  return p.kind === "Cross" ? [p.a, p.b] : [p.left, p.right];
}

// ---------------------------------------------------------------------------
// Lexer (mirrors lexer.py)
// ---------------------------------------------------------------------------

interface LexToken { type: string; value: string; start: number; end: number; }

const SINGLE: Record<string, string> = {
  "(": "LPAREN", ")": "RPAREN", ",": "COMMA", "+": "PLUS", "-": "MINUS",
  "*": "STAR", "/": "SLASH", "[": "LBRACKET", "]": "RBRACKET", "@": "AT", ".": "DOT",
};

const isSpace = (c: string) => /\s/.test(c);
const isDigit = (c: string) => c >= "0" && c <= "9";
const isAlpha = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
const isAlnum = (c: string) => isDigit(c) || isAlpha(c);

// Returns tokens up to (and including EOF), or the tokens collected so far plus
// a bad_char error if an unexpected character is hit.
function tokenize(src: string): { tokens: LexToken[]; error: ExprErr | null } {
  const out: LexToken[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (isSpace(c)) { i += 1; continue; }
    if (isDigit(c) || (c === "." && i + 1 < n && isDigit(src[i + 1]))) {
      let j = i;
      let seenDot = false;
      while (j < n && (isDigit(src[j]) || (src[j] === "." && !seenDot))) {
        if (src[j] === ".") seenDot = true;
        j += 1;
      }
      // Alphanumeric after this run makes it one NAME (e.g. 4H, 1.5H, 9x).
      if (j < n && (isAlpha(src[j]) || src[j] === "_")) {
        while (j < n && (isAlnum(src[j]) || src[j] === "_")) j += 1;
        out.push({ type: "NAME", value: src.slice(i, j), start: i, end: j });
      } else {
        out.push({ type: "NUMBER", value: src.slice(i, j), start: i, end: j });
      }
      i = j;
      continue;
    }
    if (isAlpha(c) || c === "_") {
      let j = i;
      // "#" is legal INSIDE a name (never leading) so a chart indicator's
      // instance id — "SLOPE#a1b2c3", minted by mintInstanceId — lexes verbatim.
      // Only THIS continuation loop takes "#": the digit branch above stays
      // alnum/underscore, exactly like the backend lexer, so "4H#x" is bad_char.
      while (j < n && (isAlnum(src[j]) || src[j] === "_" || src[j] === "#")) j += 1;
      const word = src.slice(i, j);
      // A bare "x" fused to a comparison bracket is the infix cross
      // operator: x> (crosses above) / x< (crosses below).
      if (word === "x" && j < n && (src[j] === ">" || src[j] === "<")) {
        // "x>=" / "x<=" is a near-miss for the operator, not a fused bracket
        // plus a stray "="; report the whole thing with the cross-operator copy
        // instead of bad_char on the "=".
        if (j + 1 < n && src[j + 1] === "=") {
          return { tokens: out, error: new ExprErr("bad_cross_op", BAD_CROSS_MSG, i, j + 2) };
        }
        out.push({ type: src[j] === ">" ? "XGT" : "XLT", value: src.slice(i, j + 1), start: i, end: j + 1 });
        i = j + 1;
        continue;
      }
      out.push({ type: "NAME", value: word, start: i, end: j });
      i = j;
      continue;
    }
    if (c === "<" || c === ">") {
      if (i + 1 < n && src[i + 1] === "=") {
        out.push({ type: c === ">" ? "GE" : "LE", value: src.slice(i, i + 2), start: i, end: i + 2 });
        i += 2;
      } else {
        out.push({ type: c === ">" ? "GT" : "LT", value: c, start: i, end: i + 1 });
        i += 1;
      }
      continue;
    }
    if (c in SINGLE) {
      out.push({ type: SINGLE[c], value: c, start: i, end: i + 1 });
      i += 1;
      continue;
    }
    return { tokens: out, error: new ExprErr("bad_char", `Unexpected character '${c}'.`, i, i + 1) };
  }
  out.push({ type: "EOF", value: "", start: n, end: n });
  return { tokens: out, error: null };
}

// ---------------------------------------------------------------------------
// Parser (mirrors parser.py)
// ---------------------------------------------------------------------------

const CROSS_OF: Record<string, string> = { XGT: "crossAbove", XLT: "crossBelow" };
const ROW_OP_TYPES = new Set(["GT", "LT", "GE", "LE", "XGT", "XLT"]);
const BAD_CROSS_MSG = "Write the cross operator as x> or x< — lowercase, no space.";

class Parser {
  private i = 0;
  private toks: LexToken[];
  constructor(toks: LexToken[]) {
    this.toks = toks;
  }

  private peek(): LexToken { return this.toks[this.i]; }
  private next(): LexToken { return this.toks[this.i++]; }

  private expect(type: string): LexToken {
    const t = this.peek();
    if (t.type !== type) {
      if (t.type === "XGT" || t.type === "XLT") {
        throw new ExprErr("cross_not_toplevel", "A comparison or cross can only be the whole row.", t.start, t.end);
      }
      // A leftover bare "x" where the grammar wanted something else (most often
      // a trailing "EMA(9) x> EMA(50) x") is a half-typed cross operator, not a
      // generic surprise token.
      if (t.type === "NAME" && (t.value === "x" || t.value === "X")) {
        throw new ExprErr("bad_cross_op", BAD_CROSS_MSG, t.start, t.end);
      }
      throw new ExprErr("unexpected_token", `Expected ${type.toLowerCase()} here.`, t.start, t.end);
    }
    return this.next();
  }

  parseRow(): Row {
    const t = this.peek();
    if (t.type === "NAME" && CROSS_SET.has(t.value) && this.toks[this.i + 1].type === "LPAREN") {
      const fn = this.next();
      this.expect("LPAREN");
      const a = this.parseArith();
      this.expect("COMMA");
      const b = this.parseArith();
      const close = this.expect("RPAREN");
      this.expect("EOF");
      return { kind: "Cross", fn: fn.value, a, b, start: fn.start, end: close.end };
    }
    const left = this.parseArith();
    const op = this.peek();
    if (left.kind === "Predicate" && op.type === "EOF") {
      this.next();
      return left;
    }
    if (!ROW_OP_TYPES.has(op.type)) {
      if (op.type === "NAME" && (op.value === "x" || op.value === "X")) {
        throw new ExprErr("bad_cross_op", BAD_CROSS_MSG, op.start, op.end);
      }
      throw new ExprErr("expected_operator", "Expected a comparison operator (> < >= <= x> x<).", op.start, op.end);
    }
    const symOf: Record<string, string> = { GT: ">", LT: "<", GE: ">=", LE: "<=" };
    const parts: Array<CompareNode | CrossNode> = [];
    let operand: Node = left;
    while (ROW_OP_TYPES.has(this.peek().type)) {
      const optok = this.next();
      const right = this.parseArith();
      if (optok.type in CROSS_OF) {
        parts.push({ kind: "Cross", fn: CROSS_OF[optok.type], a: operand, b: right, start: operand.start, end: right.end });
      } else {
        parts.push({ kind: "Compare", op: symOf[optok.type], left: operand, right, start: operand.start, end: right.end });
      }
      operand = right;
    }
    this.expect("EOF");
    const crosses = parts.filter((p) => p.kind === "Cross");
    if (crosses.length > 1) {
      throw new ExprErr("multiple_crosses", "Only one cross per row.", crosses[1].start, crosses[1].end);
    }
    if (parts.length === 1) return parts[0];
    return { kind: "Chain", parts, start: parts[0].start, end: parts[parts.length - 1].end };
  }

  private parseArith(): Node {
    let node = this.parseTerm();
    while (this.peek().type === "PLUS" || this.peek().type === "MINUS") {
      const op = this.next();
      const right = this.parseTerm();
      node = { kind: "Binary", op: op.type === "PLUS" ? "+" : "-", left: node, right, start: node.start, end: right.end };
    }
    return node;
  }

  private parseTerm(): Node {
    let node = this.parseFactor();
    while (this.peek().type === "STAR" || this.peek().type === "SLASH") {
      const op = this.next();
      const right = this.parseFactor();
      node = { kind: "Binary", op: op.type === "STAR" ? "*" : "/", left: node, right, start: node.start, end: right.end };
    }
    return node;
  }

  private parseFactor(): Node {
    const t = this.peek();
    if (t.type === "MINUS") {
      this.next();
      const operand = this.parseFactor();
      return { kind: "Unary", operand, start: t.start, end: operand.end };
    }
    const node = this.parsePrimary();
    return this.parsePostfix(node);
  }

  private parsePrimary(): Node {
    const t = this.peek();
    if (t.type === "NUMBER") {
      this.next();
      return { kind: "Num", value: parseFloatPy(t.value), start: t.start, end: t.end };
    }
    if (t.type === "LPAREN") {
      this.next();
      const inner = this.parseArith();
      const close = this.expect("RPAREN");
      // A parenthesized group is a transparent wrapper: keep the inner node but
      // widen its span so postfix/offset spans read naturally.
      return { ...inner, start: t.start, end: close.end };
    }
    if (t.type === "NAME") {
      const name = this.next();
      if (name.value === "candle") return { kind: "Candle", field: null, start: name.start, end: name.end };
      if (name.value === "entry") return { kind: "Entry", start: name.start, end: name.end };
      if (name.value === "barsSinceEntry") return { kind: "BarsSinceEntry", start: name.start, end: name.end };
      if (PREDICATE_SET.has(name.value) && this.peek().type === "LPAREN") {
        this.next();
        const arg = this.parseArith();
        const close = this.expect("RPAREN");
        return { kind: "Predicate", fn: name.value, base: arg, start: name.start, end: close.end };
      }
      if (name.value === COUNT_FN && this.peek().type === "LPAREN") {
        this.next();
        const cond = this.parseCondition();
        this.expect("COMMA");
        const window = this.parseArith();
        const close = this.expect("RPAREN");
        return { kind: "Count", cond, window, start: name.start, end: close.end };
      }
      if (this.peek().type === "LPAREN") {
        this.next();
        const args: Node[] = [];
        if (this.peek().type !== "RPAREN") {
          args.push(this.parseArith());
          while (this.peek().type === "COMMA") {
            this.next();
            args.push(this.parseArith());
          }
        }
        const close = this.expect("RPAREN");
        return { kind: "Call", name: name.value, args, start: name.start, end: close.end };
      }
      // A bare name that is not candle/entry/call is an unknown variable; the
      // validator reports it. Model it as a zero-arg Call so spans survive.
      // ... unless it is the "X> b" spelling of the cross operator: only a bare
      // x/X sitting immediately on a comparison bracket earns the cross-operator
      // hint. A plain "x" elsewhere (e.g. count(..., x)) is just an unknown
      // variable and must be reported as one.
      if (
        (name.value === "x" || name.value === "X")
        && (this.peek().type === "GT" || this.peek().type === "LT")
      ) {
        throw new ExprErr("bad_cross_op", BAD_CROSS_MSG, name.start, name.end);
      }
      return { kind: "Call", name: name.value, args: [], start: name.start, end: name.end };
    }
    throw new ExprErr("unexpected_token", "Expected a value here.", t.start, t.end);
  }

  // condition := cross "(" arith "," arith ")" | arith cmpop arith | predicate
  private parseCondition(): CompareNode | CrossNode | PredicateNode {
    const t = this.peek();
    if (t.type === "NAME" && CROSS_SET.has(t.value) && this.toks[this.i + 1].type === "LPAREN") {
      const fn = this.next();
      this.expect("LPAREN");
      const a = this.parseArith();
      this.expect("COMMA");
      const b = this.parseArith();
      const close = this.expect("RPAREN");
      return { kind: "Cross", fn: fn.value, a, b, start: fn.start, end: close.end };
    }
    const left = this.parseArith();
    const op = this.peek();
    if (op.type === "XGT" || op.type === "XLT") {
      this.next();
      const right = this.parseArith();
      return { kind: "Cross", fn: CROSS_OF[op.type], a: left, b: right, start: left.start, end: right.end };
    }
    if (op.type !== "GT" && op.type !== "LT" && op.type !== "GE" && op.type !== "LE") {
      if (left.kind === "Predicate") return left;
      throw new ExprErr(
        "count_needs_condition",
        "count's first argument must be a condition, like candle.open > candle.close.",
        left.start, left.end,
      );
    }
    const symOf: Record<string, string> = { GT: ">", LT: "<", GE: ">=", LE: "<=" };
    const optok = this.next();
    const right = this.parseArith();
    return { kind: "Compare", op: symOf[optok.type], left, right, start: left.start, end: right.end };
  }

  private parsePostfix(node: Node): Node {
    for (;;) {
      const t = this.peek();
      if (t.type === "DOT") {
        this.next();
        const field = this.expect("NAME");
        if (node.kind === "Candle") {
          node = { kind: "Candle", field: field.value, start: node.start, end: field.end };
        } else if (
          node.kind === "Call"
          && node.args.length === 0
          && !Object.hasOwn(INDICATOR_SPECS, node.name)
          && !Object.hasOwn(WRAPPER_ARITY, node.name)
          && !CROSS_SET.has(node.name)
          && !PREDICATE_SET.has(node.name)
        ) {
          // A bare unknown name with a field is an indicator-instance reference.
          // Registered names keep the Field(Call) shape so validate still
          // reports field_on_call for EMA(9).signal. Object.hasOwn (not `in`)
          // so inherited Object.prototype members never count as registered.
          node = { kind: "IndicatorRef", instance: node.name, output: field.value, start: node.start, end: field.end };
        } else {
          node = { kind: "Field", base: node, name: field.value, start: node.start, end: field.end };
        }
      } else if (t.type === "LBRACKET") {
        this.next();
        if (this.peek().type !== "MINUS") {
          const bad = this.peek();
          throw new ExprErr("bad_offset", "A bar offset must be negative, like [-1].", bad.start, bad.end);
        }
        this.next();
        const num = this.expect("NUMBER");
        if (num.value.includes(".") || Math.trunc(parseFloatPy(num.value)) < 1) {
          throw new ExprErr("bad_offset", "A bar offset must be a whole number of 1 or more.", num.start, num.end);
        }
        const close = this.expect("RBRACKET");
        node = { kind: "Offset", base: node, n: Math.trunc(parseFloatPy(num.value)), start: node.start, end: close.end };
      } else if (t.type === "AT") {
        this.next();
        const tf = this.expect("NAME");
        if (containsTf(node)) {
          throw new ExprErr("nested_tf", "A timeframe pin cannot be nested inside another one.", t.start, tf.end);
        }
        node = { kind: "Tf", base: node, tf: tf.value, start: node.start, end: tf.end };
      } else {
        return node;
      }
    }
  }
}

// Python float() accepts the same numeric literals the lexer produces here
// (digits with at most one embedded dot); Number() matches for those.
function parseFloatPy(s: string): number {
  return Number(s);
}

// ---------------------------------------------------------------------------
// Validator (mirrors validate.py)
// ---------------------------------------------------------------------------

function candleRoot(node: Node): Node {
  while (node.kind === "Offset" || node.kind === "Tf") node = node.base;
  return node;
}

function validate(node: Row, isExit: boolean, instances: InstanceMap): void {
  if (node.kind === "Chain") {
    for (const p of node.parts) {
      const [left, right] = partOperands(p);
      walk(left, isExit, instances);
      walk(right, isExit, instances);
    }
    return;
  }
  if (node.kind === "Cross") {
    walk(node.a, isExit, instances);
    walk(node.b, isExit, instances);
    return;
  }
  if (node.kind === "Predicate") {
    checkPredicate(node);
    return;
  }
  walk(node.left, isExit, instances);
  walk(node.right, isExit, instances);
}

/** The instance id of a ref inside `node` whose own config carries a timeframe
 * pin, or null.
 *
 * A pane pinned in its own settings is an already-pinned series, so this is the
 * ref-shaped counterpart of `containsTf` — the parser's nested-pin check. The
 * case list below mirrors `containsTf` case for case on purpose: if the two
 * drift, a nested pin escapes through whichever node kind only one of them
 * recurses into. Keep them in step. (`containsTf` also carries a Chain case for
 * mirror fidelity; there is none here because `Node` excludes Chain, which is
 * only ever a top-level Row and never reaches this walk.) */
function pinnedInstance(node: Node, instances: InstanceMap): string | null {
  if (node.kind === "IndicatorRef") {
    const inst = instances.get(node.instance);
    return inst && inst.timeframe ? node.instance : null;
  }
  if (node.kind === "Field" || node.kind === "Offset" || node.kind === "Tf") {
    return pinnedInstance(node.base, instances);
  }
  if (node.kind === "Unary") return pinnedInstance(node.operand, instances);
  if (node.kind === "Call") return first(node.args.map((a) => pinnedInstance(a, instances)));
  if (node.kind === "Binary" || node.kind === "Compare") {
    return first([pinnedInstance(node.left, instances), pinnedInstance(node.right, instances)]);
  }
  if (node.kind === "Cross") {
    return first([pinnedInstance(node.a, instances), pinnedInstance(node.b, instances)]);
  }
  if (node.kind === "Predicate") return pinnedInstance(node.base, instances);
  if (node.kind === "Count") {
    return first([pinnedInstance(node.cond, instances), pinnedInstance(node.window, instances)]);
  }
  return null;
}

/** The first non-null result, or null. */
function first(results: Array<string | null>): string | null {
  for (const r of results) if (r !== null) return r;
  return null;
}

// A predicate's argument must bottom out in a bare `candle` (no field), wrapped
// only by offsets and at most one timeframe pin.
function checkPredicate(node: PredicateNode): void {
  let base: Node = node.base;
  while (base.kind === "Offset" || base.kind === "Tf") {
    if (base.kind === "Tf" && tfSeconds(base.tf) === null) {
      throw new ExprErr(
        "unknown_tf",
        `Unknown timeframe ${base.tf}. Try one of: ${TIMEFRAMES.map((t) => t.alias).join(", ")}.`,
        base.start, base.end,
      );
    }
    base = base.base;
  }
  if (!(base.kind === "Candle" && base.field === null)) {
    throw new ExprErr(
      "bad_predicate_arg",
      `${node.fn} takes a candle, like ${node.fn}(candle).`,
      node.start, node.end,
    );
  }
}

// True if `node`'s subtree contains an entry-based value (entry or
// barsSinceEntry) — used to keep those out of wrappers/indicators, which are
// expected to compute over a plain series and would otherwise crash trying to
// evaluate an entry-scoped operand with no active position. Mirrors
// containsTf's shape minus its (unreachable) Chain case: Node excludes Chain,
// which is only ever a top-level Row, never nested inside another node's
// subtree, so nothing here can be handed one.
function containsEntryKind(node: Node): boolean {
  if (node.kind === "Entry" || node.kind === "BarsSinceEntry") return true;
  if (node.kind === "Field" || node.kind === "Offset" || node.kind === "Tf") return containsEntryKind(node.base);
  if (node.kind === "Unary") return containsEntryKind(node.operand);
  if (node.kind === "Binary" || node.kind === "Compare") return containsEntryKind(node.left) || containsEntryKind(node.right);
  if (node.kind === "Cross") return containsEntryKind(node.a) || containsEntryKind(node.b);
  if (node.kind === "Predicate") return containsEntryKind(node.base);
  if (node.kind === "Count") return containsEntryKind(node.cond) || containsEntryKind(node.window);
  if (node.kind === "Call") return node.args.some(containsEntryKind);
  return false;
}

function walk(node: Node, isExit: boolean, instances: InstanceMap): void {
  switch (node.kind) {
    case "Num":
      return;
    case "Entry":
      if (!isExit) throw new ExprErr("entry_in_entry_rule", "entry is only available in exit rules.", node.start, node.end);
      return;
    case "Candle":
      if (node.field === null || !CANDLE_FIELD_SET.has(node.field)) {
        throw new ExprErr("bad_candle_field", "candle needs a field, like candle.close.", node.start, node.end);
      }
      return;
    case "Field": {
      const root = candleRoot(node.base);
      if (root.kind === "Candle") {
        if (!CANDLE_FIELD_SET.has(node.name)) {
          throw new ExprErr("bad_candle_field", "candle needs a field, like candle.close.", node.start, node.end);
        }
        return;
      }
      if (root.kind === "Call" && (Object.hasOwn(INDICATOR_SPECS, root.name) || Object.hasOwn(WRAPPER_ARITY, root.name))) {
        throw new ExprErr("field_on_call", `${root.name} has no named outputs.`, node.start, node.end);
      }
      if (root.kind === "IndicatorRef") {
        // SLOPE.slope0.foo (or SLOPE.slope0[-1].foo): the ref already names an
        // output, and an output is a plain series with no sub-fields.
        throw new ExprErr(
          "field_on_indicator_ref",
          `${root.instance}.${root.output} has no fields.`,
          node.start, node.end,
        );
      }
      walk(node.base, isExit, instances);
      return;
    }
    case "Tf":
      if (tfSeconds(node.tf) === null) {
        throw new ExprErr(
          "unknown_tf",
          `Unknown timeframe ${node.tf}. Try one of: ${TIMEFRAMES.map((t) => t.alias).join(", ")}.`,
          node.start, node.end,
        );
      }
      // A pane pinned in its own settings is already a pinned series; pinning it
      // again in the rule would be a nested pin, same as EMA(9)@1H@4H.
      if (pinnedInstance(node.base, instances) !== null) {
        throw new ExprErr(
          "nested_tf",
          "A timeframe pin cannot be nested inside another one.",
          node.start, node.end,
        );
      }
      walk(node.base, isExit, instances);
      return;
    case "Offset":
      walk(node.base, isExit, instances);
      return;
    case "Unary":
      walk(node.operand, isExit, instances);
      return;
    case "Binary":
      walk(node.left, isExit, instances);
      walk(node.right, isExit, instances);
      return;
    case "BarsSinceEntry":
      if (!isExit) throw new ExprErr("entry_in_entry_rule", "barsSinceEntry is only available in exit rules.", node.start, node.end);
      return;
    case "Predicate":
      throw new ExprErr(
        "predicate_as_value",
        `${node.fn}(...) is a condition — use it as a whole row or inside count(...).`,
        node.start, node.end,
      );
    case "Count": {
      const cond = node.cond;
      if (cond.kind === "Predicate") {
        checkPredicate(cond);
      } else if (cond.kind === "Cross") {
        walk(cond.a, isExit, instances);
        walk(cond.b, isExit, instances);
      } else {
        walk(cond.left, isExit, instances);
        walk(cond.right, isExit, instances);
      }
      walk(node.window, isExit, instances);
      return;
    }
    case "Compare":
    case "Cross":
      throw new ExprErr("cross_not_toplevel", "A comparison or cross can only be the whole row.", node.start, node.end);
    case "IndicatorRef": {
      const inst = instances.get(node.instance);
      if (inst === undefined) {
        throw new ExprErr(
          "unknown_indicator_ref",
          `No indicator named ${node.instance} on this chart.`,
          node.start, node.end,
        );
      }
      if (!inst.outputs.includes(node.output)) {
        throw new ExprErr(
          "unknown_indicator_output",
          `${node.instance} has no output ${node.output}. Available: ${inst.outputs.join(", ")}.`,
          node.start, node.end,
        );
      }
      return;
    }
    case "Call": {
      if (CROSS_SET.has(node.name)) {
        throw new ExprErr("cross_not_toplevel", `${node.name} can only be the whole row.`, node.start, node.end);
      }
      if (Object.hasOwn(INDICATOR_SPECS, node.name)) {
        const spec = INDICATOR_SPECS[node.name];
        if (node.args.length !== spec.arity) {
          throw new ExprErr("bad_arity", `${node.name} takes ${spec.arity} argument(s).`, node.start, node.end);
        }
        if (node.args.some((a) => containsEntryKind(a))) {
          throw new ExprErr(
            "entry_in_wrapper",
            `${node.name} cannot take entry-based values like entry or barsSinceEntry.`,
            node.start, node.end,
          );
        }
        for (const a of node.args) walk(a, isExit, instances);
        return;
      }
      if (Object.hasOwn(WRAPPER_ARITY, node.name)) {
        const arity = WRAPPER_ARITY[node.name];
        if (node.args.length !== arity) {
          throw new ExprErr("bad_arity", `${node.name} takes ${arity} arguments.`, node.start, node.end);
        }
        if (node.args.some((a) => containsEntryKind(a))) {
          throw new ExprErr(
            "entry_in_wrapper",
            `${node.name} cannot take entry-based values like entry or barsSinceEntry.`,
            node.start, node.end,
          );
        }
        for (const a of node.args) walk(a, isExit, instances);
        return;
      }
      const inst = instances.get(node.name);
      if (inst !== undefined && node.args.length === 0) {
        // A bare pane name parses as a zero-arg call; point at an output rather
        // than claiming the name is unknown.
        if (inst.outputs.length > 0) {
          throw new ExprErr(
            "indicator_ref_needs_output",
            `${node.name} needs an output, like ${node.name}.${inst.outputs[0]}.`,
            node.start, node.end,
          );
        }
      }
      throw new ExprErr("unknown_name", `Unknown name ${node.name}.`, node.start, node.end);
    }
  }
}

// ---------------------------------------------------------------------------
// Literal extraction (mirrors literals.py)
// ---------------------------------------------------------------------------

interface Collected { num: NumNode; label: string; }

function render(node: Node): string {
  switch (node.kind) {
    case "Call": {
      const args = node.args.map(render).join(", ");
      return node.args.length ? `${node.name}(${args})` : node.name;
    }
    case "Num":
      return formatG(node.value);
    case "Candle":
      return node.field ? `candle.${node.field}` : "candle";
    case "IndicatorRef":
      // Exactly as authored: the label a user reads back in the sweep axis.
      return `${node.instance}.${node.output}`;
    case "Entry":
      return "entry";
    case "Field":
      return `${render(node.base)}.${node.name}`;
    case "Offset":
      return `${render(node.base)}[-${node.n}]`;
    case "Tf":
      return `${render(node.base)}@${node.tf}`;
    case "Unary":
      return `-${render(node.operand)}`;
    case "Binary":
      return `${render(node.left)} ${node.op} ${render(node.right)}`;
    case "Compare":
      return `${render(node.left)} ${node.op} ${render(node.right)}`;
    case "Cross":
      return `${node.fn}(${render(node.a)}, ${render(node.b)})`;
    case "Predicate":
      return `${node.fn}(${render(node.base)})`;
    case "Count":
      return `count(${render(node.cond)}, ${render(node.window)})`;
    case "BarsSinceEntry":
      return "barsSinceEntry";
    default:
      return "?";
  }
}

// Mimics Python's "%g" formatting for the numbers this port produces (indicator
// args, offsets, small constants) so multiplier labels read like the backend.
function formatG(value: number): string {
  if (Number.isInteger(value)) return String(value);
  let s = value.toPrecision(6);
  if (s.includes(".") && !s.includes("e") && !s.includes("E")) {
    s = s.replace(/0+$/, "").replace(/\.$/, "");
  }
  return s;
}

function hasIndicator(node: Node): boolean {
  // A chart-instance output is an indicator term just like EMA(20), so a
  // numeric factor multiplying it is a multiplier, not a bare constant.
  if (node.kind === "IndicatorRef") return true;
  if (node.kind === "Call" && Object.hasOwn(INDICATOR_SPECS, node.name)) return true;
  if (node.kind === "Call") return node.args.some(hasIndicator);
  if (node.kind === "Field" || node.kind === "Offset" || node.kind === "Tf") return hasIndicator(node.base);
  if (node.kind === "Unary") return hasIndicator(node.operand);
  if (node.kind === "Binary") return hasIndicator(node.left) || hasIndicator(node.right);
  if (node.kind === "Predicate") return hasIndicator(node.base);
  if (node.kind === "Count") return true;
  return false;
}

function collect(node: Node, label: string, out: Collected[]): void {
  if (node.kind === "Num") {
    out.push({ num: node, label });
    return;
  }
  if (node.kind === "Candle" || node.kind === "Entry" || node.kind === "BarsSinceEntry") return;
  if (node.kind === "Field") {
    collect(node.base, label, out);
    return;
  }
  if (node.kind === "Offset") {
    collect(node.base, label, out);
    // The parser drops the numeric token span, so synthesize it: the digits sit
    // just before the closing "]" (node.end points one past it).
    const synthEnd = node.end - 1;
    const synthStart = synthEnd - String(node.n).length;
    out.push({ num: { kind: "Num", value: node.n, start: synthStart, end: synthEnd }, label: "bar offset" });
    return;
  }
  if (node.kind === "Tf") {
    collect(node.base, label, out);
    return;
  }
  if (node.kind === "Unary") {
    collect(node.operand, label, out);
    return;
  }
  if (node.kind === "Binary") {
    if (node.op === "*") {
      for (const [a, b] of [[node.left, node.right], [node.right, node.left]] as [Node, Node][]) {
        if (a.kind === "Num" && hasIndicator(b)) {
          out.push({ num: a, label: `multiplier of ${render(b)}` });
        } else if (a.kind === "Num") {
          collect(a, "constant", out);
        } else {
          collect(a, label, out);
        }
      }
      return;
    }
    collect(node.left, label, out);
    collect(node.right, label, out);
    return;
  }
  if (node.kind === "Call") {
    if (Object.hasOwn(WRAPPER_ARITY, node.name)) {
      // Arity is NOT guaranteed here: `analyze` extracts literals on the error
      // path too, so a half-typed `slope.x` / `avg(x)` reaches this branch with
      // fewer args than the wrapper takes. Missing args are simply skipped, so
      // the caller gets the typed bad_arity/field_on_call error instead of a
      // TypeError. Mirrored by the backend's literals.py::_collect.
      if (node.args[0]) collect(node.args[0], label, out);
      if (node.args[1] && node.args[1].kind === "Num") {
        out.push({ num: node.args[1], label: `${node.name} window` });
      } else if (node.args[1]) {
        collect(node.args[1], "constant", out);
      }
      return;
    }
    if (Object.hasOwn(INDICATOR_SPECS, node.name)) {
      const kind = node.name === "AVWAP" ? "anchor" : "length";
      for (const a of node.args) {
        if (a.kind === "Num") {
          out.push({ num: a, label: `${node.name} ${kind}` });
        } else {
          collect(a, label, out);
        }
      }
      return;
    }
  }
  if (node.kind === "Predicate") {
    collect(node.base, label, out);
    return;
  }
  if (node.kind === "Count") {
    const cond = node.cond;
    if (cond.kind === "Predicate") {
      collect(cond.base, "constant", out);
    } else if (cond.kind === "Cross") {
      collect(cond.a, "constant", out);
      collect(cond.b, "constant", out);
    } else {
      collect(cond.left, "constant", out);
      collect(cond.right, "constant", out);
    }
    if (node.window.kind === "Num") {
      out.push({ num: node.window, label: "count window" });
    } else {
      collect(node.window, "constant", out);
    }
    return;
  }
}

function collectSide(side: Node, out: Collected[]): void {
  if (side.kind === "Num") {
    out.push({ num: side, label: "threshold" });
    return;
  }
  collect(side, "threshold", out);
}

function collectPartSide(part: CompareNode | CrossNode, side: Node, out: Collected[]): void {
  // A cross part's numerics follow the top-level Cross rule ("constant");
  // a compare part's follow the threshold rule.
  if (part.kind === "Cross") collect(side, "constant", out);
  else collectSide(side, out);
}

function literalsOf(node: Row): LiteralSpan[] {
  const out: Collected[] = [];
  if (node.kind === "Predicate") {
    collect(node.base, "constant", out);
    out.sort((x, y) => x.num.start - y.num.start);
    return out.map((c, ordinal) => ({
      ordinal,
      value: c.num.value,
      from: c.num.start,
      to: c.num.end,
      label: c.label,
    }));
  }
  if (node.kind === "Chain") {
    const first = node.parts[0];
    collectPartSide(first, partOperands(first)[0], out);
    for (const p of node.parts) collectPartSide(p, partOperands(p)[1], out);
  } else if (node.kind === "Compare") {
    collectSide(node.left, out);
    collectSide(node.right, out);
  } else {
    collect(node.a, "constant", out);
    collect(node.b, "constant", out);
  }
  out.sort((x, y) => x.num.start - y.num.start);
  return out.map((c, ordinal) => ({
    ordinal,
    value: c.num.value,
    from: c.num.start,
    to: c.num.end,
    label: c.label,
  }));
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function analyze(
  src: string,
  opts?: { isExit?: boolean; instances?: readonly ExprInstance[] },
): AnalyzeResult {
  const isExit = opts?.isExit ?? false;
  // The live chart's panes are injected here, never imported: the pane settings
  // are the source of truth and the editor gets the list from the chart.
  const instances = instanceMap(opts?.instances);
  const { tokens: lexTokens, error: lexError } = tokenize(src);
  const tokens: Token[] = lexTokens
    .filter((t) => t.type !== "EOF")
    .map((t) => ({ type: t.type, from: t.start, to: t.end }));

  if (lexError) {
    return result(tokens, [], lexError);
  }

  let ast: Row;
  try {
    ast = new Parser(lexTokens).parseRow();
  } catch (e) {
    if (e instanceof ExprErr) return result(tokens, [], e);
    throw e;
  }

  try {
    validate(ast, isExit, instances);
  } catch (e) {
    if (e instanceof ExprErr) return result(tokens, literalsOf(ast), e);
    throw e;
  }

  return result(tokens, literalsOf(ast), null);
}

function result(tokens: Token[], literals: LiteralSpan[], err: ExprErr | null): AnalyzeResult {
  const error = err ? toExprError(err) : null;
  return { tokens, literals, error, errors: error ? [error] : [] };
}

function toExprError(e: ExprErr): ExprError {
  return { code: e.code, message: e.message, from: e.start, to: e.end };
}

/** Warm-up bars an expression needs from the BASE candle history before its
 * first honest value, mirroring the backend authority
 * (strategy/expr/warmup.py::warmup_bars): an indicator's length, a wrapper's
 * window plus its inner term, an offset's bar count, maxed across a
 * comparison's two sides. When `baseSeconds` is given, an @tf pin contributes
 * ZERO base bars — the pinned series is computed from its own higher-timeframe
 * candles, which the EXPRESSION routes source and sufficiency-check
 * (expr.py::_ensure_htf) — the coded path instead fetches a flat
 * _HTF_WARMUP_BARS floor — never
 * derived from the base history — while terms OUTSIDE the pin (offsets,
 * wrappers on the base-aligned series) still count. Without `baseSeconds` a pin
 * passes through unscaled (legacy callers that only ever see base-timeframe
 * rows). Returns 0 for an empty or unparseable expression so a bad row never
 * blocks sizing (the lint/validate layer surfaces the error elsewhere). */
export function warmupOf(
  src: string,
  baseSeconds?: number,
  instances?: readonly ExprInstance[],
  warmupByRef?: (instance: string, output: string) => number,
): number {
  const trimmed = src.trim();
  if (!trimmed) return 0;
  const { tokens, error } = tokenize(trimmed);
  if (error) return 0;
  let ast: Row;
  try {
    ast = new Parser(tokens).parseRow();
  } catch {
    return 0;
  }
  return warmupNode(ast, baseSeconds, { instances: instanceMap(instances), warmupByRef });
}

/** The ref-resolution half of warm-up, injected by the caller (the editor pulls
 * an instance's own warm-up from the chart's indicator specs, which this file
 * must not import). */
interface WarmupRefs {
  instances: InstanceMap;
  warmupByRef?: (instance: string, output: string) => number;
}

const NO_REFS: WarmupRefs = { instances: NO_INSTANCES };

function warmupNode(node: Node | ChainNode, baseSeconds: number | undefined, refs: WarmupRefs = NO_REFS): number {
  switch (node.kind) {
    case "Chain": return Math.max(...node.parts.map((p) => warmupNode(p, baseSeconds, refs)));
    case "Compare": return Math.max(warmupNode(node.left, baseSeconds, refs), warmupNode(node.right, baseSeconds, refs));
    case "Cross": return Math.max(warmupNode(node.a, baseSeconds, refs), warmupNode(node.b, baseSeconds, refs));
    case "Num": case "Candle": case "Entry": return 0;
    case "Field": return warmupNode(node.base, baseSeconds, refs);
    case "Offset": return warmupNode(node.base, baseSeconds, refs) + node.n;
    case "Tf":
      return knownBase(baseSeconds) ? 0 : warmupNode(node.base, undefined, refs);
    case "Unary": return warmupNode(node.operand, baseSeconds, refs);
    case "Binary": return Math.max(warmupNode(node.left, baseSeconds, refs), warmupNode(node.right, baseSeconds, refs));
    case "Predicate":
      // Pattern predicates need the detector's epsilon/lookback history;
      // bullish/bearish are single-bar and stay at 0.
      return (
        (PATTERN_FN_SET.has(node.fn) ? PATTERN_WARMUP : 0) +
        warmupNode(node.base, baseSeconds, refs)
      );
    case "BarsSinceEntry": return 0;
    case "Count": {
      const w = node.window;
      const n = w.kind === "Num" ? Math.trunc(w.value) : 0;
      return n + warmupNode(node.cond, baseSeconds, refs);
    }
    case "IndicatorRef": {
      const inst = refs.instances.get(node.instance);
      if (inst === undefined) return 0;
      // An instance pinned in its own settings is warmed from its own HTF
      // history, exactly like an @tf pin — it costs zero BASE bars.
      if (inst.timeframe && knownBase(baseSeconds)) return 0;
      return refs.warmupByRef ? refs.warmupByRef(node.instance, node.output) : 0;
    }
    case "Call": {
      if (Object.hasOwn(WRAPPER_ARITY, node.name)) {
        const w = node.args[1];
        const n = w && w.kind === "Num" ? Math.trunc(w.value) : 0;
        return (node.args[0] ? warmupNode(node.args[0], baseSeconds, refs) : 0) + n;
      }
      const spec = Object.hasOwn(INDICATOR_SPECS, node.name) ? INDICATOR_SPECS[node.name] : undefined;
      if (spec && spec.argKind === "length" && node.args.length > 0) {
        const a = node.args[0];
        return a && a.kind === "Num" ? Math.trunc(a.value) : 0;
      }
      return 0;
    }
    default: return 0;
  }
}

/** True when the caller told us the base timeframe — the condition under which a
 * pinned series (an @tf pin OR an instance pinned in its own settings) costs
 * ZERO base bars. Shared so the two pin shapes can never disagree. */
function knownBase(baseSeconds: number | undefined): boolean {
  return baseSeconds != null && baseSeconds > 0;
}
