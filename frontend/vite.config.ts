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
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:8000",
        ws: true,
      },
    },
  },
  // Unit tests (vitest). Scoped to src/ so it never picks up Playwright's e2e
  // specs (those run via `playwright test`, not vitest).
  test: {
    include: ['src/**/*.{test.ts,test.tsx}'],
    environment: 'node',
    // .tsx tests (React Testing Library) need a DOM; the existing .ts pure-logic
    // suite stays on the fast `node` environment above via a per-file override:
    // each .tsx test declares `// @vitest-environment jsdom` at the top.
  },
})
