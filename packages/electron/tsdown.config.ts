import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/main.ts', 'src/preload.ts', 'src/renderer.ts'],
  format: 'esm',
  dts: true,
  platform: 'node',
  fixedExtension: false,
})
