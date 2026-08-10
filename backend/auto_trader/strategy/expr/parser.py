from __future__ import annotations

from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.errors import BAD_CROSS_MSG, ExprError
from auto_trader.strategy.expr.lexer import Token, tokenize
from auto_trader.strategy.expr.registry import INDICATORS, WRAPPERS

_CMP_SYM = {"GT": ">", "LT": "<", "GE": ">=", "LE": "<=", "EQ": "=="}
_CROSS_SYM = {"XGT": "crossAbove", "XLT": "crossBelow"}
# One source of truth for the comparison set. Every condition — a row, an
# and/or/not operand, count's first argument — goes through parse_condition_unit,
# which accepts these plus the cross operators. Keeping the set derived means a
# new operator cannot land in one place and miss another.
_CMP_OPS = ("GT", "LT", "GE", "LE", "EQ")
_ROW_OPS = _CMP_OPS + ("XGT", "XLT")
# Re-exported under the module-private name the parser has always used; the
# string itself lives in errors.py so the lexer's x>= branch shares it byte
# for byte.
_BAD_CROSS_MSG = BAD_CROSS_MSG


class _Parser:
    def __init__(self, tokens: list[Token]):
        self.toks = tokens
        self.i = 0

    def peek(self) -> Token:
        return self.toks[self.i]

    def next(self) -> Token:
        t = self.toks[self.i]
        self.i += 1
        return t

    def expect(self, type_: str) -> Token:
        t = self.peek()
        if t.type != type_:
            if t.type in _CROSS_SYM:
                raise ExprError("cross_not_toplevel", "A comparison or cross can't be used as a value.", t.start, t.end)
            # A leftover bare "x" where the grammar wanted something else (most
            # often a trailing "EMA(9) x> EMA(50) x") is a half-typed cross
            # operator, not a generic surprise token.
            if t.type == "NAME" and t.value in ("x", "X"):
                raise ExprError("bad_cross_op", _BAD_CROSS_MSG, t.start, t.end)
            raise ExprError("unexpected_token", f"Expected {type_.lower()} here.", t.start, t.end)
        return self.next()

    # row := orExpr EOF
    def parse_row(self) -> N.Row:
        node = self.parse_or()
        if not isinstance(node, N.CONDITION_KINDS):
            self._raise_expected_operator()
        self.expect("EOF")
        return node

    # orExpr := andExpr ("or" andExpr)*
    def parse_or(self) -> N.Node:
        left = self.parse_and()
        if self.peek().type != "OR":
            return left
        parts = [left]
        while self.peek().type == "OR":
            self.next()
            parts.append(self.parse_and())
        for p in parts:
            self._require_condition(p)
        return N.BoolOp("or", parts, parts[0].start, parts[-1].end)

    # andExpr := notExpr ("and" notExpr)*
    def parse_and(self) -> N.Node:
        left = self.parse_not()
        if self.peek().type != "AND":
            return left
        parts = [left]
        while self.peek().type == "AND":
            self.next()
            parts.append(self.parse_not())
        for p in parts:
            self._require_condition(p)
        return N.BoolOp("and", parts, parts[0].start, parts[-1].end)

    # notExpr := "not" notExpr | conditionUnit
    def parse_not(self) -> N.Node:
        t = self.peek()
        if t.type == "NOT":
            self.next()
            operand = self.parse_not()
            # The error span is the operand's own span (what the user must fix);
            # the Not node's span still opens at the `not` keyword.
            self._require_condition(operand)
            return N.Not(operand, t.start, operand.end)
        return self.parse_condition_unit()

    # conditionUnit := crossfn "(" arith "," arith ")" | arith (cmpop arith)*
    # Returns a bare arith Node when no comparison follows — the caller decides
    # whether that is legal (a paren group) or an error (a row, an and/or/not
    # operand, count's condition).
    def parse_condition_unit(self) -> N.Node:
        t = self.peek()
        if t.type == "NAME" and t.value in N.CROSS_FNS and self.toks[self.i + 1].type == "LPAREN":
            fn = self.next()
            self.expect("LPAREN")
            a = self.parse_arith()
            self.expect("COMMA")
            b = self.parse_arith()
            close = self.expect("RPAREN")
            return N.Cross(fn.value, a, b, fn.start, close.end)
        left = self.parse_arith()
        if self.peek().type not in _ROW_OPS:
            return left
        parts: list[N.Compare | N.Cross] = []
        operand = left
        while self.peek().type in _ROW_OPS:
            optok = self.next()
            right = self.parse_arith()
            if optok.type in _CROSS_SYM:
                parts.append(N.Cross(_CROSS_SYM[optok.type], operand, right, operand.start, right.end))
            else:
                parts.append(N.Compare(_CMP_SYM[optok.type], operand, right, operand.start, right.end))
            operand = right
        if len(parts) == 1:
            return parts[0]
        return N.Chain(parts, parts[0].start, parts[-1].end)

    def _require_condition(self, node: N.Node) -> None:
        if not isinstance(node, N.CONDITION_KINDS):
            raise ExprError(
                "expected_condition",
                "and, or and not need a condition, like candle.close > EMA(9).",
                node.start, node.end,
            )

    def _raise_expected_operator(self) -> None:
        op = self.peek()
        if op.type == "NAME" and op.value in ("x", "X"):
            raise ExprError("bad_cross_op", _BAD_CROSS_MSG, op.start, op.end)
        raise ExprError("expected_operator", "Expected a comparison operator (> < >= <= == x> x<).", op.start, op.end)

    def parse_arith(self) -> N.Node:
        node = self.parse_term()
        while self.peek().type in ("PLUS", "MINUS"):
            op = self.next()
            right = self.parse_term()
            node = N.Binary("+" if op.type == "PLUS" else "-", node, right, node.start, right.end)
        return node

    def parse_term(self) -> N.Node:
        node = self.parse_factor()
        while self.peek().type in ("STAR", "SLASH"):
            op = self.next()
            right = self.parse_factor()
            node = N.Binary("*" if op.type == "STAR" else "/", node, right, node.start, right.end)
        return node

    def parse_factor(self) -> N.Node:
        t = self.peek()
        if t.type == "MINUS":
            self.next()
            operand = self.parse_factor()
            return N.Unary(operand, t.start, operand.end)
        node = self.parse_primary()
        return self.parse_postfix(node)

    def parse_primary(self) -> N.Node:
        t = self.peek()
        if t.type == "NUMBER":
            self.next()
            return N.Num(float(t.value), t.start, t.end)
        if t.type == "LPAREN":
            self.next()
            inner = self.parse_or()
            close = self.expect("RPAREN")
            if isinstance(inner, N.CONDITION_KINDS) and self.peek().type in ("DOT", "LBRACKET", "AT"):
                bad = self.peek()
                raise ExprError("bool_as_value", "A condition can't be used as a value here.", bad.start, bad.end)
            # A parenthesized group is a transparent wrapper: keep the inner node
            # but widen its span so postfix/offset spans read naturally.
            return _respan(inner, t.start, close.end)
        if t.type == "NAME":
            name = self.next()
            if name.value == "candle":
                return N.Candle(None, name.start, name.end)
            if name.value == "entry":
                return N.Entry(name.start, name.end)
            if name.value == "barsSinceEntry":
                return N.BarsSinceEntry(name.start, name.end)
            if name.value in N.PREDICATE_FNS and self.peek().type == "LPAREN":
                self.next()
                arg = self.parse_arith()
                close = self.expect("RPAREN")
                return N.Predicate(name.value, arg, name.start, close.end)
            if name.value == "count" and self.peek().type == "LPAREN":
                self.next()
                cond = self.parse_or()
                if not isinstance(cond, N.CONDITION_KINDS):
                    raise ExprError(
                        "count_needs_condition",
                        "count's first argument must be a condition, like candle.open > candle.close.",
                        cond.start, cond.end,
                    )
                self.expect("COMMA")
                window = self.parse_arith()
                close = self.expect("RPAREN")
                return N.Count(cond, window, name.start, close.end)
            if self.peek().type == "LPAREN":
                self.next()
                args: list[N.Node] = []
                if self.peek().type != "RPAREN":
                    args.append(self.parse_arith())
                    while self.peek().type == "COMMA":
                        self.next()
                        args.append(self.parse_arith())
                close = self.expect("RPAREN")
                return N.Call(name.value, args, name.start, close.end)
            # A bare name that is not candle/entry/call is an unknown variable; the
            # validator reports it. Model it as a zero-arg Call so spans survive.
            # ... unless it is the "X> b" spelling of the cross operator: only a
            # bare x/X sitting immediately on a comparison bracket earns the
            # cross-operator hint. A plain "x" elsewhere (e.g. count(..., x)) is
            # just an unknown variable and must be reported as one.
            if name.value in ("x", "X") and self.peek().type in ("GT", "LT"):
                raise ExprError("bad_cross_op", _BAD_CROSS_MSG, name.start, name.end)
            return N.Call(name.value, [], name.start, name.end)
        raise ExprError("unexpected_token", "Expected a value here.", t.start, t.end)

    def parse_postfix(self, node: N.Node) -> N.Node:
        while True:
            t = self.peek()
            if t.type == "DOT":
                self.next()
                # A bare unknown zero-arg name with a field is an
                # indicator-instance reference. Registered names keep the
                # Field(Call) shape so validate still reports field_on_call for
                # EMA(9).signal.
                is_ref = (
                    isinstance(node, N.Call)
                    and not node.args
                    and node.name not in INDICATORS
                    and node.name not in WRAPPERS
                    and node.name not in N.CROSS_FNS
                    and node.name not in N.PREDICATE_FNS
                )
                # Decided BEFORE the token is consumed: only an instance
                # reference may name its output with a NUMBER, because only
                # there is a bare number a name (a pane's outputs are named by
                # its MA lengths). Everywhere else `.` still demands a NAME, so
                # candle.9 and EMA(9).9 stay the errors they were.
                if is_ref and self.peek().type == "NUMBER":
                    field = self.next()
                else:
                    field = self.expect("NAME")
                # For candle.field, store the field in the Candle node itself
                if isinstance(node, N.Candle):
                    node = N.Candle(field.value, node.start, field.end)
                elif is_ref:
                    node = N.IndicatorRef(node.name, field.value, node.start, field.end)
                    # A digits-named output may carry ONE dotted sub-name
                    # ("ATR1.14.to%"): fuse it into the output so downstream
                    # layers stay string-keyed. A fused output is no longer
                    # all-digits, so a further ".x" falls through to Field
                    # (-> field_on_indicator_ref), and an offset in between
                    # breaks the chain the same way.
                    if (field.value.isdigit() and self.peek().type == "DOT"
                            and self.toks[self.i + 1].type == "NAME"):
                        self.next()
                        sub = self.next()
                        node = N.IndicatorRef(node.instance, f"{node.output}.{sub.value}",
                                              node.start, sub.end)
                else:
                    node = N.Field(node, field.value, node.start, field.end)
            elif t.type == "LBRACKET":
                self.next()
                if self.peek().type != "MINUS":
                    bad = self.peek()
                    raise ExprError("bad_offset", "A bar offset must be negative, like [-1].", bad.start, bad.end)
                self.next()
                num = self.expect("NUMBER")
                if "." in num.value or int(float(num.value)) < 1:
                    raise ExprError("bad_offset", "A bar offset must be a whole number of 1 or more.", num.start, num.end)
                close = self.expect("RBRACKET")
                node = N.Offset(node, int(float(num.value)), node.start, close.end)
            elif t.type == "AT":
                self.next()
                tf = self.expect("NAME")
                if N.contains_tf(node):
                    raise ExprError("nested_tf", "A timeframe pin cannot be nested inside another one.", t.start, tf.end)
                node = N.Tf(node, tf.value, node.start, tf.end)
            else:
                return node


def _respan(node: N.Node, start: int, end: int):
    import dataclasses
    return dataclasses.replace(node, start=start, end=end)


def parse(src: str) -> N.Row:
    return _Parser(tokenize(src)).parse_row()
