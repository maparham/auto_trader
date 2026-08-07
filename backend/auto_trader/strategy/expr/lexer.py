from __future__ import annotations

from dataclasses import dataclass

from auto_trader.strategy.expr.errors import BAD_CROSS_MSG, BAD_EQ_MSG, ExprError

_SINGLE = {
    "(": "LPAREN", ")": "RPAREN", ",": "COMMA", "+": "PLUS", "-": "MINUS",
    "*": "STAR", "/": "SLASH", "[": "LBRACKET", "]": "RBRACKET", "@": "AT", ".": "DOT",
}


# ASCII-only character classes, matching the TS mirror's explicit ranges. Python's
# str.isalpha/isalnum/isdigit accept unicode (Cyrillic "ЕМА", fullwidth "ｘ",
# Arabic-Indic "٩"), which would make such input parse differently here than in
# the editor; restricted like this, it falls through to bad_char on both stacks.
# (Whitespace deliberately keeps str.isspace(): the TS mirror uses /\s/, which is
# unicode-aware too, so NBSP is skipped by both.)
def _is_digit(c: str) -> bool:
    return "0" <= c <= "9"


def _is_alpha(c: str) -> bool:
    return ("a" <= c <= "z") or ("A" <= c <= "Z")


def _is_alnum(c: str) -> bool:
    return _is_digit(c) or _is_alpha(c)


@dataclass(frozen=True, slots=True)
class Token:
    type: str
    value: str
    start: int
    end: int


# A "." starts a decimal literal (.5) only when nothing that can be FOLLOWED by
# a field access was just emitted. After a NAME, a ")" or a "]", the "." is
# always postfix field access — there is no valid expression in this grammar
# where a name, ")" or "]" is directly followed by a number. Without this,
# `SLOPE.9` lexes as NAME + NUMBER(.9), swallowing the output name as the
# decimal 0.9; with it, `2 + .5` and a leading `.5` keep lexing as before.
_NO_LEADING_DOT_NUMBER = frozenset({"NAME", "RPAREN", "RBRACKET"})

# Reserved boolean keywords. Exactly the lowercase and the ALL-uppercase
# spellings are reserved; a mixed-case "And"/"Not" stays a plain name
# (-> unknown_name). The token type is the same for both spellings, so
# highlighting and completion never have to look at the value.
_KEYWORDS = {
    "and": "AND", "or": "OR", "not": "NOT",
    "AND": "AND", "OR": "OR", "NOT": "NOT",
}


def tokenize(src: str) -> list[Token]:
    out: list[Token] = []
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if c.isspace():
            i += 1
            continue
        starts_decimal = (
            c == "."
            and i + 1 < n
            and _is_digit(src[i + 1])
            and (not out or out[-1].type not in _NO_LEADING_DOT_NUMBER)
        )
        if _is_digit(c) or starts_decimal:
            # Straight after a ".", a digit run is an OUTPUT NAME (a pane's
            # lengths name its outputs), so it takes digits and nothing else.
            # Without this the timeframe fusion below swallows the rest:
            # `X.9.foo` would lex as one NAME "9.foo" instead of
            # NUMBER(9) DOT NAME(foo), hiding the stray field behind a
            # confusing unknown-output error.
            if out and out[-1].type == "DOT":
                j = i
                while j < n and _is_digit(src[j]):
                    j += 1
                out.append(Token("NUMBER", src[i:j], i, j))
                i = j
                continue
            j = i
            seen_dot = False
            while j < n and (_is_digit(src[j]) or (src[j] == "." and not seen_dot)):
                if src[j] == ".":
                    seen_dot = True
                j += 1
            # If we have alphanumeric after this, it's a NAME, not a NUMBER
            if j < n and (_is_alpha(src[j]) or src[j] == "_"):
                # Continue reading as a NAME
                while j < n and (_is_alnum(src[j]) or src[j] == "_"):
                    j += 1
                out.append(Token("NAME", src[i:j], i, j))
            else:
                # It's a pure NUMBER
                out.append(Token("NUMBER", src[i:j], i, j))
            i = j
            continue
        if _is_alpha(c) or c == "_":
            j = i
            # "#" is legal INSIDE a name (never leading) so a chart indicator's
            # instance id — "SLOPE#a1b2c3", minted by the frontend's
            # mintInstanceId — lexes verbatim, with no id<->token mapping table.
            while j < n and (_is_alnum(src[j]) or src[j] in "_#"):
                j += 1
            word = src[i:j]
            # A bare "x" fused to a comparison bracket is the infix cross
            # operator: x> (crosses above) / x< (crosses below).
            if word == "x" and j < n and src[j] in "<>":
                # "x>=" / "x<=" is a near-miss for the operator, not a fused
                # bracket plus a stray "="; report the whole thing with the
                # cross-operator copy instead of bad_char on the "=".
                if j + 1 < n and src[j + 1] == "=":
                    raise ExprError("bad_cross_op", BAD_CROSS_MSG, i, j + 2)
                out.append(Token("XGT" if src[j] == ">" else "XLT", src[i:j + 1], i, j + 1))
                i = j + 1
                continue
            out.append(Token(_KEYWORDS.get(word, "NAME"), word, i, j))
            i = j
            continue
        if c in "<>":
            if i + 1 < n and src[i + 1] == "=":
                out.append(Token("GE" if c == ">" else "LE", src[i:i + 2], i, i + 2))
                i += 2
            else:
                out.append(Token("GT" if c == ">" else "LT", c, i, i + 1))
                i += 1
            continue
        if c == "=":
            # ">=" and "<=" are consumed by the "<>" branch above, so a "=" here
            # is either "==" or a lone "=" — and a lone "=" is always a mistyped
            # equality, never anything else in this grammar.
            if i + 1 < n and src[i + 1] == "=":
                out.append(Token("EQ", "==", i, i + 2))
                i += 2
                continue
            raise ExprError("bad_eq_op", BAD_EQ_MSG, i, i + 1)
        if c in _SINGLE:
            out.append(Token(_SINGLE[c], c, i, i + 1))
            i += 1
            continue
        raise ExprError("bad_char", f"Unexpected character {c!r}.", i, i + 1)
    out.append(Token("EOF", "", n, n))
    return out
