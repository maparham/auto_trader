// Screener HTTP client: saved screens and screen runs (backend
// api/routers/screens.py). A 422 whose detail carries an expression span
// becomes a ScreenSpecError so the panel can underline the right field.
import { API_BASE as BASE, apiFetch, errorDetail } from "./http";
import type { ExprInstancePayload } from "./exprInstances";

export interface ScreenColumn { name: string; expression: string }
/** Where a saved screen takes its symbols from when loaded again: the stored
 * list, or every chart tab open at that moment. "Some tabs" is not saved
 * (tab ids are per browser), so it is stored as the list it resolved to. */
export type ScreenSource = "list" | "allTabs";
export interface ScreenDraft {
  broker: string;
  resolution: string;
  symbols: string[];
  expression: string;
  columns: ScreenColumn[];
  indicators: Record<string, ExprInstancePayload>;
  /** Only Save reads it; the run endpoint ignores it. Absent on rows saved
   * before it existed, which load as a list. */
  source?: ScreenSource;
}
export interface Screen extends ScreenDraft {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
}
export interface ScreenMatch { epic: string; bar_time: number; columns: Record<string, number | null> }
export interface ScreenResult {
  matches: ScreenMatch[];
  skipped: { epic: string; reason: string }[];
  stats: { symbols: number; matched: number; skipped: number; ms: number };
}
export interface ScreenJobStatus {
  status: "running" | "done" | "cancelled" | "error";
  done: number;
  total: number;
  result: ScreenResult | null;
  error?: string;
}
export interface ScreenExprError {
  code: string;
  message: string;
  start: number;
  end: number;
  field: "expression" | "columns";
  index: number;
}

export class ScreenSpecError extends Error {
  readonly detail: ScreenExprError;
  constructor(detail: ScreenExprError) {
    super(detail.message);
    this.detail = detail;
  }
}

// FastAPI's request-validation 422 carries a list of {loc, msg}. Each item
// reads as "<last loc part>: <msg>", so a too-long column name says so
// instead of the generic fallback.
function validationMessage(d: unknown): string | null {
  if (!Array.isArray(d) || d.length === 0) return null;
  const parts = d
    .filter((it): it is { loc?: unknown[]; msg: string } => !!it && typeof it.msg === "string")
    .map((it) => {
      const tail = Array.isArray(it.loc) && it.loc.length ? it.loc[it.loc.length - 1] : null;
      return tail == null || tail === "body" ? it.msg : `${String(tail)}: ${it.msg}`;
    });
  return parts.length ? parts.join("; ") : null;
}

async function failed(res: Response, fallback: string): Promise<never> {
  if (res.status === 422) {
    const body = await res.clone().json().catch(() => null);
    const d = body?.detail;
    if (d && typeof d === "object" && typeof d.code === "string") throw new ScreenSpecError(d as ScreenExprError);
    const msg = validationMessage(d);
    if (msg) throw new Error(msg);
  }
  throw new Error(await errorDetail(res, fallback));
}

const json = (body: unknown): RequestInit => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export async function listScreens(): Promise<Screen[]> {
  const res = await apiFetch(`${BASE}/api/screens`);
  if (!res.ok) await failed(res, `screens failed (${res.status})`);
  return (await res.json()).screens;
}

export async function saveScreen(name: string, draft: ScreenDraft, id?: string): Promise<Screen> {
  const res = await apiFetch(id ? `${BASE}/api/screens/${encodeURIComponent(id)}` : `${BASE}/api/screens`, {
    method: id ? "PUT" : "POST",
    ...json({ name, ...draft }),
  });
  if (!res.ok) await failed(res, `save failed (${res.status})`);
  return res.json();
}

export async function deleteScreen(id: string): Promise<void> {
  const res = await apiFetch(`${BASE}/api/screens/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) await failed(res, `delete failed (${res.status})`);
}

export async function startScreen(draft: ScreenDraft, priceSide: string): Promise<{ jobId: string; total: number }> {
  const res = await apiFetch(`${BASE}/api/screens/run`, { method: "POST", ...json({ ...draft, priceSide }) });
  if (!res.ok) await failed(res, `screen failed (${res.status})`);
  return res.json();
}

export async function pollScreen(jobId: string): Promise<ScreenJobStatus> {
  const res = await apiFetch(`${BASE}/api/screens/jobs/${encodeURIComponent(jobId)}`);
  if (!res.ok) await failed(res, `screen status failed (${res.status})`);
  return res.json();
}

export async function cancelScreen(jobId: string): Promise<void> {
  const res = await apiFetch(`${BASE}/api/screens/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
  if (!res.ok && res.status !== 404) await failed(res, `cancel failed (${res.status})`);
}
