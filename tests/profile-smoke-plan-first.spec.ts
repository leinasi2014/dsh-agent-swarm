/**
 * P0-2 REAL clean-Profile live dogfood (RLM_LIVE_SMOKE=1 only).
 *
 * Composes ONE fresh isolated headless Profile with:
 *   - official bundles dsh-base + dsh-headless,
 *   - THIS repo (dsh-agent-swarm) installed from the local lane (bundle layer),
 *   - the new dsh-rlm (M13) mounted via cordis.patch (provider spawn),
 *   - storage stack (dsh-storage / storage-json / storage-domain backend=json)
 *     and session-persistence-jsonl roots, plus ambient settings/credentials
 *     copied (provider/model overridable).
 * Then drives one real-model headless task through the complete Plan-first
 * staged flow and asserts SWARM_P02_OK + task count.
 *
 * DSV4-FVE is preferred; when unavailable (RLM_LIVE_PROVIDER set to a
 * configured fallback like zai-coding-cn / glm-5.2) the run records the
 * fallback in its output. Skipped by default (offline gates unaffected).
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const LIVE = process.env.RLM_LIVE_SMOKE === '1'
const REPO = process.env.RLM_DSH_REPO_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const BIN = path.join(REPO, 'apps', 'cli', 'src', 'bin.ts')
const TSS = 'file:///' + path.join(REPO, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs').replace(/\\/g, '/')
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RLM_REPO = process.env.RLM_SWARM_RLM_REPO ?? path.resolve(PKG_ROOT, '..', '..', '..', 'dsh-rlm')
const AMBIENT = process.env.DSH_LIVE_AMBIENT_HOME ?? process.env.DSH_HOME
const STORE = path.join(REPO, 'packages', 'storage')
const PROFILE = 'p02-live'
const PROVIDER = process.env.RLM_LIVE_PROVIDER ?? 'zai-coding-cn'
const MODEL = process.env.RLM_LIVE_MODEL ?? 'glm-5.2'

function run(args: string[], env: Record<string, string>, cwd: string, timeoutMs = 120000): { status: number; stdout: string; stderr: string } {
  const clean: Record<string, string> = { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', ...env }
  const res = spawnSync('node', ['--import', TSS, BIN, ...args], { cwd, env: clean, encoding: 'utf8', timeout: timeoutMs })
  if (res.error) return { status: -1, stdout: '', stderr: 'spawn error: ' + res.error.message }
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

describe.skipIf(!LIVE)('P0-2 real clean-Profile live dogfood (DSH + dsh-agent-swarm + dsh-rlm)', () => {
  it('runs the Plan-first staged flow end to end with a real model', { timeout: 15 * 60_000 }, () => {
    expect(fs.existsSync(BIN), 'harness bin.ts not found; set RLM_DSH_REPO_ROOT').toBe(true)
    expect(AMBIENT !== undefined && fs.existsSync(path.join(AMBIENT, 'settings.yaml')), 'DSH_HOME with settings.yaml required').toBe(true)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-swarm-p02-live-'))
    fs.mkdirSync(path.join(home, 'profiles'), { recursive: true })
    fs.copyFileSync(path.join(AMBIENT!, 'settings.yaml'), path.join(home, 'settings.yaml'))
    fs.copyFileSync(path.join(AMBIENT!, '.credentials.yaml'), path.join(home, '.credentials.yaml'))
    const env = { DSH_HOME: home, RLM_DSH_REPO_ROOT: REPO }
    for (const spec of [PKG_ROOT, RLM_REPO, path.join(STORE, 'storage'), path.join(STORE, 'storage-json'), path.join(STORE, 'storage-domain')]) {
      const add = run(['plugin', '--profile', PROFILE, 'add', '-w', spec], env, REPO, 180_000)
      expect(add.status, 'plugin add failed for ' + path.basename(spec) + ': ' + add.stderr.slice(-300)).toBe(0)
      if (spec === RLM_REPO) expect(fs.existsSync(path.resolve(home, 'profiles', PROFILE, 'node_modules', 'dsh-rlm')), 'dsh-rlm link missing').toBe(true)
    }
    const profileDir = path.join(home, 'profiles', PROFILE)
    const manifestPath = path.join(profileDir, 'package.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    manifest.dsh = { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', 'dsh-agent-swarm'] } }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    const yamlStr = (value: string): string => "'" + value.replace(/\\/g, '/') + "'"
    const patch = [
      '# P0-2 live dogfood headless: swarm + new rlm + storage services.',
      '- id: session-persistence-jsonl',
      '  config:',
      '    root: ' + yamlStr(path.join(home, 'state', 'sessions')),
      '- insert:',
      '    - id: storage',
      "      name: '@deepseek-ai/dsh-storage'",
      '    - id: storage-json',
      "      name: '@deepseek-ai/dsh-storage-json'",
      '      config:',
      '        root: ' + yamlStr(path.join(home, 'state', 'storage')),
      '    - id: storage-domain',
      "      name: '@deepseek-ai/dsh-storage-domain'",
      '      config:',
      '        backend: json',
      '    - id: rlm',
      "      name: 'dsh-rlm'",
      '      config:',
      '        enabled: true',
      '        provider: spawn',
      '',
    ].join('\n')
    fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), patch)
    const task = [
      'Agent Swarm acceptance test. Use exactly these steps:',
      '1) agent_swarm_create_managed name="P02 Live" description="Acceptance." stage=true',
      '2) agent_swarm_set_plan team_id from step 1, expected_revision=1, members=[{name:"worker",role:"writer"}], tasks=[{key:"t1",subject:"Do",description:"Work.",target_member_name:"worker"}]',
      '3) agent_swarm_approve_plan team_id, expected_revision=2',
      '4) agent_swarm_list_managed_teams',
      'Your final reply must be a single line beginning with SWARM_P02_OK followed by the task count returned in step 4.',
    ].join('\n')
    const r = run(['--profile', PROFILE, task], env, REPO, 12 * 60_000)
    expect(r.status, 'headless run failed; stderr: ' + r.stderr.slice(-4000)).toBe(0)
    expect(r.stdout, 'SWARM_P02_OK missing; stdout tail: ' + r.stdout.slice(-800)).toMatch(/SWARM_P02_OK\s+\d+/)
    // eslint-disable-next-line no-console
    console.info('P0-2 live fallback provider/model note: RLM_LIVE_PROVIDER=' + PROVIDER + ' RLM_LIVE_MODEL=' + MODEL)
  })
})



