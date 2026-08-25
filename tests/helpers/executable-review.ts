/** Shared real-composition helpers for executable-review family tests. */
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as AgentSwarm from '../../src/index.js'
import { mountStorageStackOn } from './storage-stack.js'
import { GatedAdapter, toolCall } from './gated-composition.js'

export interface ExecutableReviewComposition {
  readonly ctx: Context
  readonly fibers: Fiber[]
  readonly lead: Agent
  readonly teamId: string
  readonly scope: string
}

export interface DeclaredVerificationCommand {
  readonly command?: string
  readonly template?: string
  readonly parameters?: readonly { readonly name: string; readonly value: string }[]
  readonly timeout_ms?: number
}

/** Real composition with the `executable` review Provider mounted. */
export async function mountExecutableReview(
  sandbox: string,
  pluginOptions: { reviewRootProvider?: string } = {},
): Promise<ExecutableReviewComposition> {
  const ctx = new Context()
  const fibers: Fiber[] = []
  const adapter = new GatedAdapter()
  await mountAgentLoopTestDependencies(ctx)
  fibers.push(await ctx.plugin(SqliteSessionPersistence, { path: join(sandbox, 'sessions', 'sessions.db') }))
  await mountStorageStackOn(ctx, join(sandbox, 'storage'))
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
  fibers.push(await ctx.plugin(SubagentService))
  fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
  fibers.push(await ctx.plugin(AgentSwarm, {
    memberProvider: 'spawn',
    memberMaxDepth: 1,
    lazyMemberStart: false,
    schedulerProvider: 'priority-ready',
    reviewProvider: 'executable',
    ...(pluginOptions.reviewRootProvider === undefined ? {} : { reviewRootProvider: pluginOptions.reviewRootProvider }),
  }))
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = ctx.agentLoop.create(
    SessionId(`exec-review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    { provider: 'mock', model: 'mock' },
    { cwd: join(sandbox, 'workspace') },
  )
  const created = await toolCall(ctx, lead, 'create', 'agent_swarm_create', {
    name: 'Executable review team',
    description: 'Prove the executable review and verification-root fault family.',
  })
  if (created.isError) throw new Error(`create failed: ${JSON.stringify(created.error)}`)
  const teamId = (created.value as { team_id: string }).team_id
  return { ctx, fibers, lead, teamId, scope: ctx.agentSwarm.scopeOf(lead) }
}

export async function executableReviewSnapshot(composition: ExecutableReviewComposition) {
  return await composition.ctx.agentSwarm.domain.snapshot(
    composition.scope, AgentSwarm.TeamId(composition.teamId), composition.lead.id,
  )
}

/** Create a task carrying a frozen verification command list. */
export async function createVerificationTask(
  composition: ExecutableReviewComposition,
  verification: readonly DeclaredVerificationCommand[],
): Promise<{ taskId: string; revision: number }> {
  const result = await toolCall(composition.ctx, composition.lead, `task-${Date.now()}`, 'agent_swarm_create_task', {
    subject: 'Executable verification target',
    description: 'Settlement depends on the captain-declared verification commands.',
    verification,
  })
  if (result.isError) throw new Error(`create_task failed: ${JSON.stringify(result.error)}`)
  const value = result.value as { task_id: string; revision: number }
  return { taskId: value.task_id, revision: value.revision }
}

/** The captain acts as the claiming worker: claim, then submit output. */
export async function claimAndSubmit(
  composition: ExecutableReviewComposition,
  taskId: string,
  revision: number,
  output: string,
): Promise<{ attemptId: string; submittedRevision: number }> {
  const claim = await toolCall(composition.ctx, composition.lead, `claim-${Date.now()}`, 'agent_swarm_claim_task', {
    task_id: taskId,
    expected_revision: revision,
  })
  if (claim.isError) throw new Error(`claim failed: ${JSON.stringify(claim.error)}`)
  const claimed = claim.value as { attempt_id: string; revision: number }
  const snapshot = await composition.ctx.agentSwarm.domain.snapshot(
    composition.scope, AgentSwarm.TeamId(composition.teamId), composition.lead.id,
  )
  const task = snapshot.team.tasks.find(candidate => candidate.id === taskId)
  if (task === undefined) throw new Error(`claimed task ${taskId} disappeared`)
  await composition.ctx.agentSwarm.domain.acknowledgeAssignment(
    composition.scope, snapshot.team.id, task.id, AgentSwarm.AttemptId(claimed.attempt_id),
  )
  const submit = await toolCall(composition.ctx, composition.lead, `submit-${Date.now()}`, 'agent_swarm_submit_task', {
    task_id: taskId,
    expected_revision: claimed.revision,
    attempt_id: claimed.attempt_id,
    output,
  })
  if (submit.isError) throw new Error(`submit failed: ${JSON.stringify(submit.error)}`)
  const submitted = submit.value as { revision: number }
  return { attemptId: claimed.attempt_id, submittedRevision: submitted.revision }
}

export async function reviewExecutableTask(
  composition: ExecutableReviewComposition,
  attemptId: string,
  submittedRevision: number,
  taskId: string,
  decision: 'accept' | 'reject',
) {
  return await toolCall(composition.ctx, composition.lead, `review-${Date.now()}`, 'agent_swarm_review_task', {
    task_id: taskId,
    expected_revision: submittedRevision,
    attempt_id: attemptId,
    decision,
  })
}

export function attemptIn(
  snapshot: Awaited<ReturnType<typeof executableReviewSnapshot>>,
  attemptId: string,
) {
  return snapshot.team.attempts.find(attempt => attempt.id === attemptId)
}
