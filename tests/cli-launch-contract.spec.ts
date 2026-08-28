/**
 * Official SOURCE CLI launch contract (task-8, memory-5 /
 * ACCEPTANCE_RUNNER_SOURCE_LAUNCH_MISMATCH).
 *
 * The official root `dsh` script is `node --import tsx/esm apps/cli/src/bin.ts`
 * (official root package.json, `scripts.dsh`; locked by
 * apps/cli/tests/source-launch.compat.spec.ts:7-28, which runs the source entry
 * with `--import tsx/esm` and requires a profile). A built `.js` CLI bin needs
 * no module hook and is launched directly as `node <cli> ...`. The acceptance
 * runner previously launched even the SOURCE entry as bare `node <src>.ts`, so
 * profile-add hit const-enum / named-import SyntaxError under default loading.
 *
 * This suite is fault-first: it pins the helper's two vectors and then scans
 * the runner sources to prove every official-CLI launch now goes through
 * `cliLaunchArgs` (no bare `node <cli>` residue) and runs with `cwd=args.official`
 * — the isolated workspace is injected only via Profile/env, never as cwd.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cliLaunchArgs, isSourceCli } from '../scripts/promotion/cli-launch.mjs'

const laneRoot = fileURLToPath(new URL('../', import.meta.url))

function lane(file: string): Promise<string> {
  return readFile(join(laneRoot, file), 'utf8')
}

describe('official SOURCE CLI launch contract', () => {
  it('classifies a `.ts` source entry vs a built `.js` bin', () => {
    expect(isSourceCli('apps/cli/src/bin.ts')).toBe(true)
    expect(isSourceCli('D:\\repo\\apps\\cli\\src\\bin.ts')).toBe(true)
    expect(isSourceCli('apps/cli/lib/index.js')).toBe(false)
    expect(isSourceCli('apps/cli/bin/dsh')).toBe(false)
  })

  // fault-first: the SOURCE vector must carry `--import tsx/esm`; the built
  // `.js` bin must stay bare (published `lib/` entry, no module hook).
  it('launches the SOURCE `.ts` entry with `--import tsx/esm`, and a built `.js` bin bare', () => {
    expect(cliLaunchArgs('apps/cli/src/bin.ts', ['--version'])).toEqual([
      '--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--version',
    ])
    expect(cliLaunchArgs('apps/cli/lib/index.js', ['plugin', 'add'])).toEqual([
      'apps/cli/lib/index.js', 'plugin', 'add',
    ])
    expect(cliLaunchArgs('C:/repo/apps/cli/src/bin.ts', [])).toEqual([
      '--import', 'tsx/esm', 'C:/repo/apps/cli/src/bin.ts',
    ])
  })

  it('p0/run.mjs routes every CLI launch through the helper with cwd=args.official (no bare node <cli>, no cwd=workspace)', async () => {
    const source = await lane('scripts/p0/run.mjs')
    expect(source).toContain("import { cliLaunchArgs } from '../promotion/cli-launch.mjs'")
    // Every official-CLI launch site uses the helper (6: cli-version,
    // profile-add, dump-config, profile-remove, missing-storage-add,
    // missing-storage-boot) — no bare `node <args.cli>` residue.
    expect(source.match(/cliLaunchArgs\(args\.cli/gu)?.length ?? 0).toBeGreaterThanOrEqual(6)
    expect(source).not.toMatch(/process\.execPath, \[args\.cli/u)
    expect(source).not.toMatch(/\[args\.cli, /u)
    // Official CLI subprocesses run in the official checkout; the isolated
    // workspace reaches them only via Profile/env (never as cwd).
    expect(source).toContain('cwd: args.official')
    expect(source).not.toContain('cwd: workspaceRoot')
  })

  it('promotion/runner.mjs bootPlane launches via the helper (no bare node <cli>, `--import tsx/esm` for source)', async () => {
    const source = await lane('scripts/promotion/runner.mjs')
    expect(source).toContain("import { cliLaunchArgs } from './cli-launch.mjs'")
    expect(source).toContain('cliLaunchArgs(cli,')
    expect(source).not.toMatch(/process\.execPath, \[cli, /u)
    expect(source).not.toMatch(/\[cli, '--profile'/u)
  })

  it('every other promotion dsh-CLI launch site routes through the helper (no bare residue)', async () => {
    for (const file of ['scripts/promotion/accept-check.mjs', 'scripts/promotion/plane-ops.mjs']) {
      const source = await lane(file)
      expect(source).toContain("cli-launch.mjs'")
      expect(source).toContain('cliLaunchArgs(')
      expect(source).not.toMatch(/process\.execPath, \[args\.cli/u)
      expect(source).not.toMatch(/process\.execPath, \[cli, /u)
    }
  })
})
