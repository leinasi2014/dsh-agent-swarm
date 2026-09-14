/**
 * Type declarations for the promotion-lane process runner exported by
 * scripts/promotion/runner.mjs (issue #102 / #122). Control-plane tooling,
 * never shipped plugin code — declarations exist so
 * tests/promotion-contract.spec.ts drives the lane spawn path type-safely
 * (the F2 env-seal sentinel test), like lib.d.mts.
 */

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  spawnError?: string
}

export function run(command: string, args: string[], options?: {
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
}): Promise<RunResult>

/** The sealed child environment: allowlisted vars + explicit injections (F2). */
export function laneEnv(injections?: Record<string, string>): Record<string, string>

export function git(cwd: string, args: string[], options?: { timeoutMs?: number }): Promise<RunResult>

export function extractTarball(tarballPath: string, destDir: string): Promise<RunResult>
