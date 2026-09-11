import { useCallback, useEffect, useState } from "react";
import "./admin.css";
import { applyThemeToDocument, loadSettings } from "../theme";
import { AdminHttpError, fetchWhoami, type AdminWhoami, type ClerkUser } from "./api";
import UsersPanel from "./UsersPanel";
import HealthPanel from "./HealthPanel";
import UsagePanel from "./UsagePanel";
import LogsPanel from "./LogsPanel";

export default function AdminApp() {
  const [who, setWho] = useState<AdminWhoami | null>(null);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  // Users loads first and the usage table joins to it by id, so the ids live
  // here rather than being fetched twice.
  const [users, setUsers] = useState<ClerkUser[]>([]);

  // The console renders outside <App>, so nothing else stamps data-theme and
  // index.css would fall back to its dark default while the app itself is in
  // light mode. Same fix SnapshotApp needed, through the same shared helper.
  useEffect(() => {
    applyThemeToDocument(loadSettings());
  }, []);

  useEffect(() => {
    let live = true;
    fetchWhoami()
      .then((w) => {
        if (live) setWho(w);
      })
      .catch((e) => {
        if (!live) return;
        if (e instanceof AdminHttpError && e.status === 403) setDenied(true);
        else setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, []);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  if (denied) {
    return (
      <div className="admin-page">
        <div className="admin-body">
          <div className="admin-card">
            <div className="content">
              You do not have admin access. Ask the operator to add your account
              to the admin list.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="admin-page">
      <header className="admin-header">
        <h1>Admin</h1>
        <span className="spacer" />
        {error ? <span className="admin-error">{error}</span> : null}
        <span className="admin-who">{who?.email ?? who?.userId ?? ""}</span>
        <button className="admin-btn" onClick={refresh}>
          Refresh
        </button>
        <a className="admin-btn" href="/">
          Back to app
        </a>
      </header>
      <div className="admin-body">
        <UsersPanel refreshKey={refreshKey} onUsers={setUsers} />
        <HealthPanel refreshKey={refreshKey} />
        <UsagePanel refreshKey={refreshKey} users={users} />
        <LogsPanel refreshKey={refreshKey} />
      </div>
    </div>
  );
}
