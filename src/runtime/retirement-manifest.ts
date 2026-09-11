/** Host-only exclusive Session manifest, derived from the complete durable corpus. */
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { referencedSessionIds } from '../domain/team-retirement.js'
import { TeamDomainError } from '../domain/error.js'
import type { TeamState } from '../domain/types.js'
import type { TeamRecord } from '../storage/team-spec.js'
import type { RetirementSession } from '../storage/team-retirement-store.js'
import type { RetirementCounts } from '../shared/team-retirement.js'

export function assertExclusiveReferences(teamId: string, ids: readonly string[], records: readonly TeamRecord[]): void {
  const owned = new Set(ids)
  for (const { team } of records) {
    if (team.id !== teamId && [...referencedSessionIds(team)].some(id => owned.has(id))) {
      throw new TeamDomainError('Another Team now references a selected Session; no Session data was removed', 'TEAM_RETIREMENT_REFERENCE_CONFLICT')
    }
  }
}

export async function retirementManifest(ctx: Context, scope: string, mainSessionId: string, team: TeamState,
  records: readonly TeamRecord[], signal: AbortSignal) {
  const persisted = await ctx.sessionPersistence.list({ signal })
  const headers = new Map<string, SessionHeader>(persisted.map(row => [row.header.id, row.header]))
  for (const session of ctx.sessions.list()) {
    const stored = headers.get(session.id)
    if (stored !== undefined && (stored.cwd !== session.header.cwd || stored.parentSession !== session.header.parentSession
      || stored.createdAt !== session.header.createdAt)) throw new TeamDomainError('Live and persisted Session identities disagree', 'TEAM_RETIREMENT_SESSION_CONFLICT')
    headers.set(session.id, session.header)
  }
  const shared = new Set<string>([mainSessionId])
  for (const { team: other } of records) if (other.id !== team.id) for (const id of referencedSessionIds(other)) shared.add(id)
  const seeds = new Set([team.captainSessionId, ...team.members.flatMap(member => [member.sessionId, ...(member.previousSessionIds ?? [])]),
    ...team.attempts.map(attempt => attempt.memberSessionId)].filter(Boolean))
  const owned = new Set<string>(), protectedIds = new Set<string>([mainSessionId])
  for (const id of seeds) {
    const header = headers.get(id)
    const parent = id === team.captainSessionId ? mainSessionId : team.captainSessionId
    if (shared.has(id)) protectedIds.add(id)
    else {
      if (header !== undefined && (header.cwd === undefined || resolve(header.cwd) !== scope || header.parentSession !== parent
        || header.origin !== 'subagent' || header.isSeeded === true)) {
        throw new TeamDomainError('Selected Session ownership does not match the Team tree', 'TEAM_RETIREMENT_SESSION_CONFLICT')
      }
      owned.add(id)
    }
  }
  let expanded = true
  while (expanded) {
    expanded = false
    for (const [id, header] of headers) {
      if (owned.has(id) || protectedIds.has(id) || header.parentSession === undefined || !owned.has(header.parentSession)) continue
      if (shared.has(id) || header.origin !== 'subagent' || header.isSeeded === true) protectedIds.add(id)
      else if (header.cwd === undefined || resolve(header.cwd) !== scope) throw new TeamDomainError('Owned descendant has an ambiguous workspace', 'TEAM_RETIREMENT_SESSION_CONFLICT')
      else { owned.add(id); expanded = true }
    }
  }
  if (owned.size > 8192) throw new TeamDomainError('Team Session tree exceeds the complete cleanup limit', 'TEAM_RETIREMENT_SCOPE_LIMIT')
  const ownedSessionIds = [...owned].sort()
  const sessions: RetirementSession[] = ownedSessionIds.flatMap(id => {
    const header = headers.get(id)
    return header === undefined ? [] : [{ id, cwd: header.cwd!, version: header.version, createdAt: header.createdAt,
      ...(header.parentSession === undefined ? {} : { parentSessionId: header.parentSession }), ...(header.origin === undefined ? {} : { origin: header.origin }) }]
  })
  return { ownedSessionIds, sessions, protectedSessionIds: [...protectedIds].sort() }
}

export function retirementDigest(team: TeamState, mainSessionId: string,
  manifest: { ownedSessionIds: readonly string[]; sessions: readonly RetirementSession[]; protectedSessionIds: readonly string[] }, counts: RetirementCounts): string {
  return createHash('sha256').update(JSON.stringify({ teamId: team.id, revision: team.revision, mainSessionId, manifest, counts })).digest('hex')
}
