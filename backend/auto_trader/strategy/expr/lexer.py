from __future__ import annotations

from dataclasses import dataclass

from auto_trader.strategy.expr.errors import ExprError

_SINGLE = {
    "(": "LPAREN", ")": "RPAREN", ",": "COMMA", "+": "PLUS", "-": "MINUS",
    "*": "STAR", "/": "SLASH", "[": "LBRACKET", "]": "RBRACKET", "@": "AT", ".": "DOT",
}


@dataclass(frozen=True, slots=True)
class Token:
    type: str
    value: str
    start: int
    end: int


def tokenize(src: str) -> list[Token]:
    out: list[Token] = []
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if c.isspace():
            i += 1
            continue
        if c.isdigit() or (c == "." and i + 1 < n and src[i + 1].isdigit()):
            j = i
            seen_dot = False
            while j < n and (src[j].isdigit() or (src[j] == "." and not seen_dot)):
                if src[j] == ".":
                    seen_dot = True
                j += 1
            # If we have alphanumeric after this, it's a NAME, not a NUMBER
            if j < n and (src[j].isalpha() or src[j] == "_"):
                # Continue reading as a NAME
                while j < n and (src[j].isalnum() or src[j] == "_"):
                    j += 1
                out.append(Token("NAME", src[i:j], i, j))
            else:
                # It's a pure NUMBER
                out.append(Token("NUMBER", src[i:j], i, j))
            i = j
            continue
        if c.isalpha() or c == "_":
            j = i
            # "#" is legal INSIDE a name (never leading) so a chart indicator's
            # instance id — "SLOPE#a1b2c3", minted by the frontend's
            # mintInstanceId — lexes verbatim, with no id<->token mapping table.
            while j < n and (src[j].isalnum() or src[j] in "_#"):
                j += 1
            word = src[i:j]
            # A bare "x" fused to a comparison bracket is the infix cross
            # operator: x> (crosses above) / x< (crosses below).
            if word == "x" and j < n and src[j] in "<>":
                out.append(Token("XGT" if src[j] == ">" else "XLT", src[i:j + 1], i, j + 1))
                i = j + 1
                continue
            out.append(Token("NAME", word, i, j))
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
        if c in _SINGLE:
            out.append(Token(_SINGLE[c], c, i, i + 1))
            i += 1
            continue
        raise ExprError("bad_char", f"Unexpected character {c!r}.", i, i + 1)
    out.append(Token("EOF", "", n, n))
    return out
