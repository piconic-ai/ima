import { defineConfig, type Plugin } from 'vite'
// @ts-expect-error: plain JS helper without type declarations
import { thirdPartyLicenses } from '../../scripts/third-party-licenses.mjs'

// The bundle inlines third-party code, so serve their licenses alongside it.
function licenses(): Plugin {
  return {
    name: 'third-party-licenses',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'THIRD_PARTY_LICENSES.txt',
        source: thirdPartyLicenses(
          [...this.getModuleIds()],
          'The ima web editor bundles the following third-party packages.',
        ),
      })
    },
  }
}

export default defineConfig({
  build: { target: 'es2022', chunkSizeWarningLimit: 1024 },
  plugins: [licenses()],
  server: {
    // `pnpm --filter web dev` against a local `wrangler dev` on :8787.
    proxy: { '/api': { target: 'http://localhost:8787', ws: true } },
  },
})
