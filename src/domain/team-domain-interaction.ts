/** I1b Team-internal once-only mailbox effect, inside the Team aggregate. */
import { createHash } from 'node:crypto'
import { expectDomain, TeamDomainError } from './error.js'
import { queueMessageInDraft } from './team-domain-mailbox.js'
import type { TeamDomainDeps } from './team-domain-shared.js'
import type { TeamScope } from './team-domain-port.js'
import type { TeamId, TeamInteractionEffect, TeamMessage, TeamMessageDelivery } from './types.js'

export interface QueueMessageOnceInput {
  readonly requestId: string
  readonly step: 'member-question-relay-mail'
  readonly senderSessionId: string
  readonly targetName: string
  readonly content: string
  readonly delivery: TeamMessageDelivery
}

export interface QueueMessageOnceResult {
  readonly message: TeamMessage
  readonly effect: TeamInteractionEffect
  readonly replayed: boolean
}

function sha256(...parts: readonly string[]): string {
  const hash = createHash('sha256')
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8')
    const length = Buffer.allocUnsafe(4)
    length.writeUInt32BE(bytes.length, 0)
    hash.update(length)
    hash.update(bytes)
  }
  return hash.digest('hex')
}

function memberQuestionRelayEffectId(scope: TeamScope, teamId: TeamId, requestId: string, targetSessionId: string, content: string): string {
  return `i1b:${sha256('dsh-agent-swarm/i1b/member-question-relay-mail/v1', scope, teamId, requestId, targetSessionId, memberQuestionBodyDigest(content))}`
}

function memberQuestionBodyDigest(content: string): string {
  return `sha256:${sha256(content)}`
}

export async function queueMessageOnce(
  deps: TeamDomainDeps,
  scope: TeamScope,
  teamId: TeamId,
  input: QueueMessageOnceInput,
): Promise<QueueMessageOnceResult> {
  let result!: QueueMessageOnceResult
  await deps.store.transact(scope, teamId, team => {
    expectDomain(team.schemaVersion === 2 && team.interactionEffects !== undefined, 'I1b Team effect ledger is unavailable', 'TEAM_INTERACTION_EFFECT_UNAVAILABLE')
    // An exact replay is a ledger read, not a second attempt to admit the
    // current mailbox operation.  In particular, a later member phase or
    // quota change cannot turn a committed effect into a duplicate send.
    const sameRequest = team.interactionEffects.find(effect => effect.requestId === input.requestId && effect.step === input.step)
    if (sameRequest !== undefined) {
      const bodyDigest = memberQuestionBodyDigest(input.content)
      const expectedId = memberQuestionRelayEffectId(scope, teamId, input.requestId, sameRequest.targetSessionId, input.content)
      const message = team.messages.find(candidate => candidate.id === sameRequest.messageId)
      if (message === undefined || sameRequest.effectId !== expectedId || sameRequest.bodyDigest !== bodyDigest) {
        throw new TeamDomainError('interaction request already has a conflicting I1b effect binding', 'TEAM_INTERACTION_EFFECT_CONFLICT')
      }
      result = { message: structuredClone(message), effect: structuredClone(sameRequest), replayed: true }
      return
    }
    const target = input.targetName === 'captain'
      ? team.captainSessionId
      : team.members.find(member => member.name === input.targetName && member.phase === 'active')?.sessionId
    expectDomain(target !== undefined, 'I1b effect target is unavailable', 'TEAM_MESSAGE_TARGET_INVALID')
    const effectId = memberQuestionRelayEffectId(scope, teamId, input.requestId, target, input.content)
    const bodyDigest = memberQuestionBodyDigest(input.content)
    expectDomain(team.interactionEffects.length < deps.limits.maxInteractionEffects, 'I1b interaction effect capacity reached', 'TEAM_INTERACTION_EFFECT_CAPACITY')
    const message = queueMessageInDraft(deps, team, input.senderSessionId, input.targetName, input.content, input.delivery)
    const effect: TeamInteractionEffect = {
      effectId,
      requestId: input.requestId,
      step: input.step,
      targetSessionId: target,
      bodyDigest,
      messageId: message.id,
      committedAt: deps.now(),
    }
    team.interactionEffects.push(effect)
    result = { message: structuredClone(message), effect: structuredClone(effect), replayed: false }
  })
  return result
}

export function findMemberQuestionRelayEffect(
  team: { readonly interactionEffects?: readonly TeamInteractionEffect[] },
  scope: TeamScope,
  teamId: TeamId,
  requestId: string,
  targetSessionId: string,
  content: string,
): TeamInteractionEffect | undefined {
  const effectId = memberQuestionRelayEffectId(scope, teamId, requestId, targetSessionId, content)
  return team.interactionEffects?.find(effect => effect.effectId === effectId)
}
