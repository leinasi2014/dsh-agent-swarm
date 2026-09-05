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
import { statusOf } from '../domain/team-domain-projection.js'
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
 * The wait layer's real terminal discriminant.  A timeout is identified only
 * by this call's own timeout signal; callers never infer it from Team phase.
 */
export type WaitResult =
  | { readonly outcome: 'changed'; readonly changed: true; readonly snapshot: TeamStatusSnapshot }
  | { readonly outcome: 'timed-out'; readonly changed: false; readonly snapshot: TeamStatusSnapshot }
  | { readonly outcome: 'unchanged-terminal'; readonly changed: false; readonly snapshot: TeamStatusSnapshot }

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
): Promise<WaitResult> {
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
    return snapshot.team.revision > afterRevision
      ? { outcome: 'changed', changed: true, snapshot }
      : { outcome: 'unchanged-terminal', changed: false, snapshot }
  } catch (error) {
    if (timeoutSignal.aborted && !exec.signal.aborted) {
      // Membership already supplied an authorized aggregate. A failed final
      // reread must not replace a genuine timeout with a secondary IO error.
      let snapshot: TeamStatusSnapshot
      try { snapshot = await deps.domain().snapshot(scope, membership.team.id, actor.id) }
      catch { snapshot = statusOf(membership.team) }
      return {
        outcome: 'timed-out',
        changed: false,
        snapshot,
      }
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
 * currently running or provisioning — the only peers that can produce the
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
    && (member.phase === 'provisioning'
      || (member.phase === 'active' && deps.ctx.agents.get(SessionId(member.sessionId))?.status === 'running')))
  const snapshot = await deps.domain().snapshot(scope, membership.team.id, actor.id)
  return { snapshot, activePeer }
}

/** Runtime-private, current-turn wait-fuse state. */
export interface WaitSpinEntry {
  readonly revision: number
  readonly noProgress: number
  /** Number of exact consecutive 30/60 steps already seen (0..2). */
  readonly timeoutSteps: number
}

export type WaitSpinVerdict = 'ok' | 'no-progress-repeat' | 'stalled'

export type WaitSpinObservation = WaitResult | {
  readonly outcome: 'no-progress'
  readonly changed: false
  readonly snapshot: TeamStatusSnapshot
}

const TIMEOUT_STEPS = [30_000, 60_000, 120_000] as const

/**
 * Classify a captain's wait outcome inside one Runtime and one official DSH
 * turn signal.  It has no persistent/Team-domain effect.  A fresh signal,
 * Runtime or process gets a fresh WeakMap.  Any revision inequality resets
 * the previous streak (including revision decrease); only a true timeout may
 * advance the exact 30 → 60 → 120 sequence.
 */
function applyWaitSpinFuse(
  fuse: WeakMap<AbortSignal, WaitSpinEntry>,
  exec: ToolExecutionAuthority,
  observation: WaitSpinObservation,
  timeoutMs: number,
): WaitSpinVerdict {
  const signal = exec.signal
  if (observation.changed) {
    fuse.delete(signal)
    return 'ok'
  }

  const revision = observation.snapshot.team.revision
  const existing = fuse.get(signal)
  // A revision change establishes a new local epoch.  Process the current
  // no-progress/timeout as that epoch's first observation rather than carrying
  // any predecessor count across it.
  let state: WaitSpinEntry = existing === undefined || existing.revision !== revision
    ? { revision, noProgress: 0, timeoutSteps: 0 }
    : existing

  if (observation.outcome === 'unchanged-terminal') {
    fuse.delete(signal)
    return 'ok'
  }
  if (observation.outcome === 'no-progress') {
    const noProgress = state.noProgress + 1
    if (noProgress >= 2) {
      fuse.delete(signal)
      return 'no-progress-repeat'
    }
    fuse.set(signal, { revision, noProgress, timeoutSteps: 0 })
    return 'ok'
  }
  if (observation.outcome !== 'timed-out') return 'ok'

  const expected = TIMEOUT_STEPS[state.timeoutSteps]
  if (timeoutMs !== expected) {
    // A malformed/misordered timeout cannot inherit a previous step.  A new
    // 30s call may begin a fresh sequence; any other value leaves it empty.
    state = { revision, noProgress: 0, timeoutSteps: 0 }
    if (timeoutMs !== TIMEOUT_STEPS[0]) {
      fuse.set(signal, state)
      return 'ok'
    }
  }
  const timeoutSteps = state.timeoutSteps + 1
  if (timeoutSteps === TIMEOUT_STEPS.length) {
    fuse.delete(signal)
    return 'stalled'
  }
  fuse.set(signal, { revision, noProgress: 0, timeoutSteps })
  return 'ok'
}

/** One Runtime-owned holder; its WeakMap never crosses a Runtime boundary. */
export class WaitSpinFuse {
  private readonly bySignal = new WeakMap<AbortSignal, WaitSpinEntry>()

  note(exec: ToolExecutionAuthority, observation: WaitSpinObservation, timeoutMs: number): WaitSpinVerdict {
    return applyWaitSpinFuse(this.bySignal, exec, observation, timeoutMs)
  }
}
