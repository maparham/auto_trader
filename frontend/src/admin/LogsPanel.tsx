import { useEffect, useState } from "react";
import Card from "./Card";
import InfoTip from "../components/InfoTip";
import { fetchLogs, type LogRecord } from "./api";

const LEVELS = ["DEBUG", "INFO", "WARNING", "ERROR"];

export default function LogsPanel({ refreshKey }: { refreshKey: number }) {
  const [records, setRecords] = useState<LogRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stamp, setStamp] = useState<number | null>(null);
  const [level, setLevel] = useState("INFO");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let live = true;
    setLoading(true);
    fetchLogs(200, level)
      .then((r) => {
        if (!live) return;
        setRecords(r.records);
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
  }, [refreshKey, level, tick]);

  return (
    <Card
      title="Logs"
      info={
        <InfoTip
          title="Recent logs"
          text={[
            "In-process buffer, newest first.",
            "Current process only; cleared on restart.",
          ]}
        />
      }
      controls={
        <select
          className="admin-btn"
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          aria-label="Minimum level"
        >
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      }
      stamp={stamp}
      loading={loading}
      error={error}
    >
      <div className="admin-logs">
        {records.length === 0 ? (
          <div className="admin-dim">No records at this level.</div>
        ) : (
          records.map((r, i) => (
            <div key={`${r.time}-${i}`} className={`lvl-${r.level}`}>
              {new Date(r.time).toLocaleTimeString()} {r.level} {r.logger} {r.message}
            </div>
          ))
        )}
      </div>
    </Card>
  );
}
