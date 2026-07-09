// Thumbnail gallery of saved chart snapshots. Rename/note commit on blur (no save
// buttons — mirrors the app's other inline-edit fields); delete goes through the
// shared confirm dialog; Restore hands the full ChartSnapshot up to App, which opens
// it into a fresh one-cell tab (see restoreSnapshot in App.tsx).
import FloatingModal from "./components/FloatingModal";
import {
  loadSnapshotIndex,
  loadSnapshot,
  saveSnapshot,
  deleteSnapshot,
  type ChartSnapshot,
} from "./lib/persist";
import { requestConfirm } from "./lib/signals";
import { useState } from "react";

interface Props {
  onRestore: (s: ChartSnapshot) => void;
  onClose: () => void;
  /** Save a snapshot of the focused chart; resolves the new record (null when the
   *  chart isn't ready). The fresh card appearing on top is the save feedback. */
  onSaveCurrent?: () => Promise<ChartSnapshot | null>;
}

function loadAll(): ChartSnapshot[] {
  return loadSnapshotIndex()
    .map((id) => loadSnapshot(id))
    .filter((s): s is ChartSnapshot => s != null);
}

export default function SnapshotGallery({ onRestore, onClose, onSaveCurrent }: Props) {
  const [snaps, setSnaps] = useState<ChartSnapshot[]>(loadAll);
  const [saving, setSaving] = useState(false);
  const refresh = () => setSnaps(loadAll());

  const saveCurrent = async () => {
    if (!onSaveCurrent || saving) return;
    setSaving(true);
    try {
      await onSaveCurrent();
      refresh();
    } finally {
      setSaving(false);
    }
  };

  const commitField = (s: ChartSnapshot, patch: Partial<ChartSnapshot>) => {
    saveSnapshot({ ...s, ...patch });
    refresh();
  };

  const remove = (s: ChartSnapshot) =>
    requestConfirm({
      title: "Delete snapshot",
      message: `Delete "${s.name}"? Charts previously restored from it are not affected.`,
      onConfirm: () => {
        deleteSnapshot(s.id);
        refresh();
      },
    });

  return (
    <FloatingModal title="Snapshots" onClose={onClose} width={720} className="snapshot-gallery">
      {onSaveCurrent && (
        <div className="snap-bar">
          <button className="snap-add" disabled={saving} onClick={() => void saveCurrent()}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
            {saving ? "Saving…" : "Save current chart"}
          </button>
        </div>
      )}
      {snaps.length === 0 ? (
        <div className="snap-empty">
          No snapshots yet — use the camera button in the toolbar to save the
          current chart.
        </div>
      ) : (
        <div className="snap-grid">
          {snaps.map((s) => (
            <div key={s.id} className="snap-card">
              {s.thumb ? (
                <img className="snap-thumb" src={s.thumb} alt="" />
              ) : (
                <div className="snap-thumb snap-thumb-empty">No preview</div>
              )}
              <input
                className="snap-name"
                defaultValue={s.name}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== s.name) commitField(s, { name: v });
                }}
              />
              <div className="snap-sub">
                {s.epic} @ {s.period.label} ·{" "}
                {new Date(s.takenAt).toLocaleDateString()}
              </div>
              <textarea
                className="snap-note"
                placeholder="Add a note…"
                rows={2}
                defaultValue={s.note ?? ""}
                onBlur={(e) => {
                  const v = e.target.value;
                  if (v !== (s.note ?? "")) commitField(s, { note: v || undefined });
                }}
              />
              <div className="snap-actions">
                <button onClick={() => onRestore(s)}>Restore</button>
                <button className="ghost" onClick={() => remove(s)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </FloatingModal>
  );
}
