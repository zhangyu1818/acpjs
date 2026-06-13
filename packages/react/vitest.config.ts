import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: '@acpjs/react',
    environment: 'jsdom',
    setupFiles: ['src/test-setup.ts'],
  },
})
