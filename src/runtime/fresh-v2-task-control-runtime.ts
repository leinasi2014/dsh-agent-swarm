import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TeamDomainError } from '../domain/error.js'
import { TeamV2TaskControlDomain } from '../domain/team-domain-v2-task-control.js'
import { AttemptId, TaskId, type TeamTask } from '../domain/types.js'
import type { StorageDomainTeamStoreV2 } from '../storage/storage-domain-team-store-v2.js'
import type { ReassignTaskRuntime, SubmitTaskRuntime } from '../tools/task-board.js'
import { requireAgent, type ToolExecutionAuthority } from './authority.js'
import { findFreshV2Membership } from './fresh-v2-initial-support.js'

/** Tool-authority adapter around the atomic v2 submit/reassign domain. */
export class FreshV2TaskControlRuntime implements SubmitTaskRuntime, ReassignTaskRuntime {
  private readonly domain: TeamV2TaskControlDomain

  constructor(
    private readonly ctx: Context,
    private readonly store: StorageDomainTeamStoreV2,
    private readonly scopeOf: (agent: ReturnType<typeof requireAgent>) => string,
  ) {
    this.domain = new TeamV2TaskControlDomain(store)
  }

  async submitTask(
    exec: ToolExecutionAuthority,
    input: { taskId: string; expectedRevision: number; attemptId: string; output: string; evidence?: readonly string[] },
  ): Promise<TeamTask> {
    const member = requireAgent(exec)
    const scope = this.scopeOf(member)
    const membership = findFreshV2Membership(this.store, scope, member.id)
    if (membership?.role !== 'member') {
      throw new TeamDomainError('only an active Team member may submit', 'TEAM_TASK_OWNER_REQUIRED')
    }
    return await this.domain.submitTask(scope, membership.team.id, member.id, {
      taskId: TaskId(input.taskId),
      expectedTaskRevision: input.expectedRevision,
      attemptId: AttemptId(input.attemptId),
      output: input.output,
      evidence: input.evidence ?? [],
    })
  }

  async reassignTask(
    exec: ToolExecutionAuthority,
    taskId: string,
    expectedRevision: number,
    reason: string,
    targetMemberName?: string,
  ): Promise<TeamTask> {
    const captain = requireAgent(exec)
    const scope = this.scopeOf(captain)
    const membership = findFreshV2Membership(this.store, scope, captain.id)
    if (membership?.role !== 'captain') {
      throw new TeamDomainError('only the active Team captain may reassign', 'TEAM_CAPTAIN_REQUIRED')
    }
    const target = targetMemberName === undefined
      ? undefined
      : membership.team.members.find(member => member.name === targetMemberName
        && (member.phase === 'declared' || member.phase === 'active'))
    if (targetMemberName !== undefined && target === undefined) {
      throw new TeamDomainError(`Team member "${targetMemberName}" is unavailable`, 'TEAM_ASSIGNEE_INVALID')
    }
    const released = await this.domain.reassignTask(scope, membership.team.id, captain.id, {
      taskId: TaskId(taskId),
      expectedTaskRevision: expectedRevision,
      diagnostic: reason,
      ...(target === undefined ? {} : { targetMemberSessionId: target.sessionId }),
    })
    this.ctx.subagents.interrupt(SessionId(released.previousOwnerSessionId), { kind: 'ancestor', agent: captain })
    return released.task
  }
}
