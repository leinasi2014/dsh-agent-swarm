import { randomUUID } from 'node:crypto'
import { expectDomain } from './error.js'
import { workActivitySchema } from '../shared/work-request.js'
import type { WorkActivity, WorkActivityPage } from './work-request.js'
import type { TeamState, TeamId } from './types.js'
import type { TeamScope } from './team-domain-port.js'
import type { TeamDomainDeps } from './team-domain-shared.js'
import { projectWorkRequest } from './team-domain-work-requests.js'

export function appendWorkActivity(team: TeamState, input: Omit<WorkActivity, 'id' | 'sequence'>): void {
  const state = team.workActivity ?? { schemaVersion: 1 as const, nextSequence: 1, entries: [] }
  const entry = workActivitySchema.parse({ ...input, id: `work-activity-${randomUUID()}`, sequence: state.nextSequence })
  Object.assign(team, { workActivity: { schemaVersion: 1, nextSequence: state.nextSequence + 1, entries: [...state.entries, entry].slice(-1024) } })
}

export async function workActivity(deps: TeamDomainDeps, scope: TeamScope, teamId: TeamId, afterSequence = 0, limit = 100): Promise<WorkActivityPage> {
  expectDomain(Number.isSafeInteger(afterSequence) && afterSequence >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'invalid work activity page', 'TEAM_INPUT_INVALID')
  const team = await deps.store.read(scope, teamId)
  expectDomain(team !== undefined, 'Team not found', 'TEAM_NOT_FOUND')
  const state = team.workActivity
  const remaining = (state?.entries ?? []).filter(entry => entry.sequence > afterSequence)
  const entries = remaining.slice(0, limit)
  const requestIds = new Set(entries.flatMap(entry => entry.workRequestId === undefined ? [] : [entry.workRequestId]))
  const referencedRequests = (team.workRequests?.requests ?? []).filter(request => requestIds.has(request.id)).map(projectWorkRequest)
  return structuredClone({ teamId, teamRevision: team.revision, afterSequence, retainedFromSequence: state?.entries[0]?.sequence ?? 1,
    throughSequence: (state?.nextSequence ?? 1) - 1, entries, referencedRequests, hasMore: remaining.length > limit })
}
