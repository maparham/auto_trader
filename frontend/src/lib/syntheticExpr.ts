// Pure expression helpers for synthetic charts. Detection + symbol extraction +
// a stable id. Evaluation of candles happens server-side (see /api/candles/synthetic).

// A string is synthetic if it carries an operator/paren that a plain epic never
// does. Bare "-" is treated as part of a token (epics like CS.D... use dots, and
// we don't want a hyphen inside a symbol to misfire), so subtraction must be
// SPACED (" - "). "* / ( ) +" always mark an expression.
export function isSyntheticExpr(input: string): boolean {
  const s = input.trim();
  if (!s) return false;
  if (/[*/()+]/.test(s)) return true;
  if (/\s-\s/.test(s)) return true;
  return false;
}

interface Tok {
  kind: "num" | "symbol" | "op";
  value: string;
}

// Numbers first so "US500" is a symbol but "500" is a constant.
const TOKEN = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_.]*)|([()+\-*/]))/y;

function tokenize(expr: string): Tok[] {
  const toks: Tok[] = [];
  TOKEN.lastIndex = 0;
  let i = 0;
  while (i < expr.length) {
    if (/\s/.test(expr[i])) {
      i++;
      continue;
    }
    TOKEN.lastIndex = i;
    const m = TOKEN.exec(expr);
    if (!m || m.index !== i) throw new Error(`unexpected character: ${expr.slice(i, i + 8)}`);
    i = TOKEN.lastIndex;
    if (m[1] !== undefined) toks.push({ kind: "num", value: m[1] });
    else if (m[2] !== undefined) toks.push({ kind: "symbol", value: m[2].toUpperCase() });
    else toks.push({ kind: "op", value: m[3] });
  }
  if (toks.length === 0) throw new Error("empty expression");
  return toks;
}

// Validate structure by walking the same grammar as the backend, collecting symbols.
// Recursive descent: expr = term ((+|-) term)*; term = factor ((*|/) factor)*;
// factor = '-' factor | '(' expr ')' | num | symbol.
function parseTokens(toks: Tok[]): string[] {
  let pos = 0;
  const symbols: string[] = [];
  const peek = () => toks[pos];
  const eat = () => toks[pos++];

  function expr(): void {
    term();
    while (peek() && peek().kind === "op" && (peek().value === "+" || peek().value === "-")) {
      eat();
      term();
    }
  }
  function term(): void {
    factor();
    while (peek() && peek().kind === "op" && (peek().value === "*" || peek().value === "/")) {
      eat();
      factor();
    }
  }
  function factor(): void {
    const t = peek();
    if (!t) throw new Error("unexpected end of expression");
    if (t.kind === "op" && t.value === "-") {
      eat();
      factor();
      return;
    }
    if (t.kind === "op" && t.value === "(") {
      eat();
      expr();
      if (!peek() || peek().value !== ")") throw new Error("unbalanced parentheses");
      eat();
      return;
    }
    const tok = eat();
    if (tok.kind === "num") return;
    if (tok.kind === "symbol") {
      if (!symbols.includes(tok.value)) symbols.push(tok.value);
      return;
    }
    throw new Error(`unexpected token: ${tok.value}`);
  }

  expr();
  if (pos !== toks.length) throw new Error(`unexpected token: ${toks[pos].value}`);
  return symbols;
}

export function parseSymbols(expr: string): string[] {
  return parseTokens(tokenize(expr));
}

// Textual canonical form: single-spaced, symbols upper-cased, no algebraic rewriting
// (A/B stays distinct from B/A). Deterministic so the id is stable.
export function canonicalize(expr: string): string {
  const toks = tokenize(expr);
  const parts: string[] = [];
  for (const t of toks) {
    if (t.kind === "op" && (t.value === "(" )) parts.push("(");
    else parts.push(t.value);
  }
  // Space every token, then tidy spaces just inside parentheses.
  return parts.join(" ").replace(/\(\s+/g, "( ").replace(/\s+\)/g, " )").trim();
}

// Stable 32-bit FNV-1a hash of the canonical form, base36 -> SYN_<hash>.
export function syntheticId(expr: string): string {
  const s = canonicalize(expr);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return "SYN_" + (h >>> 0).toString(36);
}

// Index of the last operator/paren that separates symbols, or -1. A bare "-" is NOT
// a boundary — only a SPACED minus (whitespace before it) is subtraction — so this
// agrees with isSyntheticExpr, which ignores bare dashes. Otherwise a typed "A-"
// followed by a pick would strand the box in a not-formula-but-split state.
function lastOpIndex(text: string): number {
  let last = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "-") {
      if (i > 0 && /\s/.test(text[i - 1])) last = i;
    } else if ("+*/()".includes(ch)) {
      last = i;
    }
  }
  return last;
}

/** The symbol the user is currently typing: text after the last operator/paren, trimmed. */
export function activeSymbolFragment(text: string): string {
  return text.slice(lastOpIndex(text) + 1).trim();
}

/** `text` with the active symbol fragment replaced by `epic`, spacing normalized. */
export function insertSymbol(text: string, epic: string): string {
  if (!text.trim()) return epic;
  const last = lastOpIndex(text);
  if (last < 0) return epic; // no operator yet: the box is one symbol fragment
  const head = text.slice(0, last + 1).replace(/\s*$/, ""); // up to & incl the operator
  return `${head} ${epic}`;
}
