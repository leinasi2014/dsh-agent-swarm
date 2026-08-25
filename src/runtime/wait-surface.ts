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
): Promise<{ snapshot: TeamStatusSnapshot; changed: boolean }> {
  await deps.ensureReady()
  if (deps.isClosing()) throw new TeamDomainError('Team orchestrator is disposing', 'TEAM_RUNTIME_CLOSING')
  const actor = requireAgent(exec)
  expectDomainTimeout(timeoutMs)
  // Official parity: caller cancellation rejects before waiter registration.
  exec.signal.throwIfAborted()
  const scope = deps.scopeOf(actor)
  const membership = await deps.domain().requireReadMembership(scope, actor.id)
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  try {
    const snapshot = await deps.domain().waitForChange(
      scope,
      membership.team.id,
      actor.id,
      afterRevision,
      AbortSignal.any([exec.signal, timeoutSignal]),
    )
    // An archived Team resolves immediately even at a current cursor (it
    // can never commit a later revision), so `changed` is derived from the
    // authoritative revision, not from the wait having returned.
    return { snapshot, changed: snapshot.team.revision > afterRevision }
  } catch (error) {
    if (timeoutSignal.aborted && !exec.signal.aborted) {
      return { snapshot: await deps.domain().snapshot(scope, membership.team.id, actor.id), changed: false }
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
