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
  /** Present only while ordinary mailbox retention still keeps the row. */
  readonly message?: TeamMessage
  readonly messageId: TeamMessage['id']
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

function memberQuestionRelayEffectId(scope: TeamScope, teamId: TeamId, requestId: string): string {
  return `i1b:${sha256('dsh-agent-swarm/i1b/member-question-relay-mail/identity/v1', scope, teamId, requestId, 'member-question-relay-mail')}`
}

function memberQuestionBodyDigest(content: string): string {
  return `sha256:${sha256(content)}`
}

function memberQuestionBindingDigest(senderSessionId: string, targetSessionId: string, bodyDigest: string, delivery: TeamMessageDelivery): string {
  return `sha256:${sha256('dsh-agent-swarm/i1b/member-question-relay-mail/binding/v1', senderSessionId, targetSessionId, bodyDigest, delivery)}`
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
      // This narrow step always targets the captain.  Reject a different
      // requested target without resolving current membership or quota.
      if (input.targetName !== 'captain') {
        throw new TeamDomainError('interaction request already has a conflicting I1b effect binding', 'TEAM_INTERACTION_EFFECT_CONFLICT')
      }
      const bodyDigest = memberQuestionBodyDigest(input.content)
      const expectedId = memberQuestionRelayEffectId(scope, teamId, input.requestId)
      const bindingDigest = memberQuestionBindingDigest(input.senderSessionId, sameRequest.targetSessionId, bodyDigest, input.delivery)
      const message = team.messages.find(candidate => candidate.id === sameRequest.messageId)
      if (sameRequest.effectId !== expectedId || sameRequest.bindingDigest !== bindingDigest
        || sameRequest.senderSessionId !== input.senderSessionId || sameRequest.bodyDigest !== bodyDigest
        || sameRequest.delivery !== input.delivery) {
        throw new TeamDomainError('interaction request already has a conflicting I1b effect binding', 'TEAM_INTERACTION_EFFECT_CONFLICT')
      }
      result = {
        ...(message === undefined ? {} : { message: structuredClone(message) }),
        messageId: sameRequest.messageId,
        effect: structuredClone(sameRequest),
        replayed: true,
      }
      return
    }
    const target = input.targetName === 'captain'
      ? team.captainSessionId
      : team.members.find(member => member.name === input.targetName && member.phase === 'active')?.sessionId
    expectDomain(target !== undefined, 'I1b effect target is unavailable', 'TEAM_MESSAGE_TARGET_INVALID')
    const effectId = memberQuestionRelayEffectId(scope, teamId, input.requestId)
    const bodyDigest = memberQuestionBodyDigest(input.content)
    const bindingDigest = memberQuestionBindingDigest(input.senderSessionId, target, bodyDigest, input.delivery)
    expectDomain(team.interactionEffects.length < deps.limits.maxInteractionEffects, 'I1b interaction effect capacity reached', 'TEAM_INTERACTION_EFFECT_CAPACITY')
    const message = queueMessageInDraft(deps, team, input.senderSessionId, input.targetName, input.content, input.delivery)
    const effect: TeamInteractionEffect = {
      effectId,
      requestId: input.requestId,
      step: input.step,
      bindingDigest,
      senderSessionId: input.senderSessionId,
      targetSessionId: target,
      bodyDigest,
      delivery: input.delivery,
      messageId: message.id,
      resultingTeamRevision: team.revision + 1,
      committedAt: deps.now(),
    }
    team.interactionEffects.push(effect)
    result = { message: structuredClone(message), messageId: message.id, effect: structuredClone(effect), replayed: false }
  })
  return result
}

export function findMemberQuestionRelayEffect(
  team: { readonly interactionEffects?: readonly TeamInteractionEffect[] },
  scope: TeamScope,
  teamId: TeamId,
  requestId: string,
  senderSessionId: string,
  content: string,
): TeamInteractionEffect | undefined {
  const effectId = memberQuestionRelayEffectId(scope, teamId, requestId)
  const bodyDigest = memberQuestionBodyDigest(content)
  const effect = team.interactionEffects?.find(candidate => candidate.effectId === effectId)
  if (effect === undefined) return undefined
  const bindingDigest = memberQuestionBindingDigest(senderSessionId, effect.targetSessionId, bodyDigest, 'wakeup')
  if (effect.bindingDigest !== bindingDigest || effect.senderSessionId !== senderSessionId
    || effect.bodyDigest !== bodyDigest || effect.delivery !== 'wakeup') {
    throw new TeamDomainError('I1b effect binding is corrupt or conflicts with the relay request', 'TEAM_INTERACTION_EFFECT_CONFLICT')
  }
  return effect
}
