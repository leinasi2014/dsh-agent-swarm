/**
 * Captain review transaction (extracted from the orchestrator runtime to
 * keep it under the source size gate; pure move plus the M3-2 verification
 * pass-through — issue #101).
 *
 * Semantics (docs/04 §5) are unchanged: the transaction runs ONLY inside
 * the captain's review call — a submitted task never completes itself. The
 * configured review Provider owns the decision policy (`manual`,
 * `executable`, or a third-party overlay such as the canvas human bridge);
 * a Provider that throws fails the call loudly, leaving the task
 * `submitted`, nothing settled and nothing hanging.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TeamDomainError } from '../domain/error.js'
import { validateTaskReview } from '../domain/team-domain-board.js'
import { TaskId, type AttemptId, type TeamId, type TeamTask } from '../domain/types.js'
import type { TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import type { TeamReviewProvider } from './providers.js'
import { requireAgent, workspaceOf, type ToolExecutionAuthority } from './authority.js'

/** Collaborators the review transaction needs from its runtime. */
export interface ReviewTransactionDeps {
  readonly ctx: Context
  readonly domain: () => TeamDomainPort
  readonly reviewProvider: () => TeamReviewProvider | undefined
  readonly reviewProviderName: () => string
  readonly scopeOf: (agent: Agent) => TeamScope
  readonly requestSchedule: (scope: TeamScope, teamId: TeamId, captain: Agent) => void
}

/**
 * Run one captain review: admit the exact live Captain and submitted attempt,
 * hand the task's frozen verification command list to the review Provider, then
 * commit the Provider's decision through the authoritative domain
 * transaction (revision CAS + attempt fencing).
 */
export async function runReviewTransaction(
  deps: ReviewTransactionDeps,
  exec: ToolExecutionAuthority,
  input: { taskId: string; expectedRevision: number; attemptId: string; decision: 'accept' | 'reject'; diagnostic?: string },
): Promise<{ task: TeamTask; decision: 'accept' | 'reject' }> {
  const captain = requireAgent(exec)
  const scope = deps.scopeOf(captain)
  const assertExecution = () => {
    exec.signal.throwIfAborted()
    if (deps.ctx.agents.get(captain.id) !== captain || deps.ctx.sessions.get(captain.id) !== captain.session || deps.scopeOf(captain) !== scope) {
      throw new TeamDomainError('Task review requires the exact live executing Session', 'TEAM_AGENT_REQUIRED')
    }
  }
  assertExecution()
  const membership = await deps.domain().requireMembership(scope, captain.id)
  assertExecution()
  const taskId = TaskId(input.taskId), attemptId = input.attemptId as AttemptId
  const { task: taskBefore, attempt: attemptBefore } = validateTaskReview(membership.team, captain.id, taskId, input.expectedRevision, attemptId)
  const provider = deps.reviewProvider()
  if (provider === undefined) {
    throw new TeamDomainError(`review Provider "${deps.reviewProviderName()}" is unavailable`, 'TEAM_REVIEW_PROVIDER_MISSING')
  }
  const outcome = await provider.review({
    captain,
    workspace: workspaceOf(captain),
    team: membership.team,
    task: taskBefore,
    attempt: attemptBefore,
    requestedDecision: input.decision,
    ...(input.diagnostic === undefined ? {} : { diagnostic: input.diagnostic }),
    verification: taskBefore.verification ?? [],
    signal: exec.signal,
  })
  assertExecution()
  const task = await deps.domain().reviewTask(
    scope,
    membership.team.id,
    captain.id,
    taskId,
    input.expectedRevision,
    attemptId,
    outcome.decision,
    outcome.diagnostic,
    deps.reviewProviderName(),
  )
  if (outcome.decision === 'reject') deps.requestSchedule(scope, membership.team.id, captain)
  return { task, decision: outcome.decision }
}
