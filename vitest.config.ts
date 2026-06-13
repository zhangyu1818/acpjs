import { coverageConfigDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        ...coverageConfigDefaults.exclude,
        '**/test-support.ts',
        '**/test-setup.ts',
        '**/test-app/**',
      ],
    },
  },
})
