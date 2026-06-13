import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['renderer-entry.js'],
  outDir: 'out',
  format: 'iife',
  platform: 'browser',
  dts: false,
  sourcemap: false,
  clean: true,
  deps: { alwaysBundle: [/^@acpjs\//] },
})
