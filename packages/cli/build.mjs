import { build } from 'esbuild'

// Bundle everything (including the private @ima/protocol) so the published
// package has no runtime dependencies.
await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/ima.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: {
    // Node.js 25+ warns when anything touches the experimental localStorage global,
    // which lib0 probes on load. Shadow it so lib0 falls back to in-memory storage.
    js: [
      '#!/usr/bin/env node',
      "if (Object.getOwnPropertyDescriptor(globalThis, 'localStorage')?.get) Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true, writable: true })",
    ].join('\n'),
  },
  define: { IMA_VERSION: JSON.stringify(process.env.npm_package_version ?? '0.0.0') },
})
