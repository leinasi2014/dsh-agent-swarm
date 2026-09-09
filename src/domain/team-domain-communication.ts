import { expectDomain } from './error.js'
import { actorMembership, type TeamDomainDeps } from './team-domain-shared.js'
import type { TeamScope } from './team-domain-port.js'
import type { TeamCommunicationIntensity, TeamCommunicationPolicy, TeamId, TeamMessage, TeamState } from './types.js'

const COMMUNICATION_WINDOW_MS = 60_000
const PEER_WAKEUPS: Readonly<Record<TeamCommunicationIntensity, number>> = { quiet: 1, balanced: 4, active: 12 }

export function assertCommunicationIntensity(value: unknown): asserts value is TeamCommunicationIntensity {
  expectDomain(value === 'quiet' || value === 'balanced' || value === 'active', 'communication intensity must be quiet, balanced or active', 'TEAM_COMMUNICATION_INVALID')
}

export function communicationPolicy(team: Pick<TeamState, 'communicationIntensity'>, pluginDefault: TeamCommunicationIntensity = 'active'): TeamCommunicationPolicy {
  const intensity = team.communicationIntensity ?? pluginDefault
  return { intensity, source: team.communicationIntensity === undefined ? 'plugin' : 'team', peerWakeupsPerMinute: PEER_WAKEUPS[intensity], windowSeconds: 60 }
}

/** A retained receipt is the only window evidence; replies and Captain traffic do not spend this allowance. */
export function isRecentPeerWakeup(team: TeamState, message: TeamMessage, now: number): boolean {
  return message.delivery === 'wakeup' && message.replyExempt !== true
    && message.senderSessionId !== team.captainSessionId && message.targetSessionId !== team.captainSessionId
    && message.createdAt > now - COMMUNICATION_WINDOW_MS
}

export function peerWakeupLimited(deps: TeamDomainDeps, team: TeamState, sender: string, target: string, now: number): boolean {
  if (sender === team.captainSessionId || target === team.captainSessionId) return false
  const recent = team.messages.filter(message => isRecentPeerWakeup(team, message, now))
  // Preserve the existing receipt bound: when all available receipt slots are
  // window evidence, defer further proactive wakes rather than erase evidence.
  return recent.length >= deps.limits.maxRetainedMessages
    || recent.filter(message => message.senderSessionId === sender).length >= communicationPolicy(team, deps.communicationIntensity).peerWakeupsPerMinute
}

export async function setCommunication(
  deps: TeamDomainDeps, scope: TeamScope, teamId: TeamId, captainSessionId: string,
  expectedRevision: number, intensity: TeamCommunicationIntensity | undefined,
): Promise<TeamState> {
  if (intensity !== undefined) assertCommunicationIntensity(intensity)
  let committed!: TeamState
  await deps.store.transact(scope, teamId, team => {
    expectDomain(actorMembership(team, captainSessionId).role === 'captain', 'only the Captain may change Team communication intensity', 'TEAM_CAPTAIN_REQUIRED')
    expectDomain(Number.isSafeInteger(expectedRevision) && expectedRevision === team.revision, 'Team changed; read its current revision before adjusting communication', 'TEAM_REVISION_CONFLICT')
    if (team.communicationIntensity !== intensity) {
      if (intensity === undefined) delete (team as { communicationIntensity?: TeamCommunicationIntensity }).communicationIntensity
      else Object.assign(team, { communicationIntensity: intensity })
      Object.assign(team, { revision: team.revision + 1, updatedAt: deps.now() })
    }
    committed = team
  })
  return structuredClone(committed)
}
