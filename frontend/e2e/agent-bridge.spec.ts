import { test, expect } from "@playwright/test";
import { seedSingleChartDefault, stubStateApi } from "./helpers";

// The app tab connects to /ws/agent-ui on load (dev builds enable the bridge by
// default, see agentBridgeEnabled() in src/agent/index.ts) and the backend lists
// it as a session. Full action round-trips are covered by the backend tests and
// backend/scripts/agent_bridge_probe.py; this only guards the wiring.
//
// Unlike its siblings this spec needs a REAL backend: the tab dials
// `VITE_API_BASE` directly (an absolute URL, not the vite /api proxy), so the
// backend we poll must be the same one the dev server was pointed at. Set both:
//   E2E_BASE_URL=http://localhost:5199 \
//   E2E_BACKEND_URL=http://localhost:8987 npx playwright test e2e/agent-bridge.spec.ts
// If that backend isn't reachable the test skips rather than red-failing a
// frontend-only e2e run.
const BACKEND = process.env.E2E_BACKEND_URL ?? "http://localhost:8000";
const SESSIONS_URL = `${BACKEND}/api/agent/sessions`;

test("agent bridge registers a session", async ({ page, request }) => {
  // A session row is just {id, connectedAt, lastActive} — nothing ties one to
  // this page — so baseline the ids first (a developer's own dev tab, or a
  // previous probe run, can already be connected) and wait for a NEW id.
  let probe;
  try {
    probe = await request.get(SESSIONS_URL);
  } catch {
    test.skip(true, `no backend at ${SESSIONS_URL} (see backend/scripts/agent_bridge_probe.py)`);
    return;
  }
  // Reachable but wrong (401 from the token guard, a 500, an HTML error body) must
  // red-fail rather than skip: only an absent backend is a "not my problem".
  expect(probe.ok(), `${SESSIONS_URL} -> HTTP ${probe.status()}`).toBeTruthy();
  const baseline = new Set<string>(
    ((await probe.json()).sessions as { id: string }[]).map((s) => s.id),
  );

  await seedSingleChartDefault(page);
  await stubStateApi(page); // don't write layout state into the real backend
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();

  await expect
    .poll(
      async () => {
        const res = await request.get(SESSIONS_URL);
        const body = await res.json();
        return (body.sessions as { id: string }[]).filter((s) => !baseline.has(s.id)).length;
      },
      { timeout: 15_000, message: "no new /ws/agent-ui session appeared for this tab" },
    )
    .toBeGreaterThan(0);
});
