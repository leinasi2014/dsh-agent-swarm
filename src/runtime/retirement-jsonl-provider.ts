/** Fixed-version Windows adapter over public JSONL write ownership and public query reconciliation. */
import { createRequire } from 'node:module'
import type { BigIntStats } from 'node:fs'
import { lstat, readdir, realpath, rmdir, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import type JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import { TeamDomainError } from '../domain/error.js'
import type { RetirementSession } from '../storage/team-retirement-store.js'

const require = createRequire(import.meta.url)
const VERSION = '0.1.5-alpha.2'
function refuse(message: string): never { throw new TeamDomainError(message, 'TEAM_RETIREMENT_PROVIDER_UNAVAILABLE') }
const absent = (error: unknown): boolean => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'

/** Mirrors the published alpha.2 JSONL format; never imports private path helpers. */
function encodeSegment(value: string): string {
  if (value === '.' || value === '..') return value.replaceAll('.', '~002E')
  let encoded = ''
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!
    encoded += /^[A-Za-z0-9._-]$/u.test(character) ? character : `~${value.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0')}`
  }
  return encoded
}
export function retirementSessionDirectory(root: string, cwd: string, id: string): string {
  const slug = encodeSegment(cwd.replace(/[\\/:]+/gu, '-')).replace(/^-+/u, '') || 'root'
  return join(root, `--${slug.slice(0, 251)}--`, encodeSegment(id))
}
async function identity(path: string): Promise<string | undefined> {
  try {
    const stat = await lstat(path, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink()) refuse('Session artifact directory is not a direct physical directory')
    // Windows 8.3 and case aliases change realpath spelling without redirecting
    // an ancestor. Reject actual links at every level, then compare physical identity.
    for (let parent = dirname(resolve(path)); ; parent = dirname(parent)) {
      const ancestor = await lstat(parent, { bigint: true })
      if (!ancestor.isDirectory() || ancestor.isSymbolicLink()) refuse('Session artifact directory is not a direct physical directory')
      if (dirname(parent) === parent) break
    }
    const canonical = await lstat(await realpath(path), { bigint: true })
    if (!canonical.isDirectory() || canonical.isSymbolicLink() || physicalIdentity(canonical) !== physicalIdentity(stat)) {
      refuse('Session artifact directory changed while resolving its physical identity')
    }
    return physicalIdentity(stat)
  } catch (error) { if (absent(error)) return undefined; throw error }
}
function physicalIdentity(stat: BigIntStats): string { return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}` }
function headerOf(session: RetirementSession): SessionHeader {
  if (session.version !== 3) refuse('Cleanup requires a current v3 logical Session header')
  return { id: SessionId(session.id), cwd: session.cwd, version: 3, isSeeded: false, createdAt: session.createdAt,
    ...(session.parentSessionId === undefined ? {} : { parentSession: SessionId(session.parentSessionId) }),
    ...(session.origin === undefined ? {} : { origin: session.origin }) }
}
function sameIdentity(header: SessionHeader, session: RetirementSession): boolean {
  return header.id === session.id && header.cwd === session.cwd && header.parentSession === session.parentSessionId
    && header.createdAt === session.createdAt && header.version === session.version && header.origin === session.origin
}

export class RetirementJsonlProvider {
  private constructor(private readonly ctx: Context, private readonly persistence: JsonlSessionPersistence,
    private readonly query: SqliteSessionQueryEngine, private readonly root: string) {}

  static async resolve(ctx: Context): Promise<RetirementJsonlProvider> {
    if (process.platform !== 'win32') refuse('Permanent Session deletion currently supports Windows only')
    const [{ default: Jsonl }, { default: Sqlite }] = await Promise.all([
      import('@deepseek-ai/dsh-session-persistence-jsonl'), import('@deepseek-ai/dsh-session-query-sqlite'),
    ])
    for (const name of ['dsh-session-persistence-jsonl', 'dsh-session-query-sqlite']) {
      if ((require(`@deepseek-ai/${name}/package.json`) as { version: string }).version !== VERSION) refuse('Session cleanup requires the verified alpha.2 backends')
    }
    if (!(ctx.sessionPersistence instanceof Jsonl) || !(ctx.sessionQuery instanceof Sqlite)) refuse('The active Session backends do not support verified cleanup')
    const root = ctx.sessionPersistence.config.root
    if (!isAbsolute(root)) refuse('JSONL cleanup requires its configured absolute root')
    const provider = new RetirementJsonlProvider(ctx, ctx.sessionPersistence, ctx.sessionQuery, resolve(root))
    await provider.assertQueryAvailable()
    return provider
  }

  private async assertQueryAvailable(): Promise<void> {
    if (this.query.config.openAt !== 'never' || this.query.config.path === ':memory:') return
    for (const path of [this.query.config.path, this.query.config.path + '-wal', this.query.config.path + '-shm']) {
      try { await lstat(path); refuse('A disabled search backend has an existing index; enable search before permanent deletion') }
      catch (error) { if (!absent(error)) throw error }
    }
  }

  async prepare(sessions: readonly RetirementSession[], signal: AbortSignal): Promise<RetirementSession[]> {
    const result: RetirementSession[] = []
    for (const session of sessions) {
      signal.throwIfAborted()
      const rootIdentity = await identity(this.root)
      const directory = retirementSessionDirectory(this.root, session.cwd, session.id)
      const directoryIdentity = await identity(directory)
      const snapshot = await this.persistence.stat(SessionId(session.id), { signal })
      if (snapshot === undefined || !sameIdentity(snapshot.header, session)) refuse('Selected Session changed during cleanup preview')
      if (directoryIdentity === undefined) {
        if (!this.persistence.hasPendingSession(SessionId(session.id))) refuse('Selected Session has no verifiable canonical artifact')
        result.push(session); continue
      }
      const current = await this.persistence.resolveCurrentLog(SessionId(session.id), signal)
      if (current === undefined || resolve(dirname(current)) !== directory || rootIdentity === undefined) refuse('Session log is outside its canonical alpha.2 directory')
      await this.assertDirectory(directory)
      result.push({ ...session, artifact: { root: this.root, directory, rootIdentity, directoryIdentity } })
    }
    return result
  }

  private async assertDirectory(directory: string): Promise<void> {
    const within = relative(this.root, directory)
    if (!within || within.startsWith('..' + sep) || isAbsolute(within)) refuse('Session directory is outside the configured root')
    if (await identity(dirname(directory)) === undefined) refuse('Session project directory is absent')
    for (const entry of await readdir(directory, { withFileTypes: true })) if (!entry.isFile() || entry.isSymbolicLink()) refuse('Session directory contains an unsupported entry')
  }

  async purge(sessions: readonly RetirementSession[]): Promise<void> {
    for (const session of sessions) {
      const id = SessionId(session.id)
      if (this.ctx.agents.get(id) !== undefined || this.ctx.sessions.get(id) !== undefined || this.persistence.hasPendingSession(id)) refuse('Session producer is still present')
      const proof = session.artifact
      const snapshot = await this.persistence.stat(id)
      if (proof === undefined) { if (snapshot !== undefined) refuse('Session materialized after confirmation'); continue }
      if (proof.root !== this.root || proof.directory !== retirementSessionDirectory(this.root, session.cwd, session.id)
        || await identity(this.root) !== proof.rootIdentity) refuse('Session cleanup root changed')
      const present = await identity(proof.directory)
      if (present === undefined) { if (snapshot !== undefined) refuse('Session relocated after confirmation'); continue }
      const emptyReplacement = present !== proof.directoryIdentity
      if ((snapshot !== undefined && (!sameIdentity(snapshot.header, session) || emptyReplacement))
        || (emptyReplacement && (await readdir(proof.directory)).length !== 0)) refuse('Session artifact identity changed')
      // The public canonical lease also works after a partial deletion removed the current log.
      const lease = await this.persistence.acquireWriteLease(headerOf(session))
      try {
        if (await identity(proof.directory) !== present) refuse('Session directory changed while claiming its write lease')
        if (this.ctx.sessions.get(id) !== undefined || this.ctx.agents.get(id) !== undefined || this.persistence.hasPendingSession(id)) refuse('Session writer appeared during cleanup')
        const lockedSnapshot = await this.persistence.stat(id)
        if (lockedSnapshot !== undefined && (emptyReplacement || !sameIdentity(lockedSnapshot.header, session))) refuse('Session identity changed while claiming its write lease')
        const current = await this.persistence.resolveCurrentLog(id)
        if (current !== undefined && resolve(dirname(current)) !== proof.directory) refuse('Session moved away from the held canonical lease')
        await this.assertDirectory(proof.directory)
        const entries = await readdir(proof.directory)
        // A refused concurrent create may leave an empty directory after the old
        // one was removed. Its new identity authorizes rmdir only, never unlink.
        if (emptyReplacement && entries.length !== 0) refuse('Replacement Session directory contains data')
        if (!emptyReplacement) for (const entry of entries) await unlink(join(proof.directory, entry))
        await rmdir(proof.directory)
        if (await this.persistence.stat(id) !== undefined) refuse('Session remains visible after artifact removal')
        if (await identity(proof.directory) !== undefined) refuse('Session directory reappeared while its write lease was held')
      } finally { await lease.release() }
    }
    await this.assertQueryAvailable()
    if (this.query.config.openAt !== 'never') await this.query.searchSessions({ query: 'team retirement reconciliation', limit: 1 })
    const remaining = new Set((await this.persistence.list()).map(row => String(row.header.id)))
    if (sessions.some(session => remaining.has(session.id))) refuse('Session list still contains deleted records')
    for (const session of sessions) {
      try {
        const observation = await this.query.observeSession(SessionId(session.id))
        observation[Symbol.dispose]()
        refuse('Session query still observes a deleted record')
      } catch (error) {
        if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') throw error
      }
    }
  }
}
