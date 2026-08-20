/**
 * Replaceable Scheduler and Review Provider contracts (ADR-0001 capability
 * family): the runtime owns the registries and the protocol; these seams own
 * the policies. Third-party plugins register through `ctx.agentSwarm`.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TeamState, TeamTask, TaskAttempt } from '../domain/types.js'

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
    select: ({ readyTasks, availableMembers }) => availableMembers.flatMap((member, index) => {
      const task = readyTasks[index]
      return task === undefined ? [] : [{ taskId: task.id, memberSessionId: member.sessionId }]
    }),
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
