// Code-split boundary for the rule editor. CodeMirror is ~300 KB of the bundle
// and only the backtest/live rule builders use it, so it loads on first use.
// Until it arrives, the fallback shows the expression as plain text in the
// same box, so the row does not jump. If the chunk cannot load at all (a tab
// that outlived a deploy and could not reload), the row stays on that text
// rather than taking the whole app down.
import { Component, lazy, Suspense, type ReactNode } from "react";
import type { RuleExpressionInputProps } from "./RuleExpressionInput";
import "./RuleExpressionInput.css";

const RuleExpressionInput = lazy(() => import("./RuleExpressionInput"));

class ChunkBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export default function LazyRuleExpressionInput(props: RuleExpressionInputProps) {
  const fallback = (
    <div className={`rule-expr-input rule-expr-fallback${props.readOnly ? " is-readonly" : ""}`}>
      {props.value || <span className="rule-expr-fallback-ph">{props.placeholder}</span>}
    </div>
  );
  return (
    <ChunkBoundary fallback={fallback}>
      <Suspense fallback={fallback}>
        <RuleExpressionInput {...props} />
      </Suspense>
    </ChunkBoundary>
  );
}
