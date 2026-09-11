import { useEffect, useMemo, useState } from "react";
import Card from "./Card";
import InfoTip from "../components/InfoTip";
import { fetchUsage, type ClerkUser, type UsageRow } from "./api";
import { formatBytes, formatTime } from "./format";

const COLUMNS: { key: keyof UsageRow; label: string }[] = [
  { key: "stateRows", label: "State rows" },
  { key: "stateBytes", label: "State size" },
  { key: "runs", label: "Runs" },
  { key: "sweeps", label: "Sweeps" },
  { key: "wfo", label: "WFO" },
  { key: "alerts", label: "Alerts" },
  { key: "triggered", label: "Triggered" },
  { key: "costProfiles", label: "Costs" },
  { key: "patternPresets", label: "Presets" },
  { key: "lastSeen", label: "Last seen" },
];

export default function UsagePanel({
  refreshKey,
  users,
}: {
  refreshKey: number;
  users: ClerkUser[];
}) {
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stamp, setStamp] = useState<number | null>(null);
  const [sort, setSort] = useState<keyof UsageRow | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    fetchUsage()
      .then((u) => {
        if (!live) return;
        setRows(u.users);
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

  const emailById = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of users) if (u.email) m.set(u.id, u.email);
    return m;
  }, [users]);

  // Server order is the default; a clicked column sorts descending by value.
  const shown = useMemo(() => {
    if (!sort) return rows;
    return [...rows].sort((a, b) => Number(b[sort] ?? 0) - Number(a[sort] ?? 0));
  }, [rows, sort]);

  return (
    <Card
      title="Usage"
      info={
        <InfoTip
          title="Per-user usage"
          text={["Row counts and sizes only.", "No user content is read or shown here."]}
        />
      }
      stamp={stamp}
      loading={loading}
      error={error}
    >
      <table className="admin-table">
        <thead>
          <tr>
            <th>User</th>
            {COLUMNS.map((c) => (
              <th key={c.key} onClick={() => setSort(c.key)}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.userId}>
              <td data-testid="usage-user">{emailById.get(r.userId) ?? r.userId}</td>
              {COLUMNS.map((c) => (
                <td key={c.key}>
                  {c.key === "lastSeen"
                    ? formatTime(r.lastSeen)
                    : c.key === "stateBytes"
                      ? formatBytes(r.stateBytes)
                      : String(r[c.key] ?? 0)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
