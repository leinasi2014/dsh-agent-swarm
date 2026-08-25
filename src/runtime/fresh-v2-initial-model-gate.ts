import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TeamDomainError } from '../domain/error.js'
import type { StorageDomainTeamStoreV2 } from '../storage/storage-domain-team-store-v2.js'
import { currentFreshV2InitialAttempt, findFreshV2Membership } from './fresh-v2-initial-support.js'
import { ownsFreshV2ModelPermit, type FreshV2ModelPermit } from './fresh-v2-model-permit.js'
import type { FreshV2WitnessCapability } from './fresh-v2-witness-capability.js'

/** Claim only the exact initial AgentLoop request while preserving replay rejection. */
export function ownsFreshV2InitialModelDispatch(input: {
  readonly ctx: Context
  readonly store: StorageDomainTeamStoreV2
  readonly scopeOf: (agent: Agent) => string
  readonly permits: ReadonlyMap<string, FreshV2ModelPermit>
  readonly witness: FreshV2WitnessCapability
}, options: GenerateOptions): boolean {
  const hasPermit = ownsFreshV2ModelPermit(input.permits, options, 'initial dispatch')
  if (options.sessionId === undefined) return false
  const agent = input.ctx.agents.get(SessionId(options.sessionId))
  const session = input.ctx.sessions.get(SessionId(options.sessionId))
  if (agent === undefined || session === undefined || agent.session !== session) {
    if (hasPermit) throw new TeamDomainError('initial dispatch permit lost its exact Agent/Session', 'TEAM_ATTEMPT_STALE')
    return false
  }
  const membership = findFreshV2Membership(input.store, input.scopeOf(agent), agent.id)
  if (membership?.role !== 'member') {
    if (hasPermit) throw new TeamDomainError('initial dispatch permit lost Team membership', 'TEAM_ATTEMPT_STALE')
    return false
  }
  const current = currentFreshV2InitialAttempt(membership.team, agent.id)
  if (current === undefined) {
    if (hasPermit) throw new TeamDomainError('initial dispatch permit lost its exact Attempt', 'TEAM_ATTEMPT_STALE')
    return false
  }
  if (current.attempt.phase === 'running' && current.dispatch?.phase === 'settled') {
    if (hasPermit) throw new TeamDomainError('initial dispatch permit was already settled', 'TEAM_ATTEMPT_STALE')
    return false
  }
  if (current.dispatch !== undefined) input.witness.assertDigest(current.dispatch.witnessCapabilityDigest)
  const permit = input.permits.get(agent.id)
  if (permit === undefined) throw new TeamDomainError('initial dispatch permit disappeared', 'TEAM_ATTEMPT_STALE')
  if (current.attempt.phase !== 'reserved' || current.dispatch === undefined
    || (current.dispatch.phase !== 'dispatch-pending' && current.dispatch.phase !== 'dispatch-entered')) {
    throw new TeamDomainError('Team model request lacks its exact dispatch fence', 'TEAM_ATTEMPT_STALE')
  }
  if (current.dispatch.turn !== permit.turn || current.dispatch.step !== permit.step) {
    throw new TeamDomainError('Team model request does not match its official Agent Loop permit', 'TEAM_ATTEMPT_STALE')
  }
  return true
}
