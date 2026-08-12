// Retry wrapper for job-cancel POSTs (sweep/WFO). A cancel fired on abort used
// to be one fire-and-forget request: a single dropped POST silently left the
// job running server-side. Retries with backoff; resolves true on success,
// false when every attempt failed. Never throws — callers stay fire-and-forget.
// Deliberately signal-blind: cancels run AFTER the run's AbortSignal fired, so
// the delays must not be tied to it.

const RETRY_DELAYS_MS = [1000, 3000, 7000];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function cancelWithRetry(cancel: () => Promise<void>): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      await cancel();
      return true;
    } catch {
      if (attempt >= RETRY_DELAYS_MS.length) return false;
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}
