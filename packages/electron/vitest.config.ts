import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: '@acpjs/electron',
    environment: 'node',
    sequence: {
      groupOrder: 1,
    },
  },
})
