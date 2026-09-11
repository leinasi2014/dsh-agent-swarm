import { copyFile, lstat, mkdtemp, readdir, readFile, realpath, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
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
import { expect, it, vi } from 'vitest'
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
