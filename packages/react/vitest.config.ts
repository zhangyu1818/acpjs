import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@acpjs/client': fileURLToPath(
        new URL('../client/src/index.ts', import.meta.url),
      ),
      '@acpjs/core': fileURLToPath(
        new URL('../core/src/index.ts', import.meta.url),
      ),
      '@acpjs/protocol': fileURLToPath(
        new URL('../protocol/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    name: '@acpjs/react',
    environment: 'jsdom',
    setupFiles: ['src/test-setup.ts'],
  },
})
