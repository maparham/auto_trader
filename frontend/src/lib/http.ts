// Shared HTTP plumbing for the FastAPI backend: the single base-URL definition
// and the response-error extractor, so every caller (api / feed / trading /
// persist) resolves the same host and surfaces errors identically. The
// `import.meta as unknown` dance (rather than `import.meta.env.*`) keeps this
// usable in the test/node env, where `import.meta.env` may be absent.
export const API_BASE =
  (import.meta as unknown as { env?: { VITE_API_BASE?: string } }).env
    ?.VITE_API_BASE ?? "http://localhost:8000";

/**
 * Pull the FastAPI `{detail}` string from a failed response. Falls back to
 * `fallback` when the body has no string `detail`, else to status + statusText.
 */
export async function errorDetail(res: Response, fallback?: string): Promise<string> {
  try {
    const body = await res.json();
    if (body && typeof body.detail === "string") return body.detail;
  } catch {
    /* non-JSON body — fall through */
  }
  return fallback ?? `${res.status} ${res.statusText}`.trim();
}
