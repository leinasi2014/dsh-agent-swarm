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
}

/** Model-side emergency control only opens after one host-observed long-running tool call. */
const MODEL_RUNAWAY_TOOL_MIN_AGE_MS = 10 * 60_000

export interface RunawayToolEvidence {
  readonly callId: string
  readonly toolName: string
  readonly ageMs: number
}

export interface ModelInterruptAdmission {
  readonly source: 'model'
  /** Test seam; production callers omit both overrides. */
  readonly now?: number
  readonly minAgeMs?: number
}

/**
 * Derive runaway evidence from the target's current turn, never from model
 * prose. Only an unmatched tool/call older than the safety threshold counts.
 */
export function confirmedRunawayTool(
  events: readonly SessionEvent[],
  now: number = Date.now(),
  minAgeMs: number = MODEL_RUNAWAY_TOOL_MIN_AGE_MS,
): RunawayToolEvidence | undefined {
  let turnStart = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'turn/start') {
      turnStart = index
      break
    }
  }
  if (turnStart < 0) return undefined
  const startEvent = events[turnStart]
  if (startEvent?.type !== 'turn/start') return undefined
  const turn = startEvent.data.turn
  if (events.slice(turnStart + 1).some(event => event.type === 'turn/end' && event.data.turn === turn)) return undefined

  const pending = new Map<string, Extract<SessionEvent, { type: 'tool/call' }>>()
  for (const event of events.slice(turnStart + 1)) {
    if (event.type === 'tool/call' && event.data.turn === turn) pending.set(event.data.callId, event)
    if (event.type === 'tool/result' && event.data.turn === turn) pending.delete(event.data.message.source.callId)
  }
  const candidate = [...pending.values()].toSorted((left, right) => left.time - right.time)[0]
  if (candidate === undefined) return undefined
  const ageMs = Math.max(0, now - candidate.time)
  if (ageMs < minAgeMs) return undefined
  return { callId: candidate.data.callId, toolName: candidate.data.name, ageMs }
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
  admission?: ModelInterruptAdmission,
): Promise<{ name: string; previousStatus: 'running' | 'idle' | 'inactive'; evidence?: RunawayToolEvidence }> {
  await deps.ensureReady()
  if (deps.isClosing()) throw new TeamDomainError('Team orchestrator is disposing', 'TEAM_RUNTIME_CLOSING')
  const captain = requireAgent(exec)
  const scope = deps.scopeOf(captain)
  const membership = await deps.domain().requireMembership(scope, captain.id)
  if (membership.role !== 'captain') {
    throw new TeamDomainError('only the captain can interrupt members', 'TEAM_CAPTAIN_REQUIRED')
  }
  const normalizedName = foldMemberName(name)
  if (normalizedName === 'captain') {
    throw new TeamDomainError('the captain cannot interrupt itself', 'TEAM_INVALID_TARGET')
  }
  const target = membership.team.members.find(member => member.name === normalizedName && member.phase === 'active')
  if (target === undefined) {
    throw new TeamDomainError(`active member "${normalizedName}" not found`, 'TEAM_MEMBER_NOT_FOUND')
  }
  const live = deps.ctx.agents.get(SessionId(target.sessionId))
  if (admission?.source === 'model') {
    if (live === undefined || live.status !== 'running') {
      throw new TeamDomainError(
        `member "${normalizedName}" has no host-confirmed long-running tool call; use wakeup plus wait, or authenticated Human Control`,
        'TEAM_INTERRUPT_EVIDENCE_REQUIRED',
      )
    }
    const evidence = confirmedRunawayTool(live.session.events, admission.now, admission.minAgeMs)
    if (evidence === undefined) {
      throw new TeamDomainError(
        `member "${normalizedName}" has no host-confirmed long-running tool call; use wakeup plus wait, or authenticated Human Control`,
        'TEAM_INTERRUPT_EVIDENCE_REQUIRED',
      )
    }
    deps.ctx.subagents.interrupt(SessionId(target.sessionId), { kind: 'ancestor', agent: captain })
    return { name: normalizedName, previousStatus: live.status, evidence }
  }
  if (live === undefined) return { name: normalizedName, previousStatus: 'inactive' }
  const previousStatus = live.status
  deps.ctx.subagents.interrupt(SessionId(target.sessionId), { kind: 'ancestor', agent: captain })
  return { name: normalizedName, previousStatus }
}
