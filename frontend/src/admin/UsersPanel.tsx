import { useEffect, useState } from "react";
import Card from "./Card";
import InfoTip from "../components/InfoTip";
import { fetchUsers, startImpersonation, type ClerkUser, type UsersPage } from "./api";
import { formatTime } from "./format";
import { enterImpersonation } from "../lib/impersonation";

export default function UsersPanel({
  refreshKey,
  onUsers,
}: {
  refreshKey: number;
  onUsers: (users: ClerkUser[]) => void;
}) {
  const [page, setPage] = useState<UsersPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stamp, setStamp] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [term, setTerm] = useState("");
  const [impersonateError, setImpersonateError] = useState<string | null>(null);

  async function viewAs(user: ClerkUser) {
    const who = user.email ?? user.id;
    const ok = confirm(
      `View the app as ${who}?\n\n` +
        "Read-only: you will not be able to change their data.\n\n" +
        "This clears this browser's local workspace state. Your saved layouts " +
        "come back from the server when you exit, but unsaved scratch state and " +
        "the layout this device had open do not.\n\n" +
        "Close any other open tabs of this app first: another tab will keep " +
        "syncing your own workspace, and it will sync the target's data instead " +
        "while you are viewing as them.",
    );
    if (!ok) return;
    setImpersonateError(null);
    try {
      const res = await startImpersonation(user.id);
      enterImpersonation(res.user.id, res.user.email);
    } catch (e) {
      setImpersonateError(e instanceof Error ? e.message : String(e));
    }
  }

  // Debounce the search box: Clerk's API is rate limited.
  useEffect(() => {
    const id = setTimeout(() => setTerm(query), 300);
    return () => clearTimeout(id);
  }, [query]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    fetchUsers(50, 0, term)
      .then((p) => {
        if (!live) return;
        setPage(p);
        setError(null);
        setStamp(Date.now());
        onUsers(p.users);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [refreshKey, term, onUsers]);

  return (
    <Card
      title="Users"
      info={
        <InfoTip
          title="Clerk users"
          text={[
            "Read from the Clerk Backend API.",
            "Read only: no ban, delete or metadata writes.",
          ]}
        />
      }
      controls={
        <input
          className="admin-btn"
          placeholder="Search"
          aria-label="Search users"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      }
      stamp={stamp}
      loading={loading}
      error={error}
    >
      {page && !page.configured ? (
        <div className="admin-dim">
          Clerk not configured. Set CLERK_SECRET_KEY on the backend to list users.
        </div>
      ) : page?.error ? (
        <div className="admin-error">{page.error}</div>
      ) : (
        <>
          <div className="admin-dim" style={{ marginBottom: 8 }}>
            {page ? `${page.users.length} shown of ${page.total}` : ""}
          </div>
          {impersonateError && <p className="admin-error">{impersonateError}</p>}
          <table className="admin-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>User id</th>
                <th>Created</th>
                <th>Last active</th>
                <th>State</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(page?.users ?? []).map((u) => (
                <tr key={u.id}>
                  <td>{u.email ?? "–"}</td>
                  <td>{[u.firstName, u.lastName].filter(Boolean).join(" ") || "–"}</td>
                  <td className="admin-mono">{u.id}</td>
                  <td>{formatTime(u.createdAt)}</td>
                  <td>{formatTime(u.lastActiveAt)}</td>
                  <td>{u.banned ? "banned" : u.locked ? "locked" : "active"}</td>
                  <td>
                    <button
                      type="button"
                      className="admin-view-as"
                      onClick={() => void viewAs(u)}
                    >
                      View as
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Card>
  );
}
