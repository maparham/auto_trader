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
  WRAPPER_ARITY,
} from "./catalog";

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
interface ChainNode { kind: "Chain"; parts: CompareNode[]; start: number; end: number; }

type Node =
  | NumNode | CandleNode | EntryNode | CallNode | FieldNode | OffsetNode
  | TfNode | UnaryNode | BinaryNode | CompareNode | CrossNode;

type Row = CompareNode | CrossNode | ChainNode;

function containsTf(node: Node): boolean {
  if (node.kind === "Tf") return true;
  if (node.kind === "Field" || node.kind === "Offset") return containsTf(node.base);
  if (node.kind === "Unary") return containsTf(node.operand);
  if (node.kind === "Call") return node.args.some(containsTf);
  if (node.kind === "Binary" || node.kind === "Compare") return containsTf(node.left) || containsTf(node.right);
  if (node.kind === "Cross") return containsTf(node.a) || containsTf(node.b);
  return false;
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
      while (j < n && (isAlnum(src[j]) || src[j] === "_")) j += 1;
      out.push({ type: "NAME", value: src.slice(i, j), start: i, end: j });
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

const CMP_TYPES = new Set(["GT", "LT", "GE", "LE"]);

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
    if (op.type !== "GT" && op.type !== "LT" && op.type !== "GE" && op.type !== "LE") {
      throw new ExprErr("expected_operator", "Expected a comparison operator (> < >= <=).", op.start, op.end);
    }
    const symOf: Record<string, string> = { GT: ">", LT: "<", GE: ">=", LE: "<=" };
    const parts: CompareNode[] = [];
    let operand: Node = left;
    while (CMP_TYPES.has(this.peek().type)) {
      const optok = this.next();
      const right = this.parseArith();
      parts.push({ kind: "Compare", op: symOf[optok.type], left: operand, right, start: operand.start, end: right.end });
      operand = right;
    }
    this.expect("EOF");
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
      return { kind: "Call", name: name.value, args: [], start: name.start, end: name.end };
    }
    throw new ExprErr("unexpected_token", "Expected a value here.", t.start, t.end);
  }

  private parsePostfix(node: Node): Node {
    for (;;) {
      const t = this.peek();
      if (t.type === "DOT") {
        this.next();
        const field = this.expect("NAME");
        if (node.kind === "Candle") {
          node = { kind: "Candle", field: field.value, start: node.start, end: field.end };
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

function validate(node: Row, isExit: boolean): void {
  if (node.kind === "Chain") {
    for (const p of node.parts) {
      walk(p.left, isExit);
      walk(p.right, isExit);
    }
    return;
  }
  if (node.kind === "Cross") {
    walk(node.a, isExit);
    walk(node.b, isExit);
    return;
  }
  walk(node.left, isExit);
  walk(node.right, isExit);
}

function walk(node: Node, isExit: boolean): void {
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
      if (root.kind === "Call" && (root.name in INDICATOR_SPECS || root.name in WRAPPER_ARITY)) {
        throw new ExprErr("field_on_call", `${root.name} has no named outputs.`, node.start, node.end);
      }
      walk(node.base, isExit);
      return;
    }
    case "Offset":
    case "Tf":
      walk(node.base, isExit);
      return;
    case "Unary":
      walk(node.operand, isExit);
      return;
    case "Binary":
      walk(node.left, isExit);
      walk(node.right, isExit);
      return;
    case "Compare":
    case "Cross":
      throw new ExprErr("cross_not_toplevel", "A comparison or cross can only be the whole row.", node.start, node.end);
    case "Call": {
      if (CROSS_SET.has(node.name)) {
        throw new ExprErr("cross_not_toplevel", `${node.name} can only be the whole row.`, node.start, node.end);
      }
      if (node.name in INDICATOR_SPECS) {
        const spec = INDICATOR_SPECS[node.name];
        if (node.args.length !== spec.arity) {
          throw new ExprErr("bad_arity", `${node.name} takes ${spec.arity} argument(s).`, node.start, node.end);
        }
        for (const a of node.args) walk(a, isExit);
        return;
      }
      if (node.name in WRAPPER_ARITY) {
        const arity = WRAPPER_ARITY[node.name];
        if (node.args.length !== arity) {
          throw new ExprErr("bad_arity", `${node.name} takes ${arity} arguments.`, node.start, node.end);
        }
        for (const a of node.args) walk(a, isExit);
        return;
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
  if (node.kind === "Call" && node.name in INDICATOR_SPECS) return true;
  if (node.kind === "Call") return node.args.some(hasIndicator);
  if (node.kind === "Field" || node.kind === "Offset" || node.kind === "Tf") return hasIndicator(node.base);
  if (node.kind === "Unary") return hasIndicator(node.operand);
  if (node.kind === "Binary") return hasIndicator(node.left) || hasIndicator(node.right);
  return false;
}

function collect(node: Node, label: string, out: Collected[]): void {
  if (node.kind === "Num") {
    out.push({ num: node, label });
    return;
  }
  if (node.kind === "Candle" || node.kind === "Entry") return;
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
    if (node.name in WRAPPER_ARITY) {
      collect(node.args[0], label, out);
      if (node.args[1] && node.args[1].kind === "Num") {
        out.push({ num: node.args[1], label: `${node.name} window` });
      } else if (node.args[1]) {
        collect(node.args[1], "constant", out);
      }
      return;
    }
    if (node.name in INDICATOR_SPECS) {
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
}

function collectSide(side: Node, out: Collected[]): void {
  if (side.kind === "Num") {
    out.push({ num: side, label: "threshold" });
    return;
  }
  collect(side, "threshold", out);
}

function literalsOf(node: Row): LiteralSpan[] {
  const out: Collected[] = [];
  if (node.kind === "Chain") {
    collectSide(node.parts[0].left, out);
    for (const p of node.parts) collectSide(p.right, out);
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

export function analyze(src: string, opts?: { isExit?: boolean }): AnalyzeResult {
  const isExit = opts?.isExit ?? false;
  const { tokens: lexTokens, error: lexError } = tokenize(src);
  const tokens: Token[] = lexTokens
    .filter((t) => t.type !== "EOF")
    .map((t) => ({ type: t.type, from: t.start, to: t.end }));

  if (lexError) {
    return { tokens, literals: [], error: toExprError(lexError) };
  }

  let ast: Row;
  try {
    ast = new Parser(lexTokens).parseRow();
  } catch (e) {
    if (e instanceof ExprErr) return { tokens, literals: [], error: toExprError(e) };
    throw e;
  }

  try {
    validate(ast, isExit);
  } catch (e) {
    if (e instanceof ExprErr) return { tokens, literals: literalsOf(ast), error: toExprError(e) };
    throw e;
  }

  return { tokens, literals: literalsOf(ast), error: null };
}

function toExprError(e: ExprErr): ExprError {
  return { code: e.code, message: e.message, from: e.start, to: e.end };
}

/** Warm-up bars an expression needs before its first honest value, mirroring the
 * backend authority (strategy/expr/warmup.py::warmup_bars): an indicator's length,
 * a wrapper's window plus its inner term, an offset's bar count, maxed across a
 * comparison's two sides. No timeframe scaling (a @tf term passes through), matching
 * the v1 HTF limitation. Returns 0 for an empty or unparseable expression so a bad
 * row never blocks sizing (the lint/validate layer surfaces the error elsewhere). */
export function warmupOf(src: string): number {
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
  return warmupNode(ast);
}

function warmupNode(node: Node | ChainNode): number {
  switch (node.kind) {
    case "Chain": return Math.max(...node.parts.map(warmupNode));
    case "Compare": return Math.max(warmupNode(node.left), warmupNode(node.right));
    case "Cross": return Math.max(warmupNode(node.a), warmupNode(node.b));
    case "Num": case "Candle": case "Entry": return 0;
    case "Field": return warmupNode(node.base);
    case "Offset": return warmupNode(node.base) + node.n;
    case "Tf": return warmupNode(node.base);
    case "Unary": return warmupNode(node.operand);
    case "Binary": return Math.max(warmupNode(node.left), warmupNode(node.right));
    case "Call": {
      if (node.name in WRAPPER_ARITY) {
        const w = node.args[1];
        const n = w && w.kind === "Num" ? Math.trunc(w.value) : 0;
        return (node.args[0] ? warmupNode(node.args[0]) : 0) + n;
      }
      const spec = INDICATOR_SPECS[node.name];
      if (spec && spec.argKind === "length" && node.args.length > 0) {
        const a = node.args[0];
        return a && a.kind === "Num" ? Math.trunc(a.value) : 0;
      }
      return 0;
    }
    default: return 0;
  }
}
