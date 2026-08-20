import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    exclude: ['ref/**', 'node_modules/**', 'lib/**'],
    testTimeout: 10_000,
  },
})
