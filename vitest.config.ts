import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.{ts,tsx}'],
    exclude: ['ref/**', 'node_modules/**', 'lib/**'],
    testTimeout: 10_000,
    // Bound file-level fan-out: on Windows, 16-worker bursts repeatedly made
    // the official JSON store's atomic temp-file rename fail transiently with
    // EPERM. Eight workers retains parallelism while making the gate stable.
    maxWorkers: 8,
    coverage: {
      provider: 'v8',
      // Measure only this plugin's runtime source; reference checkouts and
      // verification scripts are evidence/tooling, not shipped code.
      include: ['src/**/*.{ts,tsx}'],
    },
  },
})
