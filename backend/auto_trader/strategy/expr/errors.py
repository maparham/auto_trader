from __future__ import annotations


class ExprError(Exception):
    """A parse/validation problem with a character span into the source expression.

    `code` is a stable machine-readable slug (checked by tests and by the
    frontend parity corpus); `message` is plain user-facing copy shown in the
    editor's lint underline (no em dashes)."""

    def __init__(self, code: str, message: str, start: int, end: int):
        super().__init__(message)
        self.code = code
        self.message = message
        self.start = start
        self.end = end


# Shared by the lexer (x>= / x<=) and the parser (bare x in operand or trailing
# position) so every spelling of a mistyped cross operator gets the SAME copy.
# Kept here, not in parser.py, because lexer.py cannot import from parser.py.
BAD_CROSS_MSG = "Write the cross operator as x> or x< — lowercase, no space."
