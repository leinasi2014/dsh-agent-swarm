/**
 * Read-only reader for pre-M1A workspace `FileTeamStore` state (ADR-0007).
 *
 * The production runtime never constructs this class: authoritative Team
 * aggregates live in the official Storage Domain behind
 * `StorageDomainTeamStore`. This reader exists only so the explicit one-way
 * migration (and tests fabricating legacy state) can validate and read the
 * legacy `<stateRoot>/<teamId>/team.json` layout. It deliberately provides
 * no write path, no transaction, and no change notification; the legacy
 * source stays untouched so it remains rollback evidence.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { TeamDomainError } from '../domain/error.js'
import { assertTeamState } from '../domain/state-validation.js'
import type { TeamId, TeamState } from '../domain/types.js'

const TEAM_FILE = 'team.json'

function assertSafeTeamId(teamId: TeamId): void {
  if (!/^team-[a-z0-9-]{8,80}$/.test(teamId)) {
    throw new TeamDomainError(`unsafe team id "${teamId}"`, 'TEAM_ID_INVALID')
  }
}

function teamPath(stateRoot: string, teamId: TeamId): string {
  assertSafeTeamId(teamId)
  return join(stateRoot, teamId, TEAM_FILE)
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

/** Resolve a workspace-contained legacy state root; escaping config fails loud. */
export function resolveStateRoot(workspaceCwd: string, stateDir: string): string {
  if (stateDir.trim() === '') throw new TeamDomainError('stateDir must not be empty', 'TEAM_INVALID_CONFIG')
  const root = resolve(workspaceCwd, stateDir)
  const rel = relative(workspaceCwd, root)
  if (isAbsolute(stateDir) || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new TeamDomainError('stateDir must be workspace-relative and remain inside the workspace', 'TEAM_INVALID_CONFIG')
  }
  return root
}

/** Read-only legacy `FileTeamStore` reader for migration and test fixtures. */
export class FileTeamStore {
  /** Read and validate one legacy Team aggregate. */
  async read(stateRoot: string, teamId: TeamId): Promise<TeamState | undefined> {
    const path = teamPath(stateRoot, teamId)
    try {
      return structuredClone(parseState(await readFile(path, 'utf8'), `${teamId}/${TEAM_FILE}`))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  /** List every legacy Team aggregate under one state root. */
  async list(stateRoot: string): Promise<TeamState[]> {
    if (!(await pathExists(stateRoot))) return []
    const entries = await readdir(stateRoot, { withFileTypes: true })
    const teams: TeamState[] = []
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || !entry.name.startsWith('team-')) continue
      const team = await this.read(stateRoot, entry.name as TeamId)
      if (team !== undefined) teams.push(team)
    }
    return teams
  }

  /** Absolute path of one legacy aggregate file, for receipt provenance. */
  pathOf(stateRoot: string, teamId: TeamId): string {
    return teamPath(stateRoot, teamId)
  }
}
