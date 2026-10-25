// Right-docked Assistant panel: a transcript, option chips for ask_user, a
// Changed list with one Undo for the newest turn, and a composer.
// Spec: docs/superpowers/specs/2026-10-25-ai-assistant-design.md.
import { useEffect, useRef, useState } from "react";
import Tooltip from "./components/Tooltip";
import InfoTip from "./components/InfoTip";
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

function useSession(): SessionState {
  const [s, setS] = useState(assistantSession.state.value);
  useEffect(() => assistantSession.state.subscribe(setS), []);
  return s;
}

function Paragraphs({ text }: { text: string }) {
  return (
    <>
      {text.split(/\n{2,}/).map((p, i) => (
        <p key={i} className="as-p">
          {p.split("\n").map((line, j) => (
            <span key={j} className={line.trimStart().startsWith("- ") ? "as-bullet" : undefined}>
              {line.trimStart().startsWith("- ") ? line.trimStart().slice(2) : line}
              {j < p.split("\n").length - 1 && <br />}
            </span>
          ))}
        </p>
      ))}
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

  const undoIdx = undoableIndex(s.turns);
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
    const live = i === undoIdx && t.changes.some((c) => c.undo);
    const pendingAsk = t.ask && i === s.turns.length - 1 && !s.busy;
    return (
      <div key={i} className="as-assistant">
        {t.trimmedBefore && <div className="as-muted">Earlier messages were trimmed from the model's view.</div>}
        {t.text && <Paragraphs text={t.text} />}
        {t.changes.length > 0 && (
          <div className="as-changes">
            <div className="as-changes-title">Changed</div>
            <ul>{t.changes.map((c, j) => <li key={j}>{c.label}</li>)}</ul>
            {t.undone ? (
              <span className="as-muted">Undone</span>
            ) : i === undoIdx ? (
              live ? (
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
                <div>The assistant service answered {t.error.status}.</div>
                {t.error.body && <pre className="as-error-body">{t.error.body}</pre>}
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
        {s.busy && <div className="as-working">Working…{s.working ? ` ${s.working.replace(/_/g, " ")}` : ""}</div>}
      </div>
      <div className="as-composer">
        <textarea
          ref={inputRef}
          value={draft}
          placeholder="Describe what you want…"
          rows={3}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(draft); }
          }}
        />
        <div className="as-actions">
          <button className="as-link" onClick={() => assistantSession.reset()} disabled={s.busy}>New chat</button>
          {s.busy ? (
            <button className="as-send" onClick={() => assistantSession.stop()}>Stop</button>
          ) : (
            <button className="as-send" onClick={() => submit(draft)} disabled={!draft.trim()}>Send</button>
          )}
        </div>
      </div>
    </aside>
  );
}
