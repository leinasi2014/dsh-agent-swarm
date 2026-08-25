import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { TeamDomainError } from '../domain/error.js'

export interface FreshV2ModelPermit {
  readonly signal: AbortSignal
  readonly turn: number
  readonly step: number
}

/** True only for the exact pending AgentLoop permit; any competing signal fails closed. */
export function ownsFreshV2ModelPermit(
  permits: ReadonlyMap<string, FreshV2ModelPermit>,
  retiredSignals: WeakSet<AbortSignal>,
  options: GenerateOptions,
  label: string,
): boolean {
  if (options.signal !== undefined && retiredSignals.has(options.signal)) {
    throw new TeamDomainError(`AgentLoop request reused a retired ${label} permit`, 'TEAM_ATTEMPT_STALE')
  }
  if (options.sessionId === undefined) return false
  const permit = permits.get(options.sessionId)
  if (permit === undefined) return false
  if (options.signal !== permit.signal) {
    throw new TeamDomainError(`AgentLoop request conflicts with its ${label} permit`, 'TEAM_ATTEMPT_STALE')
  }
  return true
}

/** Retire a pending permit without allowing its late exact signal to fall through. */
export function retireFreshV2ModelPermit(
  permits: Map<string, FreshV2ModelPermit>,
  retiredSignals: WeakSet<AbortSignal>,
  sessionId: string | undefined,
): void {
  if (sessionId === undefined) return
  const permit = permits.get(sessionId)
  if (permit === undefined) return
  permits.delete(sessionId)
  retiredSignals.add(permit.signal)
}

/** Consume one exact AgentLoop permit and resolve its identical live Agent/Session pair. */
export function consumeFreshV2ModelPermit(
  ctx: Context,
  permits: Map<string, FreshV2ModelPermit>,
  options: GenerateOptions,
  label: string,
): { agent: Agent; session: Session; permit: FreshV2ModelPermit } {
  if (options.sessionId === undefined) throw new TeamDomainError('AgentLoop request lacks Session identity', 'TEAM_STATE_CORRUPT')
  const permit = permits.get(options.sessionId)
  if (permit === undefined || options.signal !== permit.signal) {
    throw new TeamDomainError(`AgentLoop request lacks its exact ${label} permit`, 'TEAM_ATTEMPT_STALE')
  }
  permits.delete(options.sessionId)
  const agent = ctx.agents.get(SessionId(options.sessionId))
  const session = ctx.sessions.get(SessionId(options.sessionId))
  if (agent === undefined || session === undefined || agent.session !== session) {
    throw new TeamDomainError(`${label} request lost its exact live Agent/Session`, 'TEAM_STATE_CORRUPT')
  }
  return { agent, session, permit }
}
