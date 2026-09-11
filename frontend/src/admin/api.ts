// Typed fetches for the admin console. One call per panel so a failing panel
// never blanks the page. Everything goes through apiFetch, which attaches the
// Clerk session token and handles the 401 refresh.
import { API_BASE, apiFetch, errorDetail } from "../lib/http";

export interface AdminWhoami {
  userId: string;
  email: string | null;
  isAdmin: boolean;
  hostedMode: boolean;
}

export interface ClerkUser {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string | null;
  createdAt: number | null;
  lastActiveAt: number | null;
  lastSignInAt: number | null;
  banned: boolean;
  locked: boolean;
}

export interface UsersPage {
  configured: boolean;
  users: ClerkUser[];
  total: number;
  error: string | null;
}

export interface UsageRow {
  userId: string;
  stateRows: number;
  stateBytes: number;
  runs: number;
  sweeps: number;
  wfo: number;
  alerts: number;
  triggered: number;
  costProfiles: number;
  patternPresets: number;
  lastSeen: number | null;
}

export interface LogRecord {
  time: number;
  level: string;
  logger: string;
  message: string;
}

// Each probe is either its payload or {error}, so the panel renders per-section.
export type Probe<T> = T | { error: string };

export interface FeedRow {
  broker: string;
  epic: string;
  running: boolean;
  alerts: number;
}

export interface DbRow {
  name: string;
  path: string;
  exists: boolean;
  bytes: number;
}

export interface HealthSnapshot {
  process: Probe<{ uptimeSeconds: number; pid: number; hostedMode: boolean }>;
  idleSeconds: Probe<number>;
  feeds: Probe<FeedRow[]>;
  alerts: Probe<{ armed: number; feeds: number }>;
  brokers: Probe<{ registered: string[]; restricted: string[]; default: string | null }>;
  databases: Probe<DbRow[]>;
  disk: Probe<{ path: string; totalBytes: number; freeBytes: number }>;
  snapshot: Probe<{ enabled: boolean; frontendUrl: string | null }>;
}

/** Thrown with status so the page can tell "not an admin" from "it broke". */
export class AdminHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await apiFetch(`${API_BASE}${path}`);
  if (!res.ok) throw new AdminHttpError(res.status, await errorDetail(res));
  return (await res.json()) as T;
}

export const fetchWhoami = () => get<AdminWhoami>("/api/admin/whoami");
export const fetchUsers = (limit = 50, offset = 0, query = "") =>
  get<UsersPage>(
    `/api/admin/users?limit=${limit}&offset=${offset}&query=${encodeURIComponent(query)}`,
  );
export const fetchHealth = () => get<HealthSnapshot>("/api/admin/health");
export const fetchUsage = () => get<{ users: UsageRow[] }>("/api/admin/usage");
export const fetchLogs = (limit = 200, level = "DEBUG") =>
  get<{ records: LogRecord[]; capacity: number }>(
    `/api/admin/logs?limit=${limit}&level=${level}`,
  );
