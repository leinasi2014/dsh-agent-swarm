import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId, SessionSeq, type SessionHeader } from '@deepseek-ai/dsh-session'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import Projection from '@deepseek-ai/dsh-session-projection'
import SqliteQuery from '@deepseek-ai/dsh-session-query-sqlite'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { expect, it, onTestFailed, vi } from 'vitest'
import { RetirementJsonlProvider, retirementSessionDirectory } from '../src/runtime/retirement-jsonl-provider.js'
import type { RetirementSession } from '../src/storage/team-retirement-store.js'

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, rmdir: vi.fn(actual.rmdir), unlink: vi.fn(actual.unlink) }
})
async function backend(root: string, compression: 'none' | 'zstd' = 'none') {
  const ctx = new Context()
  const fibers = [await ctx.plugin(SessionStore), await ctx.plugin(AgentRegistry), await ctx.plugin(Jsonl, { root: join(root, 'sessions'), compression }),
    await ctx.plugin(Projection), await ctx.plugin(SqliteQuery, { path: join(root, 'search.db'), openAt: 'first-search' })]
  return { ctx, close: async () => { for (const fiber of fibers.toReversed()) await fiber.dispose() } }
}
const header = (root: string, id = 'retirement-owner'): SessionHeader => ({ version: 3, id: SessionId(id), createdAt: 1, isSeeded: false,
  cwd: join(root, '空间~workspace'), parentSession: SessionId('main'), origin: 'subagent' })
const selection = (value: SessionHeader): RetirementSession => ({ id: value.id, cwd: value.cwd!, parentSessionId: value.parentSession!, createdAt: value.createdAt, origin: value.origin!, version: value.version })
async function create(ctx: Context, meta: SessionHeader) {
  const handle = await ctx.sessionPersistence.create(meta)
  try { await handle.append([{ type: 'user/message', seq: SessionSeq(0), time: 2, surfaceOp: 'append',
    data: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'retirementuniquesecret' }] }) }]); await handle.flush() }
  finally { await handle.close() }
}

/** Failed CI must show the actual filesystem facts; production path fences stay unchanged. */
async function prepareWithPathEvidence(provider: RetirementJsonlProvider, root: string, meta: SessionHeader) {
  try { return await provider.prepare([selection(meta)], new AbortController().signal) }
  catch (error) {
    if (!(error instanceof Error) || !error.message.includes('direct physical directory')) throw error
    const paths = new Set<string>()
    for (let path = resolve(join(root, 'sessions')); ; path = dirname(path)) {
      paths.add(path)
      if (dirname(path) === path) break
    }
    const directory = retirementSessionDirectory(join(root, 'sessions'), meta.cwd!, meta.id)
    paths.add(dirname(directory)); paths.add(directory)
    const facts = await Promise.all([...paths].map(async path => {
      try {
        const [stat, physicalPath] = await Promise.all([lstat(path, { bigint: true }), realpath(path)])
        return { path, realpath: physicalPath, directory: stat.isDirectory(), symbolicLink: stat.isSymbolicLink(),
          resolvedPathsEqual: resolve(physicalPath) === resolve(path), dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) }
      } catch (failure) { return { path, inspectionError: String(failure) } }
    }))
    throw new Error(`Retirement directory identity rejected: ${JSON.stringify({ platform: process.platform, node: process.version, facts })}`, { cause: error })
  }
}

async function windowsShortPath(path: string, signal: AbortSignal): Promise<string> {
  const source = `
Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; public static class RetirementShortPath { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetShortPathName(string path, StringBuilder output, uint size); }'
$buffer = New-Object System.Text.StringBuilder 32768
$length = [RetirementShortPath]::GetShortPathName([Environment]::GetEnvironmentVariable('SWARM_RETIREMENT_LONG_PATH'), $buffer, 32768)
if ($length -eq 0 -or $length -ge 32768) { throw 'GetShortPathName failed' }
$buffer.ToString()
`
  const result = await promisify(execFile)('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', source], {
    env: { ...process.env, SWARM_RETIREMENT_LONG_PATH: path }, windowsHide: true, signal,
  })
  return result.stdout.trim()
}

