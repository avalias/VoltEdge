import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// base: '/VoltEdge/' for the production build (served at
// avalias.github.io/VoltEdge/ on GitHub Pages), '/' in dev.
// Override with VOLTEDGE_BASE if the repo name / host changes.
export default defineConfig(({ command }) => ({
  base: process.env.VOLTEDGE_BASE ?? (command === 'build' ? '/VoltEdge/' : '/'),
  plugins: [react()],
  resolve: {
    alias: {
      // Workspace package whose `main` points at TS source; alias straight to
      // the entry file so Vite transpiles it like first-party code in dev.
      '@voltedge/core': fileURLToPath(
        new URL('../../packages/core/src/index.ts', import.meta.url),
      ),
    },
  },
}))
