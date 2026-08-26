/**
 * Replaceable Scheduler and Review Provider contracts (ADR-0001 capability
 * family): the runtime owns the registries and the protocol; these seams own
 * the policies. Third-party plugins register through `ctx.agentSwarm`.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ReviewVerificationCommand, TeamState, TeamTask, TaskAttempt } from '../domain/types.js'

export interface SchedulerSelectionInput {
  readonly team: TeamState
  readonly readyTasks: readonly TeamTask[]
  readonly availableMembers: readonly TeamState['members'][number][]
}

export interface SchedulerDecision {
  readonly taskId: string
  readonly memberSessionId: string
}

export interface TeamSchedulerProvider {
  select(input: SchedulerSelectionInput): readonly SchedulerDecision[] | Promise<readonly SchedulerDecision[]>
}

export interface ReviewProviderInput {
  readonly captain: Agent
  readonly workspace: string
  readonly team: TeamState
  readonly task: TeamTask
  readonly attempt: TaskAttempt
  readonly requestedDecision: 'accept' | 'reject'
  readonly diagnostic?: string
  /**
   * The task's captain-declared verification commands (M3-2, issue #101),
   * resolved from frozen task metadata — never from the review call. Empty
   * when the task declares none; executable Providers decide their own
   * vacuous-policy. Structural additions only: the canvas human bridge's
   * subset projection stays compatible.
   */
  readonly verification: readonly ReviewVerificationCommand[]
  readonly signal: AbortSignal
}

export interface ReviewProviderResult {
  readonly decision: 'accept' | 'reject'
  readonly diagnostic?: string
}

export interface TeamReviewProvider {
  review(input: ReviewProviderInput): ReviewProviderResult | Promise<ReviewProviderResult>
}

/**
 * Builtin `priority-ready` scheduler: pair the longest-waiting available
 * member with the highest-priority ready task, one task per member.
 */
export function priorityReadyScheduler(): TeamSchedulerProvider {
  return {
    select: ({ readyTasks, availableMembers }) => {
      const available = new Map(availableMembers.map(member => [member.sessionId, member]))
      const decisions: SchedulerDecision[] = []
      for (const task of readyTasks) {
        if (task.targetMemberSessionId === undefined) continue
        if (available.delete(task.targetMemberSessionId)) decisions.push({ taskId: task.id, memberSessionId: task.targetMemberSessionId })
      }
      const generic = readyTasks.filter(task => task.targetMemberSessionId === undefined)
      for (const [index, member] of available.values().entries()) {
        const task = generic[index]
        if (task !== undefined) decisions.push({ taskId: task.id, memberSessionId: member.sessionId })
      }
      return decisions
    },
  }
}

/** Builtin `manual` review: the captain's requested decision is final. */
export function manualReview(): TeamReviewProvider {
  return {
    review: input => ({
      decision: input.requestedDecision,
      ...(input.diagnostic === undefined ? {} : { diagnostic: input.diagnostic }),
    }),
  }
}
