import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Unit tests (vitest). Scoped to src/ so it never picks up Playwright's e2e
  // specs (those run via `playwright test`, not vitest).
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
