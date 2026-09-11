import { useEffect, useState, type ReactNode } from "react";
import Card from "./Card";
import { fetchHealth, type DbRow, type FeedRow, type HealthSnapshot } from "./api";
import { formatBytes, formatDuration, probeError } from "./format";

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="admin-dim" style={{ marginBottom: 4 }}>
        {label}
      </div>
      {children}
    </div>
  );
}

export default function HealthPanel({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<HealthSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stamp, setStamp] = useState<number | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let live = true;
    setLoading(true);
    fetchHealth()
      .then((h) => {
        if (!live) return;
        setData(h);
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
  }, [refreshKey, tick]);

  if (!data) {
    return (
      <Card title="Health" stamp={stamp} loading={loading} error={error}>
        {null}
      </Card>
    );
  }

  // Each probe is `T | {error}`; narrow once here so the JSX stays readable.
  const proc = probeError(data.process)
    ? null
    : (data.process as { uptimeSeconds: number; pid: number; hostedMode: boolean });
  const feeds = probeError(data.feeds) ? null : (data.feeds as FeedRow[]);
  const dbs = probeError(data.databases) ? null : (data.databases as DbRow[]);
  const disk = probeError(data.disk)
    ? null
    : (data.disk as { path: string; totalBytes: number; freeBytes: number });
  const brokers = probeError(data.brokers)
    ? null
    : (data.brokers as { registered: string[]; restricted: string[]; default: string | null });
  const snap = probeError(data.snapshot)
    ? null
    : (data.snapshot as { enabled: boolean; frontendUrl: string | null });

  return (
    <Card title="Health" stamp={stamp} loading={loading} error={error}>
      <Section label="Process">
        {proc ? (
          <div>
            up {formatDuration(proc.uptimeSeconds)}, pid {proc.pid},{" "}
            {proc.hostedMode ? "hosted" : "local"} mode, idle{" "}
            {typeof data.idleSeconds === "number" ? `${data.idleSeconds}s` : "?"}
          </div>
        ) : (
          <div className="admin-error">{probeError(data.process)}</div>
        )}
      </Section>

      <Section label="Live feeds">
        {feeds ? (
          feeds.length === 0 ? (
            <div className="admin-dim">No feeds running.</div>
          ) : (
            <div className="admin-scroll">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Broker</th>
                  <th>Epic</th>
                  <th>Running</th>
                  <th>Alerts</th>
                </tr>
              </thead>
              <tbody>
                {feeds.map((f) => (
                  <tr key={`${f.broker}:${f.epic}`}>
                    <td>{f.broker}</td>
                    <td>{f.epic}</td>
                    <td>{f.running ? "yes" : "no"}</td>
                    <td>{f.alerts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )
        ) : (
          <div className="admin-error">{probeError(data.feeds)}</div>
        )}
      </Section>

      <Section label="Brokers">
        {brokers ? (
          <div>
            {brokers.registered.join(", ") || "none"}{" "}
            <span className="admin-dim">
              (default {brokers.default ?? "none"}; restricted{" "}
              {brokers.restricted.join(", ")})
            </span>
          </div>
        ) : (
          <div className="admin-error">{probeError(data.brokers)}</div>
        )}
      </Section>

      <Section label="Databases">
        {dbs ? (
          <table className="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Size</th>
                <th>Path</th>
              </tr>
            </thead>
            <tbody>
              {dbs.map((d) => (
                <tr key={d.name}>
                  <td>{d.name}</td>
                  <td>{d.exists ? formatBytes(d.bytes) : "missing"}</td>
                  <td className="admin-mono admin-dim">{d.path}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="admin-error">{probeError(data.databases)}</div>
        )}
      </Section>

      <Section label="Disk">
        {disk ? (
          <div>
            {formatBytes(disk.freeBytes)} free of {formatBytes(disk.totalBytes)}{" "}
            <span className="admin-mono admin-dim">{disk.path}</span>
          </div>
        ) : (
          <div className="admin-error">{probeError(data.disk)}</div>
        )}
      </Section>

      <Section label="Chart snapshots">
        {snap ? (
          <div>
            {snap.enabled ? "enabled" : "disabled"}
            {snap.frontendUrl ? `, frontend ${snap.frontendUrl}` : ", FRONTEND_URL not set"}
          </div>
        ) : (
          <div className="admin-error">{probeError(data.snapshot)}</div>
        )}
      </Section>
    </Card>
  );
}
