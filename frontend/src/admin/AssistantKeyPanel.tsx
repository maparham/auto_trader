import { useEffect, useState, type FormEvent } from "react";
import Card from "./Card";
import {
  clearAssistantKey,
  fetchAssistantKey,
  saveAssistantKey,
  type AssistantKeyInfo,
} from "./api";
import { formatTime } from "./format";

const SOURCE_LABEL: Record<AssistantKeyInfo["source"], string> = {
  dashboard: "Set here",
  env: "From the server env (ASSISTANT_API_KEY)",
  none: "No key: the assistant is off",
};

/** The in-app assistant's gateway key. The server only ever sends back the
 *  last 4 characters, and verifies a new key before saving it. */
export default function AssistantKeyPanel({ refreshKey }: { refreshKey: number }) {
  const [info, setInfo] = useState<AssistantKeyInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stamp, setStamp] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    fetchAssistantKey()
      .then((k) => {
        if (!live) return;
        setInfo(k);
        setError(null);
        setStamp(Date.now());
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [refreshKey]);

  async function run(action: () => Promise<AssistantKeyInfo>) {
    setBusy(true);
    setActionError(null);
    try {
      setInfo(await action());
      setStamp(Date.now());
      setDraft("");
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function onSave(e: FormEvent) {
    e.preventDefault();
    const key = draft.trim();
    if (key) void run(() => saveAssistantKey(key));
  }

  function onRevert() {
    const target = info?.envKeySet ? "the env key" : "no key (the assistant turns off)";
    if (confirm(`Remove the key set here and go back to ${target}?`)) {
      void run(clearAssistantKey);
    }
  }

  return (
    <Card title="AI assistant" stamp={stamp} loading={loading} error={error}>
      {info && (
        <>
          <p>
            {SOURCE_LABEL[info.source]}
            {info.last4 && <span className="admin-mono"> ••••{info.last4}</span>}
          </p>
          {info.source === "dashboard" && (
            <p className="admin-dim">
              Set by {info.setBy ?? "unknown"} at {formatTime(info.setAt)}
            </p>
          )}
          {info.disabled && (
            <p className="admin-error">ASSISTANT_DISABLED is set on the server, so no key is used.</p>
          )}
          <form onSubmit={onSave} style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <input
              className="admin-btn"
              type="password"
              autoComplete="off"
              placeholder="New gateway key"
              aria-label="New gateway key"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={busy}
            />
            <button className="admin-btn" type="submit" disabled={busy || !draft.trim()}>
              {busy ? "Checking" : "Save"}
            </button>
            {info.source === "dashboard" && (
              <button className="admin-btn" type="button" onClick={onRevert} disabled={busy}>
                Revert to env
              </button>
            )}
          </form>
          {actionError && <p className="admin-error">{actionError}</p>}
        </>
      )}
    </Card>
  );
}
