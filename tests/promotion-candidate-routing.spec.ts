import { expect, it, vi } from 'vitest'
import { bootPlane, run, stopPlane } from '../scripts/promotion/runner.mjs'
import { acceptanceIsolation, controlRootLayout } from '../scripts/promotion/lib.mjs'
import { copyPortableTree, openCandidateSession, resolveApprovedCli } from '../scripts/promotion/candidate-session.mjs'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

it('routes a candidate command to the dedicated executor without spawning it as controller', async () => {
  const result = { code: 23, stdout: 'candidate', stderr: '', timedOut: false, durationMs: 1 }
  const candidate = { run: vi.fn(async () => result) }
  const actual = await run(process.execPath, ['-e', 'process.exit(91)'], { candidate })
  expect(actual).toEqual(result)
  expect(candidate.run).toHaveBeenCalledWith(process.execPath, ['-e', 'process.exit(91)'], expect.any(Object))
})

it('boots and tears down a candidate plane through the account executor', async () => {
  let settle!: (result: { code: number; stdout: string; stderr: string; timedOut: boolean; durationMs: number }) => void
  const done = new Promise<Awaited<ReturnType<typeof run>>>(res => { settle = res })
  const stop = vi.fn(async () => {
    settle({ code: 1, stdout: 'candidate stopped', stderr: '', timedOut: false, durationMs: 1 })
    return done
  })
  const processFixture = { pid: 999999, exitCode: null, done, stdout: async () => 'candidate started', stderr: async () => '', stop }
  const candidate = { start: vi.fn(async () => processFixture) }
  vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, json: async () => ({ result: { ok: true } }) })))
  try {
    const boot = await bootPlane({ cli: 'D:/tools/bin.js', home: 'D:/candidate/home', port: 47931, candidate })
    expect(boot.ready).toBe(true)
    expect(candidate.start).toHaveBeenCalledWith(process.execPath, expect.arrayContaining(['D:/tools/bin.js', '--no-open']), expect.objectContaining({ env: { DSH_HOME: 'D:/candidate/home' } }))
    expect((await stopPlane(boot)).exited).toBe(true)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(boot.stdout()).toBe('candidate stopped')
  } finally { vi.unstubAllGlobals() }
})

it('the staged child launcher captures normal nested pipes with only its explicit target environment', async () => {
  const base = await mkdtemp(join(tmpdir(), 'promotion-child-'))
  try {
    const specification = join(base, 'command.json')
    const output = join(base, 'out'), errors = join(base, 'err')
    await writeFile(specification, JSON.stringify({ command: process.execPath,
      args: ['-e', 'const c=require("child_process").spawnSync(process.execPath,["-e","process.stdout.write(\\\"nested\\\")"],{encoding:"utf8",windowsHide:true}); process.stdout.write(c.stdout+":"+String(process.env.PROMOTION_SECRET_FIXTURE));process.stderr.write("target error");process.exit(7)'],
      cwd: base, env: {}, stdout: output, stderr: errors }))
    const child = spawnSync(process.execPath, [resolve('scripts/promotion/windows-candidate-child.mjs'), specification], {
      windowsHide: true, env: { ...process.env, PROMOTION_SECRET_FIXTURE: 'must-not-reach-target' }, timeout: 10_000,
    })
    expect(child.status, String(child.stderr)).toBe(7)
    expect(await readFile(output, 'utf8')).toBe('nested:undefined')
    expect(await readFile(errors, 'utf8')).toBe('target error')
  } finally { await rm(base, { recursive: true, force: true }) }
})

it('keeps candidate-writable execution state separate from controller verdict evidence', () => {
  const control = controlRootLayout(join(tmpdir(), 'promotion-controller'))
  const drill = join(control.drillsDir, 'one')
  const execution = join(tmpdir(), 'promotion-account', 'one')
  const separate = acceptanceIsolation(drill, control, execution)
  expect(separate.ok).toBe(true)
  expect(separate.domains.evidence).toBe(join(drill, 'evidence'))
  expect(separate.domains.home).toBe(join(execution, 'home'))
  expect(acceptanceIsolation(drill, control, control.candidatesDir).ok).toBe(false)
  expect(acceptanceIsolation(drill, control, tmpdir()).ok).toBe(false)
})

it('fails before secret access when the prepared account is not configured', async () => {
  await expect(openCandidateSession(undefined, run)).rejects.toThrow(process.platform === 'win32' ? 'candidate-account-root' : 'requires Windows')
})

it('rejects a selected CLI that differs from the approved installation entry', async () => {
  const base = await mkdtemp(join(tmpdir(), 'promotion-cli-choice-'))
  try {
    const entry = join(base, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    await mkdir(join(base, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
    await writeFile(entry, 'approved CLI fixture')
    const other = join(base, 'other.js')
    await writeFile(other, 'different CLI fixture')
    expect(await resolveApprovedCli(base, entry)).toBe(await realpath(entry))
    await expect(resolveApprovedCli(base, other)).rejects.toThrow('--cli differs')
  } finally { await rm(base, { recursive: true, force: true }) }
})

it('rebases internal package junctions and rejects links escaping an independent installation', async () => {
  const base = await mkdtemp(join(tmpdir(), 'promotion-portable-'))
  try {
    const source = join(base, 'source'), target = join(base, 'copy'), outside = join(base, 'outside')
    await mkdir(source); await mkdir(outside)
    await mkdir(join(source, 'package'))
    await writeFile(join(source, 'package', 'data'), 'portable')
    await symlink(join(source, 'package'), join(source, 'dependency'), 'junction')
    await copyPortableTree(source, target)
    expect(await realpath(join(target, 'dependency'))).toBe(await realpath(join(target, 'package')))
    await rm(source, { recursive: true })
    expect(await readFile(join(target, 'dependency', 'data'), 'utf8')).toBe('portable')
    await mkdir(source)
    await symlink(outside, join(source, 'private-source'), 'junction')
    await expect(copyPortableTree(source, join(base, 'bad-copy'))).rejects.toThrow('escapes')
  } finally { await rm(base, { recursive: true, force: true }) }
})
