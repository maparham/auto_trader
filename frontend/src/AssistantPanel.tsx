// Right-docked Assistant panel: a transcript, option chips for ask_user, a
// Changed list with one Undo for the newest turn, and a composer.
// Spec: docs/superpowers/specs/2026-10-25-ai-assistant-design.md.
import { useEffect, useRef, useState } from "react";
import Tooltip from "./components/Tooltip";
import InfoTip from "./components/InfoTip";
import { toBlocks, collapseLabels } from "./assistant/format";
import { assistantSession, undoableIndex, type Turn, type SessionState } from "./assistant/session";

const EXAMPLES = [
  "Add rising trendlines on the daily",
  "Show me where RSI was oversold last month",
  "Build a simple EMA crossover backtest",
];

const ERROR_TEXT: Record<string, string> = {
  network: "Could not reach the assistant.",
  refusal: "The model declined this request.",
  max_tokens: "The answer was cut short.",
  rounds: "Stopped after too many steps.",
  stopped: "Stopped.",
};

// The backend's own busy-semaphore 429 carries this exact detail string
// (api/routers/assistant.py), distinguishing it from an upstream 429 (rate
// limit) re-wrapped as a 502 with the same `status`.
const BUSY_BODY = "assistant busy";

function upstreamText(status: number, body?: string): string {
  if (status === 429 && body === BUSY_BODY) return "The assistant is busy, try again in a moment.";
  if (status === 429) return "Rate limited, try again shortly.";
  return `The assistant service answered ${status}.`;
}

// Friendly phrases for the "Working..." label while a tool round is in
// flight, keyed by the tool name session.ts records on `working` (the raw
// snake_case name is not something a user should read). Unlisted tools fall
// back to the name with underscores turned into spaces.
const TOOL_WORKING_LABEL: Record<string, string> = {
  chart_state: "reading the chart",
  chart_timeframe_set: "changing the timeframe",
  chart_range_set: "moving the visible range",
  market_select: "switching symbol",
  tab_list: "checking open tabs",
  indicator_list: "checking indicators",
  indicator_add: "adding an indicator",
  indicator_set: "changing an indicator",
  indicator_remove: "removing an indicator",
  indicator_configure: "configuring an indicator",
  drawing_list: "checking drawings",
  drawing_add: "drawing",
  drawing_remove: "removing a drawing",
  backtest_config_get: "reading the backtest config",
  backtest_config_set: "updating the backtest rules",
  backtest_run: "running the backtest",
  backtest_result: "reading the backtest result",
  describe_indicator: "looking up indicator settings",
  describe_rules: "looking up rule syntax",
  validate_rule: "checking a rule",
};

function workingLabel(working: string): string {
  if (working === "Undoing") return "undoing the last turn";
  return TOOL_WORKING_LABEL[working] ?? working.replace(/_/g, " ");
}

/** The newest non-undone assistant turn with at least one change that is
 * worth reverting (`undoable !== false`), whether or not its undo closure
 * survived a reload. Used to decide WHEN to show an Undo button at all;
 * `undoableIndex` (session.ts) decides whether that button is clickable
 * right now (it also requires a live `undo` function). The two agree in a
 * fresh session (every undoable change carries a live closure there) and
 * only diverge after a reload, where closures never survive JSON. */
function newestRevertibleIndex(turns: Turn[]): number {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.role === "assistant" && !t.undone && t.changes.some((c) => c.undoable !== false)) return i;
  }
  return -1;
}

function useSession(): SessionState {
  const [s, setS] = useState(assistantSession.state.value);
  useEffect(() => assistantSession.state.subscribe(setS), []);
  return s;
}

/** Inline Markdown the model actually writes: **bold**, *italic* and
 * `code`. Anything else stays literal text (never HTML). */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g);
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith("**") && p.endsWith("**") && p.length > 4) return <strong key={i}>{p.slice(2, -2)}</strong>;
        if (p.startsWith("`") && p.endsWith("`") && p.length > 2) return <code key={i} className="as-code">{p.slice(1, -1)}</code>;
        if (p.startsWith("*") && p.endsWith("*") && p.length > 2) return <em key={i}>{p.slice(1, -1)}</em>;
        return p;
      })}
    </>
  );
}

function Markdown({ text }: { text: string }) {
  return (
    <>
      {toBlocks(text).map((b, i) => {
        if (b.kind === "p") {
          return (
            <p key={i} className="as-p">
              {b.lines.map((l, j) => (
                <span key={j}><Inline text={l} />{j < b.lines.length - 1 && <br />}</span>
              ))}
            </p>
          );
        }
        const List = b.kind;
        return (
          <List key={i} className="as-list">
            {b.items.map((it, j) => <li key={j}><Inline text={it} /></li>)}
          </List>
        );
      })}
    </>
  );
}

