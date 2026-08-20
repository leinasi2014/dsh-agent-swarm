import { mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { TeamDomainError } from '../domain/error.js'
import type { TeamId, TeamState } from '../domain/types.js'
import { assertTeamState } from '../domain/state-validation.js'

export type TeamTransaction<T> = (draft: TeamState) => T | Promise<T>

export interface TeamStore {
  createUniqueForCaptain(stateRoot: string, state: TeamState): Promise<void>
  read(stateRoot: string, teamId: TeamId): Promise<TeamState | undefined>
  list(stateRoot: string): Promise<TeamState[]>
  transact<T>(stateRoot: string, teamId: TeamId, operation: TeamTransaction<T>): Promise<T>
  waitForChange(stateRoot: string, teamId: TeamId, afterRevision: number, signal: AbortSignal): Promise<TeamState>
}

const TEAM_FILE = 'team.json'
const locks = new Map<string, Promise<void>>()
const revisionWaiters = new Map<string, Set<() => void>>()

function notifyRevision(path: string): void {
  for (const notify of revisionWaiters.get(path) ?? []) notify()
}

async function withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolvePromise => { release = resolvePromise })
  const tail = previous.then(() => current)
  locks.set(key, tail)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (locks.get(key) === tail) locks.delete(key)
  }
}

function assertSafeTeamId(teamId: TeamId): void {
  if (!/^team-[a-z0-9-]{8,80}$/.test(teamId)) {
    throw new TeamDomainError(`unsafe team id "${teamId}"`, 'TEAM_ID_INVALID')
  }
}

function teamPath(stateRoot: string, teamId: TeamId): string {
  assertSafeTeamId(teamId)
  return join(stateRoot, teamId, TEAM_FILE)
}

function cloneState(state: TeamState): TeamState {
  return structuredClone(state)
}

function parseState(text: string, path: string): TeamState {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new TeamDomainError(`invalid Team JSON at ${path}`, 'TEAM_STATE_CORRUPT', { cause: error })
  }
  if (typeof value === 'object' && value !== null && (value as { schemaVersion?: unknown }).schemaVersion !== 1) {
    throw new TeamDomainError(`unsupported Team state at ${path}`, 'TEAM_STATE_VERSION_UNSUPPORTED')
  }
  assertTeamState(value, path)
  return value
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function atomicWrite(path: string, value: TeamState): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  let committed = false
  try {
    const handle = await open(temp, 'wx')
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temp, path)
        committed = true
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (attempt >= 5 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw error
        await new Promise(resolvePromise => setTimeout(resolvePromise, 20 * (attempt + 1)))
      }
    }
  } finally {
    if (!committed) await unlink(temp).catch(() => undefined)
  }
}

/** Resolve a workspace-contained state root; absolute or escaping config fails loud. */
export function resolveStateRoot(workspaceCwd: string, stateDir: string): string {
  if (stateDir.trim() === '') throw new TeamDomainError('stateDir must not be empty', 'TEAM_INVALID_CONFIG')
  const workspace = resolve(workspaceCwd)
  const root = resolve(workspace, stateDir)
  const rel = relative(workspace, root)
  if (isAbsolute(stateDir) || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new TeamDomainError('stateDir must be workspace-relative and remain inside the workspace', 'TEAM_INVALID_CONFIG')
  }
  return root
}

/** File-backed, process-local-serialized compatibility Provider. */
export class FileTeamStore implements TeamStore {
  constructor(private readonly now: () => number = Date.now) {}

  async createUniqueForCaptain(stateRoot: string, state: TeamState): Promise<void> {
    await withLock(`${stateRoot}\0root`, async () => {
      const teams = await this.list(stateRoot)
      if (teams.some(team => team.phase === 'active' && team.captainSessionId === state.captainSessionId)) {
        throw new TeamDomainError('captain already owns an active team', 'TEAM_ALREADY_ACTIVE')
      }
      const path = teamPath(stateRoot, state.id)
      if (await pathExists(path)) throw new TeamDomainError(`team "${state.id}" already exists`, 'TEAM_ALREADY_EXISTS')
      await atomicWrite(path, state)
      notifyRevision(path)
    })
  }

  async read(stateRoot: string, teamId: TeamId): Promise<TeamState | undefined> {
    const path = teamPath(stateRoot, teamId)
    try {
      return cloneState(parseState(await readFile(path, 'utf8'), `${teamId}/${TEAM_FILE}`))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async list(stateRoot: string): Promise<TeamState[]> {
    if (!(await pathExists(stateRoot))) return []
    const entries = await readdir(stateRoot, { withFileTypes: true })
    const teams: TeamState[] = []
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || !entry.name.startsWith('team-')) continue
      const id = entry.name as TeamId
      const team = await this.read(stateRoot, id)
      if (team !== undefined) teams.push(team)
    }
    return teams
  }

  async transact<T>(stateRoot: string, teamId: TeamId, operation: TeamTransaction<T>): Promise<T> {
    return await withLock(teamPath(stateRoot, teamId), async () => {
      const current = await this.read(stateRoot, teamId)
      if (current === undefined) throw new TeamDomainError(`team "${teamId}" not found`, 'TEAM_NOT_FOUND')
      const draft = cloneState(current)
      const result = await operation(draft)
      if (isDeepStrictEqual(draft, current)) return result
      const now = this.now()
      Object.assign(draft, { revision: current.revision + 1, updatedAt: now })
      const path = teamPath(stateRoot, teamId)
      await atomicWrite(path, draft)
      notifyRevision(path)
      return result
    })
  }

  async waitForChange(stateRoot: string, teamId: TeamId, afterRevision: number, signal: AbortSignal): Promise<TeamState> {
    const path = teamPath(stateRoot, teamId)
    const current = await this.read(stateRoot, teamId)
    if (current === undefined) throw new TeamDomainError(`team "${teamId}" not found`, 'TEAM_NOT_FOUND')
    if (current.revision > afterRevision) return current
    if (signal.aborted) throw signal.reason

    return await new Promise<TeamState>((resolvePromise, reject) => {
      let checking = false
      let settled = false
      const waiters = revisionWaiters.get(path) ?? new Set<() => void>()
      const cleanup = (): void => {
        waiters.delete(check)
        if (waiters.size === 0) revisionWaiters.delete(path)
        signal.removeEventListener('abort', onAbort)
      }
      const finish = (operation: () => void): void => {
        if (settled) return
        settled = true
        cleanup()
        operation()
      }
      const onAbort = (): void => { finish(() => reject(signal.reason)) }
      const check = (): void => {
        if (checking || settled) return
        checking = true
        void this.read(stateRoot, teamId).then(next => {
          if (next === undefined) {
            finish(() => reject(new TeamDomainError(`team "${teamId}" not found`, 'TEAM_NOT_FOUND')))
          } else if (next.revision > afterRevision) {
            finish(() => resolvePromise(next))
          }
        }).catch(error => { finish(() => reject(error)) }).finally(() => { checking = false })
      }
      waiters.add(check)
      revisionWaiters.set(path, waiters)
      signal.addEventListener('abort', onAbort, { once: true })
      check()
    })
  }
}
