// Watcher for an admin history download: chained 1s polls (next tick scheduled
// only after the previous settles, so a slow response can't land after a newer
// one) delivering this series' job — or null — to the callback. Stops itself
// once the job leaves "running": the terminal snapshot is the last delivery.
//
// Jobs are matched by broker+epic only: the job's resolution is the BASE
// series (a MONTH chart's download reports DAY), and there is at most one
// download per series at a time.
import { fetchHistoryJobs, type HistoryJob } from "../api";

const POLL_MS = 1000;

export function watchHistoryDownload(
  sel: { broker: string; epic: string },
  onUpdate: (job: HistoryJob | null) => void,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const tick = async () => {
    const jobs = await fetchHistoryJobs();
    if (stopped) return;
    const job = jobs.find((j) => j.broker === sel.broker && j.epic === sel.epic) ?? null;
    onUpdate(job);
    if (job !== null && job.status !== "running") return; // terminal: done polling
    timer = setTimeout(tick, POLL_MS);
  };
  timer = setTimeout(tick, POLL_MS);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
