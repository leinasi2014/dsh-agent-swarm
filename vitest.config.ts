import { defineConfig } from 'vitest/config'

const windowsBoundary = 'tests/promotion-windows-candidate.spec.ts'
const shared = { exclude: ['ref/**', 'node_modules/**', 'lib/**'], testTimeout: 10_000 }

export default defineConfig({
  test: {
    projects: [
      { test: {
        ...shared,
        name: 'parallel',
        include: ['tests/**/*.spec.{ts,tsx}'],
        exclude: [...shared.exclude, windowsBoundary],
        sequence: { groupOrder: 0 },
      } },
      // Keep the real Windows process/ACL checks required, but run them after
      // all ordinary test workers finish. Their native deadlines stay intact.
      { test: {
        ...shared,
        name: 'windows-boundary',
        include: [windowsBoundary],
        sequence: { groupOrder: 1 },
        fileParallelism: false,
      } },
    ],
    coverage: {
      provider: 'v8',
      // Measure only this plugin's runtime source; reference checkouts and
      // verification scripts are evidence/tooling, not shipped code.
      include: ['src/**/*.{ts,tsx}'],
    },
  },
})