export default function AssistantPanel({ onClose }: { onClose: () => void }) {
  const s = useSession();
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bodyRef.current?.scrollTo?.({ top: bodyRef.current.scrollHeight });
  }, [s.turns.length, s.working]);

  // The composer grows with the draft (up to a cap, then scrolls) and
  // shrinks back once it is sent.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  const undoIdx = undoableIndex(s.turns);
  const revertibleIdx = newestRevertibleIndex(s.turns);
  const submit = (text: string) => {
    const t = text.trim();
    if (!t || s.busy) return;
    setDraft("");
    void assistantSession.send(t);
  };

  const renderTurn = (t: Turn, i: number) => {
    if (t.role === "user") {
      return (
        <div key={i} className="as-user">
          {t.pickedFrom && <div className="as-picked">{t.pickedFrom}</div>}
          {t.text}
        </div>
      );
    }
    const pendingAsk = t.ask && i === s.turns.length - 1 && !s.busy;
    return (
      <div key={i} className="as-assistant">
        {t.trimmedBefore && <div className="as-muted">Earlier messages were trimmed from the model's view.</div>}
        {t.text && <Markdown text={t.text} />}
        {t.changes.length > 0 && (
          <div className={`as-changes${t.undone ? " as-changes-undone" : ""}`}>
            <div className="as-changes-head">
              <span className="as-changes-title">Changed</span>
              {t.undone ? (
                <span className="as-muted">Undone</span>
              ) : i === revertibleIdx ? (
                i === undoIdx ? (
                  <button className="as-undo" onClick={() => void assistantSession.undoLast()}>
                    Undo this turn
                  </button>
                ) : (
                  <Tooltip content="Undo is lost on reload">
                    <button className="as-undo" disabled>Undo this turn</button>
                  </Tooltip>
                )
              ) : null}
            </div>
            <ul>{collapseLabels(t.changes.map((c) => c.label)).map((l, j) => <li key={j}>{l}</li>)}</ul>
          </div>
        )}
        {t.ask && (
          <div className="as-ask">
            <div className="as-question">{t.ask.question}</div>
            {pendingAsk && (
              <div className="as-chips">
                {t.ask.options.map((o) => (
                  <Tooltip key={o.label} content={o.description ?? o.label}>
                    <button className="as-chip" onClick={() => submit(o.label)}>{o.label}</button>
                  </Tooltip>
                ))}
                <button className="as-chip as-chip-other" onClick={() => inputRef.current?.focus()}>
                  Something else…
                </button>
              </div>
            )}
          </div>
        )}
        {t.error && (
          <div className="as-error">
            {t.error.kind === "upstream" ? (
              <>
                <div>{upstreamText(t.error.status!, t.error.body)}</div>
                {!(t.error.status === 429 && t.error.body === BUSY_BODY) && t.error.body && (
                  <pre className="as-error-body">{t.error.body}</pre>
                )}
              </>
            ) : (
              <div>{ERROR_TEXT[t.error.kind]}{t.error.body ? ` ${t.error.body}` : ""}</div>
            )}
            {t.error.kind !== "stopped" && t.error.kind !== "refusal" && i === s.turns.length - 1 && (
              <button className="as-retry" onClick={() => void assistantSession.retry()}>Retry</button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className="assistant-panel" aria-label="Assistant">
      <div className="sc-head">
        <span className="sc-mark">✦</span>
        <span className="sc-title">Assistant</span>
        <InfoTip title="Assistant" text={[
          "Describe what you want on the chart in your own words.",
          "It adds indicators, drawings and backtest rules to the focused chart.",
          "It may ask a question first. Undo reverts its last turn.",
          "It never places orders.",
        ]} />
        <Tooltip content="New chat">
          <button className="modal-close as-new" aria-label="New chat" disabled={s.busy || s.turns.length === 0}
            onClick={() => assistantSession.reset()}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
              strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M8 2.5H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V8" />
              <path d="M11.5 2.2l2.3 2.3L8.5 9.8 6 10.3l.5-2.5z" />
            </svg>
          </button>
        </Tooltip>
        <Tooltip content="Close">
          <button className="modal-close" aria-label="Close assistant" onClick={onClose}>×</button>
        </Tooltip>
      </div>
      <div className="as-body" ref={bodyRef}>
        {s.turns.length === 0 ? (
          <div className="as-empty">
            <div className="as-muted">Try one of these:</div>
            {EXAMPLES.map((e) => (
              <button key={e} className="as-chip" onClick={() => submit(e)}>{e}</button>
            ))}
          </div>
        ) : (
          s.turns.map(renderTurn)
        )}
        {s.busy && <div className="as-working">Working…{s.working ? ` ${workingLabel(s.working)}` : ""}</div>}
      </div>
      <div className="as-composer">
        <textarea
          ref={inputRef}
          value={draft}
          placeholder="Describe what you want…"
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(draft); }
          }}
        />
        {s.busy ? (
          // Undoing isn't abortable (there is no in-flight fetch/action the
          // Stop button would cancel), so it is hidden rather than shown inert.
          s.working !== "Undoing" && (
            <button className="as-send" onClick={() => assistantSession.stop()}>Stop</button>
          )
        ) : (
          draft.trim() && <button className="as-send" onClick={() => submit(draft)}>Send</button>
        )}
      </div>
    </aside>
  );
}
