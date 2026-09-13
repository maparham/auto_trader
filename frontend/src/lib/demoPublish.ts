// Admin-only demo publishing: POST the current workspace layout (captured the
// same way demoSnapshot.ts's captureDemoLayout does) plus a watchlist and a
// set of named canned backtests to `/api/admin/demo/publish`, and read back
// which publish is currently live. Settings' "Public demo" section is the only
// caller. There is ONE live demo: publishing replaces it. The store still
// keeps a row per publish, but no UI offers a rollback, so this module reads
// only the newest row (see fetchDemoLive). See auto_trader/api's demo router (backend/tests/test_demo_router.py)
// for the exact request/response shapes this mirrors.
import { API_BASE, apiFetch, errorDetail } from "./http";
import { captureDemoLayout } from "./demoSnapshot";

export interface DemoLive {
  version: number;
  publishedBy: string | null;
  /** Epoch MILLISECONDS. The store keeps seconds (demo_store.py), so
   *  fetchDemoLive converts on the way in and callers can hand this straight
   *  to `new Date(...)`. */
  createdAt: number;
  size: number;
}

export interface PublishDemoOpts {
  watchlist: string[];
  backtests: { name: string; result: unknown }[];
}

export interface CurrentDemo {
  version: number;
  watchlist: string[];
  backtests: { name: string; result: unknown }[];
}

/** The currently published demo (for prefilling the admin editor), or null
 *  when nothing has been published yet (404). `/api/demo/snapshot` is public
 *  and unauthenticated (demoSnapshot.ts's own boot-time fetcher uses plain
 *  fetch for that reason), but apiFetch works fine against it too and this
 *  call is admin-only in practice, so it goes through the same client as
 *  every other call in this module. Deliberately separate from
 *  demoSnapshot.ts's fetchDemoSnapshot(): that one feeds the module-level
 *  singleton the live demo boot reads from, which this editor-prefill read
 *  must not disturb. */
export async function fetchCurrentDemo(): Promise<CurrentDemo | null> {
  const res = await apiFetch(`${API_BASE}/api/demo/snapshot`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await errorDetail(res, `fetch failed (${res.status})`));
  const json = await res.json();
  const payload = json.payload ?? {};
  return {
    version: json.version as number,
    watchlist: Array.isArray(payload.watchlist) ? (payload.watchlist as string[]) : [],
    backtests: Array.isArray(payload.backtests)
      ? (payload.backtests as { name: string; result: unknown }[])
      : [],
  };
}

/** Publish the CURRENT workspace layout (whatever persist broker is active in
 *  this session) plus the given watchlist/backtests as a new demo version.
 *  Throws with the server's message on a 422 (e.g. an epic that doesn't
 *  resolve, or an empty watchlist) so the caller can show it verbatim. */
export async function publishDemo(opts: PublishDemoOpts): Promise<number> {
  const body = {
    layout: captureDemoLayout(),
    watchlist: opts.watchlist,
    backtests: opts.backtests,
  };
  const res = await apiFetch(`${API_BASE}/api/admin/demo/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorDetail(res, `publish failed (${res.status})`));
  const json = await res.json();
  return json.version as number;
}

/** The publish visitors are currently served, or null when nothing has been
 *  published. `/versions` answers newest-first, so the live one is row 0; the
 *  rest of the list is history the panel deliberately does not show. */
export async function fetchDemoLive(): Promise<DemoLive | null> {
  const res = await apiFetch(`${API_BASE}/api/admin/demo/versions`);
  if (!res.ok) throw new Error(await errorDetail(res, `read failed (${res.status})`));
  const json = await res.json();
  const rows = (json.versions ?? []) as DemoLive[];
  const live = rows[0];
  return live ? { ...live, createdAt: live.createdAt * 1000 } : null;
}
