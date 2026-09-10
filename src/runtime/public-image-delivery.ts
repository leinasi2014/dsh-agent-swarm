/** Read-only image capability, integrity and full-input witnesses used by the existing delivery owner. */
import { isDeepStrictEqual } from 'node:util'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, SessionLogOffset, foldRequestHeader } from '@deepseek-ai/dsh-session'
import { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { steerHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { TeamDomainError } from '../domain/error.js'
import type { TeamPublicMessageV3 } from '../domain/public-message.js'
import type { PublicImageRecipient, PublicInputProjection } from '../domain/public-image-message.js'
import type { TeamState } from '../domain/types.js'
import { framePredicate, type FramePredicates } from './frame-visibility.js'
import { readPersistedSession } from './persisted-session.js'

export function publicInputPredicates(frame: string, requestId: string, projection: PublicInputProjection | undefined,
  onMismatch?: () => void): FramePredicates {
  const framed = framePredicate(frame)
  return { identity: message => framed(message) || (message.source?.kind === 'user'
    && 'rpcId' in message.source && message.source.rpcId === requestId),
  complete: message => projection !== undefined && isDeepStrictEqual(message.source, projection.source)
    && isDeepStrictEqual(message.content, projection.content), ...(onMismatch === undefined ? {} : { onMismatch }) }
}

/** The official current model selection/continuation descriptor is evidence; a name or route guess is not. */
export async function publicRecipientImageCapability(ctx: Context, scope: string, team: TeamState, recipientId: string,
  signal: AbortSignal): Promise<'supported' | 'unsupported' | 'unknown'> {
  try {
    const live = ctx.agents.get(SessionId(recipientId))
    if (live !== undefined && ctx.sessions.get(live.id) !== live.session) return 'unknown'
    const stored = live === undefined ? await readPersistedSession(ctx.sessionPersistence, SessionId(recipientId), signal)
      : { meta: live.session.header, events: live.session.snapshotEvents(), inheritedEventCount: live.session.inheritedEventCount }
    if (stored.meta.id !== recipientId || stored.meta.cwd === undefined || resolve(stored.meta.cwd) !== scope
      || (recipientId !== team.captainSessionId && stored.meta.parentSession !== team.captainSessionId)) return 'unknown'
    const own = stored.events.slice(stored.inheritedEventCount), descriptor = foldSubagentDescriptor(own)
    const route = own.some(event => event.type === 'model/selection')
      ? ctx.get('sessionProjections')?.restore({}, stored.events, SessionLogOffset(0), stored.meta, stored.inheritedEventCount).snapshot.values.modelSelection?.next
      : live?.options.provider !== undefined && live.options.model !== undefined ? { provider: live.options.provider, model: live.options.model }
        : foldRequestHeader(own)?.config ?? (descriptor?.mode === 'continuable' && descriptor.agentProvider !== undefined && descriptor.agentModel !== undefined
          ? { provider: descriptor.agentProvider, model: descriptor.agentModel } : undefined)
    if (route === undefined || route === null || ctx.get('llm') === undefined) return 'unknown'
    const info = await ctx.llm.resolveModelInfo(route.provider, route.model, signal)
    signal.throwIfAborted()
    if (live !== undefined && (ctx.agents.get(live.id) !== live || ctx.sessions.get(live.id) !== live.session)) return 'unknown'
    return info.inputModalities === undefined ? 'unknown' : info.inputModalities.includes('image') ? 'supported' : 'unsupported'
  } catch { signal.throwIfAborted(); return 'unknown' }
}

/** Verify the original normalized objects, without re-admission or another lossy encoding. */
export async function verifyPublicImageReferences(ctx: Context, message: TeamPublicMessageV3, signal: AbortSignal): Promise<void> {
  const images = message.content.filter(part => part.type === 'image')
  if (images.length === 0) return
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new TeamDomainError('Image attachment service unavailable', 'TEAM_PUBLIC_IMAGE_UNAVAILABLE')
  for (const image of images) {
    const read = await attachments.readImage(image.attachment, signal)
    signal.throwIfAborted()
    if (!isDeepStrictEqual(read.ref, image.attachment)) throw new TeamDomainError('Image reference changed during read', 'TEAM_PUBLIC_IMAGE_UNAVAILABLE')
  }
}

export function samePublicImageInput(left: PublicImageRecipient, right: PublicImageRecipient): boolean {
  return left.frame === right.frame && left.parentSessionId === right.parentSessionId
    && left.recipientSessionId === right.recipientSessionId && isDeepStrictEqual(left.projection, right.projection)
}

/** Hold the actual target while checking its current route immediately before official admission. */
export async function steerVerifiedPublicImagePrompt(ctx: Context, scope: string, team: TeamState, parent: Agent,
  recipient: PublicImageRecipient & { projection: PublicInputProjection }, signal: AbortSignal,
  expiresAt?: number): Promise<'admitted' | 'unknown' | 'unsupported' | 'expired'> {
  return await ctx.subagents.withContinuableChild(parent, SessionId(recipient.recipientSessionId), signal, async (target, leaseSignal) => {
    const routeWitness = () => {
      const events = target.session.snapshotEvents(), own = events.slice(target.session.inheritedEventCount)
      return own.some(event => event.type === 'model/selection')
        ? ctx.get('sessionProjections')?.restore({}, events, SessionLogOffset(0), target.session.header, target.session.inheritedEventCount).snapshot.values.modelSelection?.next
        : target.options.provider === undefined || target.options.model === undefined ? undefined
          : { provider: target.options.provider, model: target.options.model }
    }
    const current = () => ctx.agents.get(target.id) === target && ctx.sessions.get(target.id) === target.session
      && ctx.agents.get(parent.id) === parent && ctx.sessions.get(parent.id) === parent.session
      && target.session.header.parentSession === parent.id && target.session.header.cwd !== undefined
      && resolve(target.session.header.cwd) === scope && parent.id === recipient.parentSessionId
      && (target.id === team.captainSessionId || parent.id === team.captainSessionId)
    const route = routeWitness()
    if (!current() || route === undefined || route === null) return 'unknown'
    const info = await ctx.llm.resolveModelInfo(route.provider, route.model, leaseSignal)
    leaseSignal.throwIfAborted()
    if (expiresAt !== undefined && Date.now() >= expiresAt) return 'expired'
    if (!current() || !isDeepStrictEqual(route, routeWitness()) || info.inputModalities === undefined) return 'unknown'
    if (!info.inputModalities.includes('image')) return 'unsupported'
    await steerHostSubagentPrompt(ctx.subagents, parent, target.id, recipient.projection.content, recipient.projection.source, leaseSignal)
    return 'admitted'
  })
}
