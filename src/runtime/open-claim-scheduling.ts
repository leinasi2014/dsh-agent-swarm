/** Final section of the existing scheduling pass; it creates no independent owner or timer. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TeamDomainError } from '../domain/error.js'
import type { TeamId } from '../domain/types.js'
import type { TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import { openClaimTemporarilyUnavailable } from '../domain/team-domain-open-claim.js'
import type { MessageDelivery } from './message-delivery.js'

export async function notifyOpenTasks(ctx: Context, deps: {
  domain(): TeamDomainPort; delivery(): MessageDelivery; isClosing(): boolean
}, scope: TeamScope, teamId: TeamId, captain: Agent): Promise<void> {
  let snapshot = await deps.domain().snapshot(scope, teamId, captain.id)
  if (snapshot.team.goalLifecycle?.phase === 'paused') return
  const open = snapshot.team.tasks.filter(task => task.assignmentMode === 'open-claim' && snapshot.readyTaskIds.includes(task.id))
  for (const task of open) {
    if (deps.isClosing()) return
    snapshot = await deps.domain().snapshot(scope, teamId, captain.id)
    if (snapshot.team.goalLifecycle?.phase === 'paused') return
    const recipients = snapshot.team.members.filter(member => member.phase === 'active'
      && (ctx.agents.get(SessionId(member.sessionId))?.status ?? 'idle') === 'idle'
      && !openClaimTemporarilyUnavailable(snapshot.team, task, member.sessionId, Date.now())).map(member => member.sessionId)
    if (recipients.length === 0) continue
    try {
      await deps.domain().noticeOpenClaimTask(scope, teamId, captain.id, {
        taskId: task.id, expectedTaskRevision: task.revision, recipientSessionIds: recipients,
      })
    } catch (error) {
      if (!(error instanceof TeamDomainError) || !['TEAM_TASK_STALE_REVISION', 'TEAM_TASK_NOT_READY', 'TEAM_MAILBOX_FULL'].includes(error.code)) throw error
    }
  }
  snapshot = await deps.domain().snapshot(scope, teamId, captain.id)
  for (const notice of snapshot.team.messages) {
    if (deps.isClosing()) return
    if (notice.kind === 'open-claim-notice' && notice.phase === 'queued') {
      await deps.delivery().deliverQueuedMessage(scope, teamId, captain, notice.id, AbortSignal.timeout(30_000))
    }
  }
}
