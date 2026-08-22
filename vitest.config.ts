import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The panel workspace specs declare their own environment via
    // `// @vitest-environment jsdom` docblocks (official client-plugin form).
    include: ['tests/**/*.spec.ts', 'packages/*/tests/**/*.spec.{ts,tsx}'],
    exclude: ['ref/**', 'node_modules/**', 'lib/**'],
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      // Measure only this plugin's runtime source; reference checkouts and
      // verification scripts are evidence/tooling, not shipped code.
      include: ['src/**/*.ts'],
    },
  },
})