function hasExpandedShortName(path: string, physical: string): boolean {
  const parts = resolve(path).split(/[\\/]/u), actual = resolve(physical).split(/[\\/]/u)
  return parts.length === actual.length && parts.some((part, index) => /^[^~]{1,6}~\d+(?:\.[^.]{1,3})?$/u.test(part)
    && part.toUpperCase() !== actual[index]!.toUpperCase())
}

it.each(['short-name', 'case-variant'] as const)('deletes through a real Windows %s alias while preserving original cwd encoding and control data', async variant => {
  const startedAt = Date.now(), stages: { stage: string; elapsedMs: number }[] = [], setup = new AbortController()
  const stage = (name: string) => { stages.push({ stage: name, elapsedMs: Date.now() - startedAt }) }
  let failedAt: string | undefined, root: string | undefined, f: Awaited<ReturnType<typeof backend>> | undefined
  onTestFailed(() => {
    setup.abort()
    process.stderr.write(`Retirement alias fixture: ${JSON.stringify({ variant, failedAt: failedAt ?? stages.at(-1)?.stage, elapsedMs: Date.now() - startedAt, stages })}\n`)
  })
  try {
    stage('create-root'); root = await mkdtemp(join(tmpdir(), 'retirement-alias-proof-'))
    stage('resolve-root'); const physical = await realpath(root)
    const existingShortName = hasExpandedShortName(root, physical)
    stage(variant === 'case-variant' ? 'case-alias' : existingShortName ? 'existing-short-name' : 'GetShortPathName')
    const alias = variant === 'case-variant' ? physical.toUpperCase() : existingShortName ? root : await windowsShortPath(physical, setup.signal)
    stage('verify-alias'); expect(alias).not.toBe(physical); expect(await realpath(alias)).toBe(physical)
    if (variant === 'short-name') expect(hasExpandedShortName(alias, physical)).toBe(true)
    stage('mount-backend'); f = await backend(alias)
    const meta = header(alias), control = header(alias, 'control-owner')
    stage('create-sessions')
    await create(f.ctx, meta); await create(f.ctx, control)
    stage('resolve-provider')
    const provider = await RetirementJsonlProvider.resolve(f.ctx)
    stage('prepare')
    const proof = await prepareWithPathEvidence(provider, alias, meta)
    const directory = retirementSessionDirectory(join(alias, 'sessions'), meta.cwd!, meta.id)
    expect(proof[0]).toMatchObject({ cwd: meta.cwd, artifact: { root: resolve(join(alias, 'sessions')), directory } })
    expect((await f.ctx.sessionPersistence.stat(meta.id))?.header.cwd).toBe(meta.cwd)
    const controlDirectory = retirementSessionDirectory(join(alias, 'sessions'), control.cwd!, control.id)
    const before = await readFile(join(controlDirectory, 'session.v3.jsonl'))
    stage('purge')
    await provider.purge(proof)
    stage('verify-preservation')
    await expect(readdir(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await f.ctx.sessionPersistence.stat(meta.id)).toBeUndefined()
    expect(await readFile(join(controlDirectory, 'session.v3.jsonl'))).toEqual(before)
  } catch (error) { failedAt = stages.at(-1)?.stage; throw error }
  finally {
    stage('close-backend')
    try { await f?.close() } finally {
      stage('remove-root')
      if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
    stage('complete')
  }
}, 20_000)

it.each(['root-ancestor', 'project', 'session'] as const)('refuses a real %s junction without removing any Session bytes', async location => {
  const sandbox = await realpath(await mkdtemp(join(tmpdir(), 'retirement-junction-proof-')))
  const physical = join(sandbox, 'physical'), link = join(sandbox, 'linked')
  await mkdir(physical)
  if (location === 'root-ancestor') await symlink(physical, link, 'junction')
  const root = join(location === 'root-ancestor' ? link : physical, 'backend'), f = await backend(root), meta = header(root)
  let junction = location === 'root-ancestor' ? link : undefined
  try {
    await create(f.ctx, meta)
    const directory = retirementSessionDirectory(join(root, 'sessions'), meta.cwd!, meta.id)
    if (location !== 'root-ancestor') {
      junction = location === 'project' ? dirname(directory) : directory
      const moved = join(sandbox, 'moved-artifact')
      await rename(junction, moved); await symlink(moved, junction, 'junction')
    }
    expect((await lstat(junction!)).isSymbolicLink()).toBe(true)
    const before = await readFile(join(directory, 'session.v3.jsonl'))
    const provider = await RetirementJsonlProvider.resolve(f.ctx)
    await expect(provider.prepare([selection(meta)], new AbortController().signal)).rejects.toMatchObject({ code: 'TEAM_RETIREMENT_PROVIDER_UNAVAILABLE', message: 'Session artifact directory is not a direct physical directory' })
    expect(await readFile(join(directory, 'session.v3.jsonl'))).toEqual(before)
  } finally {
    await f.close()
    if (junction !== undefined) await rmdir(junction)
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 20_000)

it('refuses a replaced cleanup root after confirmation and preserves both the original and replacement data', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'retirement-root-replacement-'))), f = await backend(root), meta = header(root)
  try {
    await create(f.ctx, meta)
    const provider = await RetirementJsonlProvider.resolve(f.ctx), proof = await prepareWithPathEvidence(provider, root, meta)
    const configured = join(root, 'sessions'), moved = join(root, 'original-sessions'), relativeDirectory = proof[0]!.artifact!.directory.slice(configured.length + 1)
    const before = await readFile(join(configured, relativeDirectory, 'session.v3.jsonl'))
    await rename(configured, moved); await mkdir(configured); await writeFile(join(configured, 'replacement.txt'), 'keep replacement')
    await expect(provider.purge(proof)).rejects.toMatchObject({ code: 'TEAM_RETIREMENT_PROVIDER_UNAVAILABLE', message: 'Session cleanup root changed' })
    expect(await readFile(join(moved, relativeDirectory, 'session.v3.jsonl'))).toEqual(before)
    expect(await readFile(join(configured, 'replacement.txt'), 'utf8')).toBe('keep replacement')
  } finally { await f.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 20_000)

it('retries after a competing public create leaves an empty canonical directory under the held deletion lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retirement-empty-race-'))
  const f = await backend(root)
  const meta = header(root)
  try {
    await create(f.ctx, meta)
    const provider = await RetirementJsonlProvider.resolve(f.ctx)
    const proof = await prepareWithPathEvidence(provider, root, meta)
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const interruption = new Error('crash after competitor empty-directory creation')
    vi.mocked(rmdir).mockImplementationOnce(async path => {
      await actual.rmdir(path)
      const competitor = await f.ctx.sessionPersistence.create(meta)
      try { await expect(competitor.flush()).rejects.toMatchObject({ name: 'SessionAlreadyOwnedError' }) }
      finally { await competitor.close() }
      throw interruption
    })
    await expect(provider.purge(proof)).rejects.toBe(interruption)
    expect(await f.ctx.sessionPersistence.stat(meta.id)).toBeUndefined()
    expect(await readdir(proof[0]!.artifact!.directory)).toEqual([])
    await expect(provider.purge(proof)).resolves.toBeUndefined()
    await expect(readdir(proof[0]!.artifact!.directory)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { vi.mocked(rmdir).mockRestore(); await f.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 20_000)

it('resumes a partially removed Session with its original proof in a fresh process', async () => {
  const recoveryRoot = process.env['SWARM_RETIREMENT_RECOVERY_ROOT']
  if (recoveryRoot !== undefined) {
    const f = await backend(recoveryRoot)
    try {
      const proof = JSON.parse(await readFile(join(recoveryRoot, 'original-proof.json'), 'utf8')) as RetirementSession[]
      await (await RetirementJsonlProvider.resolve(f.ctx)).purge(proof)
      expect(await f.ctx.sessionPersistence.stat(SessionId(proof[0]!.id))).toBeUndefined()
      await expect(readdir(proof[0]!.artifact!.directory)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await f.ctx.sessionPersistence.stat(SessionId('control-owner'))).toBeDefined()
    } finally { await f.close() }
    return
  }
  const root = await mkdtemp(join(tmpdir(), 'retirement-partial-process-'))
  const f = await backend(root)
  let opened = true
  try {
    const meta = header(root), control = header(root, 'control-owner')
    await create(f.ctx, meta); await create(f.ctx, control)
    const provider = await RetirementJsonlProvider.resolve(f.ctx)
    const proof = await prepareWithPathEvidence(provider, root, meta)
    await writeFile(join(root, 'original-proof.json'), JSON.stringify(proof))
    await writeFile(join(proof[0]!.artifact!.directory, 'zz-retained-fragment'), 'retained private fragment')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(unlink).mockImplementationOnce(async path => { await actual.unlink(path); throw new Error('interrupted after first physical unlink') })
    await expect(provider.purge(proof)).rejects.toThrow('after first physical unlink')
    expect((await readdir(proof[0]!.artifact!.directory)).length).toBeGreaterThan(0)
    await f.close(); opened = false
    const child = await promisify(execFile)(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', 'tests/team-retirement-provider.spec.ts', '-t', 'original proof in a fresh process'], {
      cwd: process.cwd(), env: { ...process.env, SWARM_RETIREMENT_RECOVERY_ROOT: root }, windowsHide: true, timeout: 30_000, maxBuffer: 2_000_000,
    })
    expect(child.stdout).toContain('1 passed')
    await expect(readdir(proof[0]!.artifact!.directory)).rejects.toMatchObject({ code: 'ENOENT' })
    const reopened = await backend(root)
    try { expect(await reopened.ctx.sessionPersistence.stat(control.id)).toBeDefined() } finally { await reopened.close() }
  } finally { vi.mocked(unlink).mockRestore(); if (opened) await f.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 40_000)

it.each(['none', 'zstd'] as const)('removes all retained generation artifacts in %s and reconciles warmed FTS and prepared observations while preserving a control Session', async compression => {
  const root = await mkdtemp(join(tmpdir(), 'retirement-generation-'))
  let f = await backend(root, compression)
  const meta = header(root), control = header(root, 'control-owner')
  try {
    await create(f.ctx, meta); await create(f.ctx, control)
    const provider = await RetirementJsonlProvider.resolve(f.ctx)
    const proof = await prepareWithPathEvidence(provider, root, meta)
    const directory = proof[0]!.artifact!.directory
    const suffix = compression === 'none' ? '.jsonl' : '.jsonl.zstd'
    // Retained generations are opaque artifacts to cleanup. Copy current bytes
    // into lower-generation names; this tests removal, not legacy migration.
    await copyFile(join(directory, `session.v3${suffix}`), join(directory, `session.v1${suffix}`))
    await copyFile(join(directory, `session.v3${suffix}`), join(directory, `session.v2${suffix}`))
    expect((await readdir(directory)).filter(name => name.endsWith(suffix))).toHaveLength(3)
    await writeFile(join(directory, 'retained-metadata-evidence'), 'old sensitive metadata')
    const controlDirectory = retirementSessionDirectory(join(root, 'sessions'), control.cwd!, control.id)
    const controlFiles = await readdir(controlDirectory)
    const before = await Promise.all(controlFiles.map(name => readFile(join(controlDirectory, name))))
    expect(JSON.stringify(await f.ctx.sessionQuery.searchSessions({ query: 'retirementuniquesecret' }))).toContain(meta.id)
    const warm = await f.ctx.sessionQuery.observeSession(meta.id); warm[Symbol.dispose]()
    await provider.purge(proof)
    await expect(readdir(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.stringify(await f.ctx.sessionQuery.searchSessions({ query: 'retirementuniquesecret' }))).not.toContain(meta.id)
    await expect(f.ctx.sessionQuery.observeSession(meta.id)).rejects.toMatchObject({ code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
    expect(await Promise.all(controlFiles.map(name => readFile(join(controlDirectory, name))))).toEqual(before)
    await f.close(); f = await backend(root, compression)
    expect(await f.ctx.sessionPersistence.stat(meta.id)).toBeUndefined()
    expect(JSON.stringify(await f.ctx.sessionQuery.searchSessions({ query: 'retirementuniquesecret' }))).not.toContain(meta.id)
    expect(await f.ctx.sessionPersistence.stat(control.id)).toBeDefined()
  } finally { await f.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 20_000)
