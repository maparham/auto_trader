from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.lexer import tokenize


def test_keywords_lex_as_dedicated_tokens():
    toks = tokenize("a and b or not c")
    types = [t.type for t in toks]
    assert types == ["NAME", "AND", "NAME", "OR", "NOT", "NAME", "EOF"]
    assert toks[1].value == "and" and toks[1].start == 2 and toks[1].end == 5


def test_keyword_prefixed_names_stay_names():
    # "android"/"origin"/"notch" must NOT split into keyword + rest.
    toks = tokenize("android origin notch")
    assert [t.type for t in toks] == ["NAME", "NAME", "NAME", "EOF"]


def test_all_uppercase_forms_are_keywords_too():
    # Exactly the lowercase and the all-uppercase spellings are keywords, and the
    # token type is the same either way — only the value records the spelling.
    toks = tokenize("AND OR NOT")
    assert [t.type for t in toks] == ["AND", "OR", "NOT", "EOF"]
    assert toks[0].value == "AND"


def test_mixed_case_forms_are_plain_names():
    toks = tokenize("And aNd Or Not nOt")
    assert [t.type for t in toks] == ["NAME"] * 5 + ["EOF"]


def test_boolop_and_not_nodes_exist():
    cmp1 = N.Compare(">", N.Num(1, 0, 1), N.Num(2, 4, 5), 0, 5)
    cmp2 = N.Compare("<", N.Num(3, 10, 11), N.Num(4, 14, 15), 10, 15)
    b = N.BoolOp("or", [cmp1, cmp2], 0, 15)
    n = N.Not(cmp1, 0, 5)
    assert b.op == "or" and len(b.parts) == 2
    assert isinstance(n.operand, N.Compare)
    for kind in (N.Compare, N.Cross, N.Chain, N.Predicate, N.BoolOp, N.Not):
        assert kind in N.CONDITION_KINDS


def test_node_walks_recurse_through_bool_nodes():
    tf_cmp = N.Compare(">", N.Tf(N.Candle("close", 0, 1), "4H", 0, 2), N.Num(1, 5, 6), 0, 6)
    plain = N.Compare("<", N.Num(1, 8, 9), N.Num(2, 10, 11), 8, 11)
    assert N.contains_tf(N.BoolOp("and", [plain, tf_cmp], 0, 11))
    assert N.contains_tf(N.Not(tf_cmp, 0, 6))
    assert not N.contains_tf(N.Not(plain, 8, 11))
    assert N.first_tf(N.BoolOp("or", [plain, tf_cmp], 0, 11)) == "4H"
    assert N.first_tf(N.Not(plain, 8, 11)) is None
