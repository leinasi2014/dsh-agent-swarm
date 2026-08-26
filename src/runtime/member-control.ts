/**
 * Captain-owned member turn control (issue #19, official Lead-only keepInbox
 * interrupt parity).
 *
 * `interruptMember` cancels one member's current turn through the subagent
 * interrupt seam — which is `Agent.cancel(cause, { keepInbox: true })` —
 * without releasing task ownership, removing the roster row, cancelling
 * durable mail or draining the continuable Activation (unlike
 * `removeMember`'s fence-and-drain). The domain stays the roster authority;
 * this collaborator only resolves the target by name and performs the live
 * cancellation.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { TeamDomainError } from '../domain/error.js'
import { foldMemberName } from '../domain/team-domain-shared.js'
import type { TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import { requireAgent, type ToolExecutionAuthority } from './authority.js'

/** Collaborators the captain member-control surface needs from its runtime. */
export interface MemberControlDeps {
  readonly ctx: Context
  readonly domain: () => TeamDomainPort
  readonly isClosing: () => boolean
  readonly scopeOf: (agent: Agent) => TeamScope
  readonly ensureReady: () => Promise<void>
  /** Host clock used only for independently derived model-interrupt evidence. */
  readonly now: () => number
}

type ModelInterruptReceipt = {
  name: string
  previousStatus: 'running' | 'idle' | 'inactive'
  evidenceKind: 'host-confirmed-tool-timeout'
}
type InterruptTarget = { captain: Agent; name: string; sessionId: string }

/** Authorize and bind one active roster target; callers resolve live state after this final await. */
async function bindInterruptTarget(deps: MemberControlDeps, exec: ToolExecutionAuthority, name: string): Promise<InterruptTarget> {
  await deps.ensureReady()
  if (deps.isClosing()) throw new TeamDomainError('Team orchestrator is disposing', 'TEAM_RUNTIME_CLOSING')
  const captain = requireAgent(exec)
  const membership = await deps.domain().requireMembership(deps.scopeOf(captain), captain.id)
  if (membership.role !== 'captain') throw new TeamDomainError('only the captain can interrupt members', 'TEAM_CAPTAIN_REQUIRED')
  const normalized = foldMemberName(name)
  if (normalized === 'captain') throw new TeamDomainError('the captain cannot interrupt itself', 'TEAM_INVALID_TARGET')
  const target = membership.team.members.find(member => member.name === normalized && member.phase === 'active')
  if (target === undefined) throw new TeamDomainError(`active member "${normalized}" not found`, 'TEAM_MEMBER_NOT_FOUND')
  return { captain, name: normalized, sessionId: target.sessionId }
}

/** A tool call that is still open in the exact currently-running step. */
type LiveToolCall = Extract<SessionEvent, { type: 'tool/call' }>

function hasResultFor(call: LiveToolCall, events: readonly SessionEvent[]): boolean {
  return events.some(event => event.type === 'tool/result'
    && event.seq > call.seq
    && event.data.turn === call.data.turn
    && event.data.step === call.data.step
    && event.data.message.source.callId === call.data.callId)
}

/**
 * Find host-derived timeout evidence. This deliberately has no await: the
 * caller performs the final membership/live binding immediately before it and
 * interrupts synchronously after it succeeds.
 */
function modelTimeoutEvidence(deps: MemberControlDeps, live: Agent): boolean {
  if (live.status !== 'running') return false
  const events = live.session.events.filter(event => event.seq >= live.session.firstLiveSeq)
  let openTurn: number | undefined
  let openStep: { turn: number; step: number } | undefined

  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        openTurn = event.data.turn
        openStep = undefined
        break
      case 'step/start':
        if (openTurn === event.data.turn) openStep = { turn: event.data.turn, step: event.data.step }
        break
      case 'step/end':
        if (openStep?.turn === event.data.turn && openStep.step === event.data.step) openStep = undefined
        break
      case 'turn/end':
        if (openTurn === event.data.turn) {
          openTurn = undefined
          openStep = undefined
        }
        break
    }
  }
  if (openTurn === undefined || openStep === undefined) return false

  const now = deps.now()
  if (!Number.isSafeInteger(now)) return false
  return events.some((event): event is LiveToolCall => event.type === 'tool/call'
    && event.data.turn === openTurn
    && event.data.step === openStep.step
    && !hasResultFor(event, events)
    && Number.isSafeInteger(event.time)
    && event.time <= now
    && (() => {
      const timeoutMs = deps.ctx.tools.get(event.data.name, live)?.timeoutMs
      return typeof timeoutMs === 'number' && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && now - event.time >= timeoutMs
    })())
}

/**
 * Interrupt one member's current turn, keepInbox (official roster `interrupt`
 * parity). Caller cancellation is not admitted mid-flight: the cancellation
 * request itself is synchronous once authorized.
 * @returns the target's sampled pre-cancellation status.
 */
export async function interruptMember(
  deps: MemberControlDeps,
  exec: ToolExecutionAuthority,
  name: string,
): Promise<{ name: string; previousStatus: 'running' | 'idle' | 'inactive' }> {
  const target = await bindInterruptTarget(deps, exec, name)
  const live = deps.ctx.agents.get(SessionId(target.sessionId))
  if (live === undefined) return { name: target.name, previousStatus: 'inactive' }
  const previousStatus = live.status
  deps.ctx.subagents.interrupt(SessionId(target.sessionId), { kind: 'ancestor', agent: target.captain })
  return { name: target.name, previousStatus }
}

/**
 * Model-only interrupt admission. Unlike trusted Host/Human control, a model
 * can interrupt only when the Host can independently prove an overdue visible
 * tool call in the exact live member's current step.
 */
export async function interruptMemberFromModel(
  deps: MemberControlDeps,
  exec: ToolExecutionAuthority,
  name: string,
): Promise<ModelInterruptReceipt> {
  // bindInterruptTarget's membership await is this path's final await.
  const target = await bindInterruptTarget(deps, exec, name)
  const live = deps.ctx.agents.get(SessionId(target.sessionId))
  if (live === undefined || live.id !== SessionId(target.sessionId) || !modelTimeoutEvidence(deps, live)) {
    throw new TeamDomainError('Host-confirmed timeout evidence is required to interrupt a member', 'TEAM_INTERRUPT_EVIDENCE_REQUIRED')
  }
  const previousStatus = live.status
  deps.ctx.subagents.interrupt(SessionId(target.sessionId), { kind: 'ancestor', agent: target.captain })
  return { name: target.name, previousStatus, evidenceKind: 'host-confirmed-tool-timeout' }
}
