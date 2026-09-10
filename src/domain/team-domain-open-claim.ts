import { expectDomain, TeamDomainError } from './error.js'
import { Buffer } from 'node:buffer'
import { isTaskReady } from './graph.js'
import { actorMembership, replaceTask, type TeamDomainDeps } from './team-domain-shared.js'
import { budgetAvailable, reservationAdmissible, outstandingReservationTokens } from './team-domain-budget.js'
import { queueMessageInDraft } from './team-domain-mailbox.js'
import type { TeamScope } from './team-domain-port.js'
import type { TeamId, TeamMessage, TeamState, TeamTask } from './types.js'
import type { NoticeOpenClaimTaskInput, NoticeOpenClaimTaskResult } from './work-request.js'

/** Transient busy/budget conditions defer queued notices; they never settle obsolete. */
export function openClaimTemporarilyUnavailable(team: TeamState, task: TeamTask, recipient: string, now: number): boolean {
  if (team.tasks.some(item => item.ownerSessionId === recipient && ['in_progress', 'submitted', 'verifying'].includes(item.status))) return true
  try { budgetAvailable(team.budget, now) } catch { return true }
  return !reservationAdmissible(team.budget, outstandingReservationTokens(team.tasks), task.reservationTokens ?? 0)
}
export function openClaimNoticeDeferred(team: TeamState, message: TeamMessage, now: number): boolean {
  if (message.kind !== 'open-claim-notice') return false
  const task = team.tasks.find(item => item.id === message.causal?.taskId)
  return task !== undefined && openClaimTemporarilyUnavailable(team, task, message.targetSessionId, now)
}
export async function noticeOpenClaimTask(deps: TeamDomainDeps, scope: TeamScope, teamId: TeamId, actor: string, input: NoticeOpenClaimTaskInput): Promise<NoticeOpenClaimTaskResult> {
  const result: NoticeOpenClaimTaskResult = { messageIds: [], notifiedSessionIds: [] }
  await deps.store.transact(scope, teamId, team => {
    expectDomain(actorMembership(team, actor).role === 'captain', 'only Captain can announce open work', 'TEAM_CAPTAIN_REQUIRED')
    const task = team.tasks.find(item => item.id === input.taskId)
    expectDomain(task !== undefined, 'task not found', 'TEAM_TASK_NOT_FOUND')
    expectDomain(task.revision === input.expectedTaskRevision, 'stale task revision', 'TEAM_TASK_STALE_REVISION')
    expectDomain(task.assignmentMode === 'open-claim' && task.ownerSessionId === undefined && isTaskReady(team.tasks, task), 'open task is not ready', 'TEAM_TASK_NOT_READY')
    expectDomain(input.recipientSessionIds.length <= deps.limits.maxMembers, 'too many recipients', 'TEAM_INPUT_LIMIT')
    const prior = task.openClaimNotice?.revision === task.revision ? task.openClaimNotice.recipientSessionIds : []
    const recipients = new Set(prior.filter(session => team.members.some(member => member.sessionId === session && member.phase === 'active')))
    for (const session of new Set(input.recipientSessionIds)) {
      if (session === team.captainSessionId || recipients.has(session)) continue
      const member = team.members.find(item => item.sessionId === session && item.phase === 'active')
      if (member === undefined || openClaimTemporarilyUnavailable(team, task, session, deps.now())) continue
      let message: TeamMessage
      try {
        message = queueMessageInDraft(deps, team, actor, member.name,
          `Open task ${task.id} revision ${task.revision}: ${task.subject}. Read the current task and claim only for yourself if still available. This notice grants no attempt capability.`,
          'wakeup', { taskId: task.id, revision: task.revision })
      } catch (error) {
        if (error instanceof TeamDomainError && error.code === 'TEAM_MAILBOX_FULL') continue
        throw error
      }
      Object.assign(message, { kind: 'open-claim-notice' })
      expectDomain(Buffer.byteLength(JSON.stringify(message), 'utf8') <= deps.limits.maxMessageBytes, 'open notice frame is too large', 'TEAM_INPUT_LIMIT')
      recipients.add(session)
      result.messageIds.push(message.id)
      result.notifiedSessionIds.push(session)
    }
    if (result.messageIds.length > 0 || recipients.size !== prior.length) replaceTask(team, { ...task, openClaimNotice: { revision: task.revision, recipientSessionIds: [...recipients].toSorted() } })
  })
  return result
}
