/**
 * Official SOURCE CLI launch contract (memory-5 /
 * ACCEPTANCE_RUNNER_SOURCE_LAUNCH_MISMATCH).
 *
 * The official `dsh` launcher and `apps/cli/tests/source-launch.compat.spec.ts`
 * pin the SOURCE vector as `node --import tsx/esm apps/cli/src/bin.ts`
 * (official root package.json, `scripts.dsh`; compat spec lines 7-28). A
 * built `.js` CLI bin is launched directly: `node <cli> ...` (the published
 * `lib/` entry needs no module hook). These two vectors used to be conflated —
 * the acceptance runner launched even the source entry as bare `node <src>.ts`,
 * which trips const-enum / named-import SyntaxError — so this single, tested
 * helper owns both forms.
 *
 * Control-plane tooling, never shipped plugin code.
 */

/** Whether `cli` names a TypeScript SOURCE entry (needs the tsx/esm hook). */
export function isSourceCli(cli) {
  return typeof cli === 'string' && cli.toLowerCase().endsWith('.ts')
}

/**
 * The argv (after the `node` executable) for one CLI launch.
 * @param cli - path to the CLI entry: a `.ts` SOURCE bin or a built `.js` bin.
 * @param args - the CLI's own argument vector.
 * @returns source: `['--import','tsx/esm', cli, ...args]`; built: `[cli, ...args]`.
 */
export function cliLaunchArgs(cli, args) {
  const rest = Array.isArray(args) ? args : []
  return isSourceCli(cli) ? ['--import', 'tsx/esm', cli, ...rest] : [cli, ...rest]
}
