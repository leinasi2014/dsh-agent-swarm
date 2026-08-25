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
      const decisions: SchedulerDecision[] = []
      const remainingMembers = new Map(availableMembers.map(member => [member.sessionId, member]))
      const remainingTasks = new Set(readyTasks.map(task => task.id))

      // Strict assignments go first so generic work cannot occupy a named
      // member while their targeted task is ready.
      for (const task of readyTasks) {
        if (task.targetMemberSessionId === undefined || !remainingTasks.has(task.id)) continue
        const member = remainingMembers.get(task.targetMemberSessionId)
        if (member === undefined) continue
        decisions.push({ taskId: task.id, memberSessionId: member.sessionId })
        remainingMembers.delete(member.sessionId)
        remainingTasks.delete(task.id)
      }
      for (const task of readyTasks) {
        if (!remainingTasks.has(task.id) || task.targetMemberSessionId !== undefined) continue
        const member = remainingMembers.values().next().value as TeamState['members'][number] | undefined
        if (member === undefined) break
        decisions.push({ taskId: task.id, memberSessionId: member.sessionId })
        remainingMembers.delete(member.sessionId)
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
