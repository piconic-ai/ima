import { defineConfig } from 'vite'

export default defineConfig({
  build: { target: 'es2022', chunkSizeWarningLimit: 1024 },
  server: {
    // `pnpm --filter web dev` against a local `wrangler dev` on :8787.
    proxy: { '/api': { target: 'http://localhost:8787', ws: true } },
  },
})
