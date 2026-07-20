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
