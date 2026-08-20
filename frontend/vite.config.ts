/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Proxy /api (REST + WS) to the shared backend so a dev server on a non-default
  // port (e.g. e2e running its own instance on :5199) can reach it without hitting
  // the backend's CORS allowlist (which only permits the default :5173 origin).
  // Same-origin from the browser's POV; vite forwards server-to-server.
  // BACKEND_PORT lets a second instance (e2e, worktree verification) point the
  // proxy at its own backend without editing this file.
  server: {
    // Enables the JS Self-Profiling API (new Profiler(...)) in dev for
    // main-thread performance investigation.
    headers: {
      "Document-Policy": "js-profiling",
    },
    proxy: {
      "/api": {
        target: `http://localhost:${process.env.BACKEND_PORT ?? 8000}`,
        changeOrigin: true,
      },
      "/ws": {
        target: `ws://localhost:${process.env.BACKEND_PORT ?? 8000}`,
        ws: true,
      },
    },
  },
  // Unit tests (vitest). Scoped to src/ so it never picks up Playwright's e2e
  // specs (those run via `playwright test`, not vitest).
  test: {
    include: ['src/**/*.{test.ts,test.tsx}'],
    environment: 'node',
    // Vitest's 5s default is tuned for fast unit tests, and most of this suite is
    // that. But it also holds ~38 jsdom component tests over 400ms, and a handful
    // that legitimately do heavy work — the SweepResults heatmap renders a 65x65
    // grid twice to exercise the 4000-cell compact cap, ~940ms on an idle machine.
    // Running 197 files across every core, those land at 2.5s+; a CPU spike (a
    // parallel build, a second agent, a laptop thermal dip) pushed a rotating 2-3
    // of them past 5s and the suite reported failures that pass in isolation. That
    // reads as a broken suite and has cost real investigation time twice.
    //
    // 15s is ~6x the slowest observed test, so contention no longer decides the
    // result. It does NOT hide a hang: a deadlocked test still fails, 10s later.
    testTimeout: 15000,
    // .tsx tests (React Testing Library) need a DOM; the existing .ts pure-logic
    // suite stays on the fast `node` environment above via a per-file override:
    // each .tsx test declares `// @vitest-environment jsdom` at the top.
  },
})
