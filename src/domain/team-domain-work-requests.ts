import { createHash, randomUUID } from 'node:crypto'
import { expectDomain } from './error.js'
import { actorMembership, type TeamDomainDeps } from './team-domain-shared.js'
import { submitWorkRequestInputSchema, workRequestOriginSchema, workRequestSchema } from '../shared/work-request.js'
import { TaskId, type TeamState, type TeamId } from './types.js'
import type { TeamScope } from './team-domain-port.js'
import type { WorkRequest, WorkRequestRecord, WorkRequestOrigin, SubmitWorkRequestInput, ResolveWorkRequestInput, WorkRequestResult, WorkRequestAdmission, WorkRequestResolutionGuards } from './work-request.js'
import { queueWorkRequestNoticeInDraft } from './team-domain-mailbox.js'
import { prepareTaskInDraft } from './task-creation.js'
import { assertTaskGraph } from './graph.js'
import { appendWorkActivity } from './team-domain-work-activity.js'
import { publicManagedParent } from './public-message.js'

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) return `{${Object.entries(value).filter(([, item]) => item !== undefined).toSorted(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}
const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex')
const sameOrigin = (left: WorkRequestOrigin, right: WorkRequestOrigin): boolean => canonical(left) === canonical(right)
export const projectWorkRequest = (record: WorkRequestRecord): WorkRequest => {
  const { contentDigest: _content, notificationMessageId: _message, decisionDigest: _decision, ...value } = record
  return workRequestSchema.parse(value)
}
function result(record: WorkRequestRecord, replayed: boolean, teamRevision: number): WorkRequestResult {
  return { request: projectWorkRequest(record), replayed, teamRevision, notificationMessageId: record.notificationMessageId }
}
function assertOrigin(team: TeamState, origin: WorkRequestOrigin): void {
  expectDomain(team.phase === 'active' && team.captainSessionId !== '', 'work requests require an active Captain', 'TEAM_ARCHIVED')
  if (origin.kind === 'main') expectDomain(publicManagedParent(team.managedOrigin) === origin.sessionId, 'work request Main does not own this Team', 'TEAM_WORK_REQUEST_ORIGIN_INVALID')
}
export async function submitWorkRequest(deps: TeamDomainDeps, scope: TeamScope, teamId: TeamId, rawOrigin: WorkRequestOrigin, raw: SubmitWorkRequestInput, admission?: WorkRequestAdmission): Promise<WorkRequestResult> {
  const parsed = submitWorkRequestInputSchema.safeParse(raw)
  const originResult = workRequestOriginSchema.safeParse(rawOrigin)
  expectDomain(parsed.success && originResult.success, 'invalid work request', 'TEAM_INPUT_INVALID')
  const input = parsed.data
  const origin = originResult.data
  const contentDigest = digest(input)
  let committed!: WorkRequestResult
  await deps.store.transact(scope, teamId, team => {
    assertOrigin(team, origin)
    if (admission !== undefined) expectDomain(team.captainSessionId === admission.expectedCaptainSessionId && team.managedOrigin === admission.expectedManagedOrigin,
      'verified work request binding changed', 'TEAM_WORK_REQUEST_ORIGIN_INVALID')
    const requests = team.workRequests?.requests ?? []
    const existing = requests.find(item => item.requestId === input.requestId && sameOrigin(item.origin, origin))
    if (existing !== undefined) {
      expectDomain(existing.contentDigest === contentDigest, 'requestId already has another payload', 'TEAM_WORK_REQUEST_CONFLICT')
      committed = result(existing, true, team.revision); return
    }
    if (admission !== undefined) expectDomain(team.revision === admission.expectedTeamRevision, 'verified Team revision changed', 'TEAM_REVISION_CONFLICT')
    expectDomain(requests.length < 256, 'work request identity capacity reached', 'TEAM_WORK_REQUEST_CAPACITY')
    if (input.sourceMessageId !== undefined) expectDomain(team.publicChat?.messages.some(message => message.id === input.sourceMessageId) === true,
      'source message is not visible in this Team', 'TEAM_WORK_REQUEST_SOURCE_INVALID')
    const id = `work-request-${randomUUID()}`
    const timestamp = deps.now()
    const notice = queueWorkRequestNoticeInDraft(deps, team, id, origin, input.description)
    const record: WorkRequestRecord = { ...input, id, origin, revision: 1, createdAt: timestamp, contentDigest, notificationMessageId: notice.id }
    Object.assign(team, { workRequests: { schemaVersion: 1, requests: [...requests, record] } })
    appendWorkActivity(team, { kind: 'request-proposed', workRequestId: id, actor: origin, occurredAt: timestamp })
    committed = result(record, false, team.revision + 1)
  })
  return structuredClone(committed)
}
export async function workRequestResult(deps: TeamDomainDeps, scope: TeamScope, teamId: TeamId, origin: WorkRequestOrigin, requestId: string): Promise<WorkRequest | undefined> {
  const team = await deps.store.read(scope, teamId)
  expectDomain(team !== undefined, 'Team not found', 'TEAM_NOT_FOUND')
  assertOrigin(team, workRequestOriginSchema.parse(origin))
  const record = team.workRequests?.requests.find(item => item.requestId === requestId && sameOrigin(item.origin, origin))
  return record === undefined ? undefined : projectWorkRequest(record)
}
export async function listWorkRequests(deps: TeamDomainDeps, scope: TeamScope, teamId: TeamId, actor: string): Promise<WorkRequest[]> {
  const team = await deps.store.read(scope, teamId)
  expectDomain(team !== undefined, 'Team not found', 'TEAM_NOT_FOUND')
  expectDomain(actorMembership(team, actor).role === 'captain', 'only Captain reads pending work requests', 'TEAM_CAPTAIN_REQUIRED')
  return (team.workRequests?.requests ?? []).filter(record => record.resolution === undefined).map(projectWorkRequest)
}
export async function resolveWorkRequest(deps: TeamDomainDeps, scope: TeamScope, teamId: TeamId, actor: string, rawInput: ResolveWorkRequestInput, guards?: WorkRequestResolutionGuards): Promise<WorkRequestResult> {
  const input = structuredClone(rawInput)
  const decisionDigest = digest(input.decision)
  let committed!: WorkRequestResult
  await deps.store.transact(scope, teamId, team => {
    expectDomain(actorMembership(team, actor).role === 'captain', 'only Captain resolves work requests', 'TEAM_CAPTAIN_REQUIRED')
    guards?.assertExecution?.()
    const record = team.workRequests?.requests.find(item => item.id === input.workRequestId)
    expectDomain(record !== undefined, 'work request not found', 'TEAM_WORK_REQUEST_NOT_FOUND')
    if (record.resolution !== undefined) {
      expectDomain(record.decisionDigest === decisionDigest, 'work request already has another decision', 'TEAM_WORK_REQUEST_CONFLICT')
      committed = result(record, true, team.revision); return
    }
    expectDomain(record.revision === input.expectedRequestRevision, 'stale work request revision', 'TEAM_WORK_REQUEST_STALE_REVISION')
    const timestamp = deps.now()
    let resolution: NonNullable<WorkRequest['resolution']>
    if (input.decision.kind === 'reject') {
      const publicReason = input.decision.publicReason.trim()
      expectDomain(publicReason.length > 0 && publicReason.length <= 4096, 'rejection reason is required and bounded', 'TEAM_INPUT_INVALID')
      resolution = { kind: 'reject', actorSessionId: actor, occurredAt: timestamp, publicReason }
    } else {
      expectDomain(input.decision.kind === 'accept', 'invalid work request decision', 'TEAM_INPUT_INVALID')
      // Only genuinely new tasks need runtime admission; terminal replay and
      // rejection remain available after a Provider disappears. Never persist
      // this synchronous, caller-owned guard or let it replace actor/CAS checks.
      guards?.assertNewTaskAdmission?.()
      const items = input.decision.items
      expectDomain(items.length >= 1 && items.length <= 32, 'accept requires 1 to 32 tasks', 'TEAM_INPUT_INVALID')
      expectDomain(team.tasks.length + items.length <= deps.limits.maxTasks, 'team task limit reached', 'TEAM_TASK_LIMIT')
      const mapping = new Map<string, TaskId>()
      for (const [index, item] of items.entries()) {
        expectDomain(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(item.itemKey) && !mapping.has(item.itemKey), 'invalid or duplicate itemKey', 'TEAM_INPUT_INVALID')
        mapping.set(item.itemKey, TaskId(`task-${team.nextTaskNumber + index}`))
      }
      const tasks = items.map(item => {
        const blockedBy = [...(item.blockedBy ?? []), ...(item.blockedByItems ?? []).map(key => {
          const id = mapping.get(key)
          expectDomain(id !== undefined, 'unresolved batch dependency', 'TEAM_TASK_DEPENDENCY_INVALID')
          return id
        })]
        return prepareTaskInDraft(deps, team, actor, { ...item, blockedBy }, mapping.get(item.itemKey)!, { workRequestId: record.id, itemKey: item.itemKey, origin: record.origin })
      })
      assertTaskGraph([...team.tasks, ...tasks])
      team.tasks.push(...tasks)
      Object.assign(team, { nextTaskNumber: team.nextTaskNumber + tasks.length })
      resolution = { kind: 'accept', actorSessionId: actor, occurredAt: timestamp, taskIdsByItemKey: Object.fromEntries(mapping) }
      for (const task of tasks) appendWorkActivity(team, { kind: 'task-created', actor: { kind: 'session', sessionId: actor }, taskId: task.id, workRequestId: record.id, status: task.status, occurredAt: timestamp })
    }
    const resolved: WorkRequestRecord = { ...record, revision: record.revision + 1, decisionDigest, resolution }
    team.workRequests!.requests[team.workRequests!.requests.indexOf(record)] = resolved
    appendWorkActivity(team, { kind: resolution.kind === 'accept' ? 'request-accepted' : 'request-rejected', actor: { kind: 'session', sessionId: actor }, workRequestId: record.id, occurredAt: timestamp })
    committed = result(resolved, false, team.revision + 1)
  })
  return structuredClone(committed)
}
