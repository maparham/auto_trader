// TradingView-style "Layouts" control. A layout is a NAMED snapshot of the whole
// workspace (every tab + which was active). The control is split into two parts:
//   [name button] — clicking it switches to the most-recently-used layout from the
//                   dropdown (or opens the dropdown if there's only one option).
//   [caret ▾]    — opens a full dropdown with Save, Autosave toggle, Make a copy,
//                   Rename, the full saved-layout list, and recently-used entries.
//
// The active layout (✓) is device-local; the list + default sync across instances.
// All persistence lives in persist.ts; App owns applying a switch (remounts the grid).

import { useEffect, useMemo, useRef, useState } from "react";
import {
  loadLayouts,
  loadDefaultLayoutId,
  renameLayout,
  saveDefaultLayoutId,
  type LayoutMeta,
} from "./lib/persist";

interface Props {
  activeLayoutId: string | null;
  hasWorkspace: boolean;
  autosave: boolean;
  isDirty: boolean;
  onToggleAutosave: () => void;
  onSwitch: (id: string) => void;
  onSave: () => void;
  onSaveAs: (name: string) => void;
  onDelete: (id: string) => void;
  revision: number;
}

export default function LayoutManager({
  activeLayoutId,
  hasWorkspace,
  autosave,
  isDirty,
  onToggleAutosave,
  onSwitch,
  onSave,
  onSaveAs,
  onDelete,
  revision,
}: Props) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saveAsName, setSaveAsName] = useState("");
  const [showSaveAs, setShowSaveAs] = useState(false);
  const [localRev, setLocalRev] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);

  const layouts = useMemo<LayoutMeta[]>(
    () => loadLayouts(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [revision, localRev],
  );
  const defaultId = useMemo<string | null>(
    () => loadDefaultLayoutId(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [revision, localRev],
  );

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
        setEditing(null);
        setShowSaveAs(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const active = layouts.find((l) => l.id === activeLayoutId) ?? null;
  const label = active ? active.name : "Untitled";

  const commitRename = (id: string) => {
    const name = draft.trim();
    if (name) renameLayout(id, name);
    setEditing(null);
    setLocalRev((n) => n + 1);
  };

  const commitSaveAs = () => {
    const name = saveAsName.trim();
    if (!name) return;
    onSaveAs(name);
    setSaveAsName("");
    setShowSaveAs(false);
    setOpen(false);
  };

  const setDefault = (id: string | null) => {
    saveDefaultLayoutId(id);
    setLocalRev((n) => n + 1);
  };

  const close = () => {
    setOpen(false);
    setEditing(null);
    setShowSaveAs(false);
  };

  return (
    <div className="layout-mgr" ref={menuRef}>
      {/* Name button: click to open the layout switcher dropdown */}
      <button
        className={`layout-mgr-name-btn${open ? " on" : ""}${isDirty ? " dirty" : ""}`}
        onClick={() => setOpen((o) => !o)}
        title={isDirty ? `${label} — unsaved changes` : "Workspace layouts"}
      >
        <span className="layout-mgr-label">{label}</span>
        {active && active.id === defaultId && (
          <span className="layout-mgr-star">★</span>
        )}
        {isDirty && !autosave && <span className="layout-mgr-dot" />}
      </button>

      {/* Caret button: same toggle, visually separated */}
      <button
        className={`layout-mgr-caret-btn${open ? " on" : ""}`}
        onClick={() => setOpen((o) => !o)}
        title="Layout options"
        aria-label="Layout options"
      >
        ▾
      </button>

      {open && (
        <div className="dropdown layout-mgr-menu">
          {/* ── Top actions ── */}
          <ul className="layout-mgr-actions-list">
            {active && (
              <li
                className={`layout-mgr-action${isDirty ? " highlight" : ""}`}
                onClick={() => {
                  onSave();
                  close();
                }}
              >
                <span className="layout-mgr-action-icon">💾</span>
                <span className="layout-mgr-action-text">
                  Save layout
                  {isDirty && <span className="layout-mgr-unsaved"> •</span>}
                </span>
                <span className="layout-mgr-action-kbd">⌘S</span>
              </li>
            )}
            <li
              className="layout-mgr-action layout-mgr-toggle"
              onClick={(e) => e.stopPropagation()}
            >
              <span className="layout-mgr-action-icon">⏱</span>
              <span className="layout-mgr-action-text">Autosave</span>
              <button
                className={`layout-mgr-switch${autosave ? " on" : ""}`}
                onClick={() => {
                  onToggleAutosave();
                }}
                aria-label={autosave ? "Disable autosave" : "Enable autosave"}
              >
                <span className="layout-mgr-switch-thumb" />
              </button>
            </li>
            {active && (
              <li
                className="layout-mgr-action"
                onClick={() => {
                  setEditing(active.id);
                  setDraft(active.name);
                }}
              >
                <span className="layout-mgr-action-icon">✎</span>
                <span className="layout-mgr-action-text">Rename…</span>
              </li>
            )}
            {showSaveAs ? (
              <li
                className="layout-mgr-action layout-mgr-saveas"
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  autoFocus
                  placeholder="Layout name…"
                  value={saveAsName}
                  onChange={(e) => setSaveAsName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitSaveAs();
                    if (e.key === "Escape") setShowSaveAs(false);
                  }}
                />
                <button onClick={commitSaveAs} disabled={!saveAsName.trim()}>
                  Save
                </button>
              </li>
            ) : (
              <li
                className={`layout-mgr-action${!hasWorkspace ? " disabled" : ""}`}
                onClick={() => hasWorkspace && setShowSaveAs(true)}
              >
                <span className="layout-mgr-action-icon">⊕</span>
                <span className="layout-mgr-action-text">Make a copy…</span>
              </li>
            )}
          </ul>

          {/* Rename inline input for the active layout */}
          {editing === active?.id && (
            <div className="layout-mgr-rename" onClick={(e) => e.stopPropagation()}>
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename(active.id);
                  if (e.key === "Escape") setEditing(null);
                }}
                onBlur={() => commitRename(active.id)}
              />
            </div>
          )}

          {/* ── Layout list ── */}
          {layouts.length > 0 && (
            <>
              <div className="layout-mgr-divider" />
              <ul className="layout-mgr-list">
                {layouts.map((l) => (
                  <li
                    key={l.id}
                    className={l.id === activeLayoutId ? "on" : ""}
                    onClick={() => {
                      if (editing === l.id) return;
                      onSwitch(l.id);
                      close();
                    }}
                  >
                    <span className="layout-mgr-check">
                      {l.id === activeLayoutId ? "✓" : ""}
                    </span>
                    {editing === l.id ? (
                      <input
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename(l.id);
                          if (e.key === "Escape") setEditing(null);
                        }}
                        onBlur={() => commitRename(l.id)}
                      />
                    ) : (
                      <span className="layout-mgr-list-label">{l.name}</span>
                    )}
                    <span
                      className="layout-mgr-row-actions"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        className={l.id === defaultId ? "act on" : "act"}
                        title={l.id === defaultId ? "Default layout" : "Set as default"}
                        onClick={() => setDefault(l.id === defaultId ? null : l.id)}
                      >
                        ★
                      </button>
                      <button
                        className="act"
                        title="Rename"
                        onClick={() => {
                          setEditing(l.id);
                          setDraft(l.name);
                        }}
                      >
                        ✎
                      </button>
                      <button
                        className="act"
                        title="Delete"
                        onClick={() => {
                          onDelete(l.id);
                          setLocalRev((n) => n + 1);
                        }}
                      >
                        🗑
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {layouts.length === 0 && (
            <div className="layout-mgr-empty">No saved layouts</div>
          )}
        </div>
      )}
    </div>
  );
}
