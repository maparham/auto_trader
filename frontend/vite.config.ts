/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
