/**
 * Type declarations for scripts/promotion/cli-launch.mjs (official SOURCE CLI
 * launch contract, memory-5). Control-plane tooling, never shipped plugin
 * code — declarations exist so tests/cli-launch-contract.spec.ts drives the
 * helper type-safely, like lib.d.mts / runner.d.mts.
 */

/** Whether `cli` names a TypeScript SOURCE entry (needs the tsx/esm hook). */
export function isSourceCli(cli: string): boolean

/** The argv (after `node`) for one CLI launch: source `.ts` gains `--import tsx/esm`. */
export function cliLaunchArgs(cli: string, args: readonly string[]): string[]
