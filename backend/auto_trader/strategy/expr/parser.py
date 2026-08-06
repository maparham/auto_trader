from __future__ import annotations

from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.errors import ExprError
from auto_trader.strategy.expr.lexer import Token, tokenize
from auto_trader.strategy.expr.registry import INDICATORS, WRAPPERS


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
            raise ExprError("unexpected_token", f"Expected {type_.lower()} here.", t.start, t.end)
        return self.next()

    # row := crossfn "(" arith "," arith ")" | arith (cmpop arith)+
    def parse_row(self) -> N.Row:
        t = self.peek()
        if t.type == "NAME" and t.value in N.CROSS_FNS and self.toks[self.i + 1].type == "LPAREN":
            fn = self.next()
            self.expect("LPAREN")
            a = self.parse_arith()
            self.expect("COMMA")
            b = self.parse_arith()
            close = self.expect("RPAREN")
            self.expect("EOF")
            return N.Cross(fn.value, a, b, fn.start, close.end)
        left = self.parse_arith()
        op = self.peek()
        if isinstance(left, N.Predicate) and op.type == "EOF":
            self.next()
            return left
        if op.type not in ("GT", "LT", "GE", "LE"):
            raise ExprError("expected_operator", "Expected a comparison operator (> < >= <=).", op.start, op.end)
        sym_of = {"GT": ">", "LT": "<", "GE": ">=", "LE": "<="}
        parts: list[N.Compare] = []
        operand = left
        while self.peek().type in ("GT", "LT", "GE", "LE"):
            optok = self.next()
            right = self.parse_arith()
            parts.append(N.Compare(sym_of[optok.type], operand, right, operand.start, right.end))
            operand = right
        self.expect("EOF")
        if len(parts) == 1:
            return parts[0]
        return N.Chain(parts, parts[0].start, parts[-1].end)

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
            inner = self.parse_arith()
            close = self.expect("RPAREN")
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
                cond = self.parse_condition()
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
            return N.Call(name.value, [], name.start, name.end)
        raise ExprError("unexpected_token", "Expected a value here.", t.start, t.end)

    # condition := cross "(" arith "," arith ")" | arith cmpop arith | predicate
    def parse_condition(self) -> N.Compare | N.Cross | N.Predicate:
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
        op = self.peek()
        if op.type not in ("GT", "LT", "GE", "LE"):
            if isinstance(left, N.Predicate):
                return left
            raise ExprError(
                "count_needs_condition",
                "count's first argument must be a condition, like candle.open > candle.close.",
                left.start, left.end,
            )
        sym_of = {"GT": ">", "LT": "<", "GE": ">=", "LE": "<="}
        optok = self.next()
        right = self.parse_arith()
        return N.Compare(sym_of[optok.type], left, right, left.start, right.end)

    def parse_postfix(self, node: N.Node) -> N.Node:
        while True:
            t = self.peek()
            if t.type == "DOT":
                self.next()
                field = self.expect("NAME")
                # For candle.field, store the field in the Candle node itself
                if isinstance(node, N.Candle):
                    node = N.Candle(field.value, node.start, field.end)
                elif (
                    isinstance(node, N.Call)
                    and not node.args
                    and node.name not in INDICATORS
                    and node.name not in WRAPPERS
                    and node.name not in N.CROSS_FNS
                    and node.name not in N.PREDICATE_FNS
                ):
                    # A bare unknown name with a field is an indicator-instance
                    # reference. Registered names keep the Field(Call) shape so
                    # validate still reports field_on_call for EMA(9).signal.
                    node = N.IndicatorRef(node.name, field.value, node.start, field.end)
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
