/** Archive transition shared by Captain tools and the authenticated local operator. */
import type { TeamLimits, TeamState } from './types.js'
import { attemptOf, clearTaskExecution, replaceAttempt, replaceTask } from './team-domain-shared.js'
import { pruneRetainedAttempts } from './team-domain-board.js'
import { pruneRetainedMessages } from './team-domain-mailbox.js'
import { acknowledgePublicMessageDraft, settlePublicMessageDraft } from './team-domain-public.js'

export interface RetirementPublicFact { messageId: string; recipientSessionId: string; visibility: 'claimed' | 'absent' | 'pending' }
export function settleRetiredPublicDraft(team: TeamState, facts: readonly RetirementPublicFact[], timestamp: number): void {
  for (const fact of facts) {
    if (fact.visibility === 'claimed') acknowledgePublicMessageDraft(team, fact.messageId, fact.recipientSessionId, timestamp)
    else settlePublicMessageDraft(team, fact.messageId, fact.recipientSessionId, 'team-archived', timestamp)
  }
}

export function archiveTeamDraft(team: TeamState, timestamp: number, reason: string,
  limits: Pick<TeamLimits, 'maxRetainedMessages' | 'maxRetainedAttempts'>): void {
  for (let index = 0; index < team.members.length; index += 1) {
    const member = team.members[index]!
    if (member.phase === 'active' || member.phase === 'provisioning') team.members[index] = { ...member, phase: 'removed', error: reason }
  }
  for (const task of team.tasks) {
    if (!['pending', 'in_progress', 'submitted', 'verifying'].includes(task.status)) continue
    if (task.currentAttemptId !== undefined) {
      const attempt = attemptOf(team, task.currentAttemptId)
      replaceAttempt(team, { ...attempt, phase: 'stale', diagnostic: reason, updatedAt: timestamp })
    }
    replaceTask(team, clearTaskExecution(task, { revision: task.revision + 1, status: 'cancelled', updatedAt: timestamp }))
  }
  for (let index = 0; index < team.messages.length; index += 1) {
    const message = team.messages[index]!
    if (message.phase === 'queued') team.messages[index] = { ...message, phase: 'cancelled' }
  }
  pruneRetainedMessages(team, limits.maxRetainedMessages)
  pruneRetainedAttempts(team, limits.maxRetainedAttempts)
  Object.assign(team, { phase: 'archived', ...(team.captainSessionId === '' ? { discardReason: 'discarded' } : {}) })
}

/** Canonical identities include historical attempts and receipts, across every scope. */
export function referencedSessionIds(team: TeamState): Set<string> {
  const ids = new Set<string>(Object.keys(team.usageCursors))
  const visit = (value: unknown, key = ''): void => {
    if (typeof value === 'string' && /(?:^sessionId$|SessionId$|SessionIds$)/u.test(key) && value !== '') ids.add(value)
    else if (Array.isArray(value)) for (const item of value) visit(item, key)
    else if (value !== null && typeof value === 'object') for (const [childKey, item] of Object.entries(value)) visit(item, childKey)
  }
  visit(team)
  return ids
}
