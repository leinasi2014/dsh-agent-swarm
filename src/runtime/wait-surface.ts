/**
 * The orchestrator's tool-facing read/wait surfaces (issue #107).
 *
 * `status`, `waitForChange` and `activePeerEvidence` form one cohesive family:
 * read-only operations over `requireReadMembership` — the F14 archived-captain
 * snapshot read, the official `wait_agent` revision-wait contract (issue #19,
 * including `TEAM_WAIT_ABORTED` and timeout semantics) and the issue #15
 * no-progress short-circuit evidence. Extracted verbatim from
 * `orchestrator-runtime.ts` to retire the M3-1 size-gate exception registered
 * by issue #100's execution-root wiring: the domain stays the sole authority;
 * this collaborator only resolves the actor's scope and orchestrates the
 * membership reads. `orchestrator-runtime.ts` keeps identically-shaped thin
 * delegations, so the public surface is unchanged.
 */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { TeamStatusSnapshot } from '../domain/types.js'
import { TeamDomainError } from '../domain/error.js'
import type { TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import { expectDomainTimeout, requireAgent, type ToolExecutionAuthority } from './authority.js'

/** Collaborators the read/wait surfaces need from their runtime. */
export interface WaitSurfaceDeps {
  readonly ctx: Context
  readonly domain: () => TeamDomainPort
  readonly isClosing: () => boolean
  readonly scopeOf: (agent: Agent) => TeamScope
  readonly ensureReady: () => Promise<void>
}

/**
 * Cursor for changes that can alter coordination decisions. Raw usage and
 * persistence timestamps are deliberately excluded; budget exhaustion is
 * retained so crossing a configured limit still wakes the captain.
 */
export function coordinationCursorOf(snapshot: TeamStatusSnapshot): string {
  const { team } = snapshot
  const budget = {
    tokenLimit: team.budget.tokenLimit,
    requestLimit: team.budget.requestLimit,
    retryLimit: team.budget.retryLimit,
    deadlineAt: team.budget.deadlineAt,
    tokensExhausted: team.budget.tokenLimit !== undefined && team.budget.usedTokens >= team.budget.tokenLimit,
    requestsExhausted: team.budget.requestLimit !== undefined && team.budget.usedRequests >= team.budget.requestLimit,
    retriesExhausted: team.budget.retryLimit !== undefined && team.budget.usedRetries >= team.budget.retryLimit,
    deadlineExhausted: team.budget.deadlineAt !== undefined && Date.now() >= team.budget.deadlineAt,
  }
  const operational = {
    id: team.id, name: team.name, description: team.description,
    captainSessionId: team.captainSessionId, phase: team.phase,
    members: team.members.map(member => ({
      name: member.name, role: member.role, sessionId: member.sessionId,
      provider: member.provider, llmProvider: member.llmProvider, model: member.model,
      modelSource: member.modelSource, deniedTools: member.deniedTools,
      assignedSkills: member.assignedSkills, phase: member.phase, error: member.error,
    })),
    tasks: team.tasks.map(task => ({
      id: task.id, revision: task.revision, status: task.status,
      blockedBy: task.blockedBy, priority: task.priority,
      ownerSessionId: task.ownerSessionId, currentAttemptId: task.currentAttemptId,
      reservationTokens: task.reservationTokens,
    })),
    attempts: team.attempts.map(attempt => ({
      id: attempt.id, taskId: attempt.taskId, generation: attempt.generation,
      memberSessionId: attempt.memberSessionId, phase: attempt.phase,
      assignmentPhase: attempt.assignmentPhase, replacesAttemptId: attempt.replacesAttemptId,
    })),
    messages: team.messages.map(message => ({
      id: message.id, targetSessionId: message.targetSessionId,
      delivery: message.delivery, phase: message.phase,
    })),
    memoryIds: team.memory.map(entry => entry.id), budget,
    readyTaskIds: snapshot.readyTaskIds,
    pendingMessageIds: snapshot.pendingMessageIds,
  }
  return createHash('sha256').update(JSON.stringify(operational)).digest('hex')
}

export async function status(deps: WaitSurfaceDeps, exec: ToolExecutionAuthority): Promise<TeamStatusSnapshot> {
  await deps.ensureReady()
  if (deps.isClosing()) throw new TeamDomainError('Team orchestrator is disposing', 'TEAM_RUNTIME_CLOSING')
  const actor = requireAgent(exec)
  const scope = deps.scopeOf(actor)
  // F14 read path: reads resolve through the archived captain too, so the
  // terminal aggregate stays inspectable after archive.
  const membership = await deps.domain().requireReadMembership(scope, actor.id)
  return await deps.domain().snapshot(scope, membership.team.id, actor.id)
}

export async function waitForChange(
  deps: WaitSurfaceDeps,
  exec: ToolExecutionAuthority,
  afterRevision: number,
  timeoutMs: number,
  afterCursor?: string,
): Promise<{ snapshot: TeamStatusSnapshot; changed: boolean; coordinationCursor: string }> {
  await deps.ensureReady()
  if (deps.isClosing()) throw new TeamDomainError('Team orchestrator is disposing', 'TEAM_RUNTIME_CLOSING')
  const actor = requireAgent(exec)
  expectDomainTimeout(timeoutMs)
  // Official parity: caller cancellation rejects before waiter registration.
  exec.signal.throwIfAborted()
  const scope = deps.scopeOf(actor)
  const membership = await deps.domain().requireReadMembership(scope, actor.id)
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  if (afterCursor !== undefined) {
    let snapshot = await deps.domain().snapshot(scope, membership.team.id, actor.id)
    while (true) {
      const coordinationCursor = coordinationCursorOf(snapshot)
      if (coordinationCursor !== afterCursor) return { snapshot, changed: true, coordinationCursor }
      if (snapshot.team.phase === 'archived') return { snapshot, changed: false, coordinationCursor }
      const deadlineAt = snapshot.team.budget.deadlineAt
      const now = Date.now()
      const deadlineDelay = deadlineAt === undefined || deadlineAt <= now
        ? undefined
        : Math.min(timeoutMs, deadlineAt - now)
      const deadlineSignal = deadlineDelay === undefined ? undefined : AbortSignal.timeout(deadlineDelay)
      try {
        snapshot = await deps.domain().waitForChange(
          scope,
          membership.team.id,
          actor.id,
          snapshot.team.revision,
          AbortSignal.any([exec.signal, timeoutSignal, ...(deadlineSignal === undefined ? [] : [deadlineSignal])]),
        )
      } catch (error) {
        if (exec.signal.aborted) {
          throw new TeamDomainError(
            `agent_swarm_wait aborted: ${error instanceof Error ? error.message : String(error)}`,
            'TEAM_WAIT_ABORTED',
            { cause: error },
          )
        }
        snapshot = await deps.domain().snapshot(scope, membership.team.id, actor.id)
        const wakeCursor = coordinationCursorOf(snapshot)
        if (wakeCursor !== afterCursor) return { snapshot, changed: true, coordinationCursor: wakeCursor }
        if (timeoutSignal.aborted) return { snapshot, changed: false, coordinationCursor: wakeCursor }
        if (deadlineSignal?.aborted) continue
        throw error
      }
    }
  }
  try {
    const snapshot = await deps.domain().waitForChange(
      scope,
      membership.team.id,
      actor.id,
      afterRevision,
      AbortSignal.any([exec.signal, timeoutSignal]),
    )
    return {
      snapshot,
      changed: snapshot.team.revision > afterRevision,
      coordinationCursor: coordinationCursorOf(snapshot),
    }
  } catch (error) {
    if (timeoutSignal.aborted && !exec.signal.aborted) {
      const snapshot = await deps.domain().snapshot(scope, membership.team.id, actor.id)
      return { snapshot, changed: false, coordinationCursor: coordinationCursorOf(snapshot) }
    }
    // Issue #19, official `TEAM_WAIT_ABORTED` parity: caller cancellation
    // surfaces as one structured domain error instead of a raw abort reason.
    if (exec.signal.aborted) {
      throw new TeamDomainError(
        `agent_swarm_wait aborted: ${error instanceof Error ? error.message : String(error)}`,
        'TEAM_WAIT_ABORTED',
        { cause: error },
      )
    }
    throw error
  }
}

/**
 * Wait-progress evidence for the model-only no-progress short-circuit
 * (issue #15, official `wait_agent` parity): whether any OTHER member is
 * currently running or materializing a claimed first assignment — the peers that can produce the
 * change a wait parks for — plus the current status snapshot so the
 * short-circuit payload can answer with the authoritative cursor state.
 * Read-only; `waitForChange` itself keeps its authoritative contract.
 */
export async function activePeerEvidence(deps: WaitSurfaceDeps, exec: ToolExecutionAuthority): Promise<{ snapshot: TeamStatusSnapshot; activePeer: boolean }> {
  await deps.ensureReady()
  if (deps.isClosing()) throw new TeamDomainError('Team orchestrator is disposing', 'TEAM_RUNTIME_CLOSING')
  const actor = requireAgent(exec)
  const scope = deps.scopeOf(actor)
  const membership = await deps.domain().requireReadMembership(scope, actor.id)
  const activePeer = membership.team.members.some(member =>
    member.sessionId !== actor.id
    && ((member.phase === 'provisioning'
      && (deps.ctx.agents.get(SessionId(member.sessionId))?.status === 'running'
        || membership.team.tasks.some(task => task.ownerSessionId === member.sessionId && task.status === 'in_progress')))
      || (member.phase === 'active' && deps.ctx.agents.get(SessionId(member.sessionId))?.status === 'running')))
  const snapshot = await deps.domain().snapshot(scope, membership.team.id, actor.id)
  return { snapshot, activePeer }
}
