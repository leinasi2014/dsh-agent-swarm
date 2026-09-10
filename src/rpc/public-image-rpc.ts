/** Authenticated v3 admission/read; attachments and Team state keep their existing owners. */
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { isAttachmentError } from '@deepseek-ai/dsh-attachment'
import { TeamDomainError } from '../domain/error.js'
import { isPublicMessageV3 } from '../domain/public-message.js'
import { publicImageBindingDigest, publicImageUploadIdentity, type StoredPublicImageContentSegment } from '../domain/public-image-message.js'
import { normalizePublicImageContent } from '../shared/public-image-content.js'
import { publicMentionIds } from '../shared/public-content.js'
import { publicAppendEligibility, publicRecipientEligibility } from '../runtime/public-lineage.js'
import type { AgentSwarmRuntime } from '../runtime/orchestrator-runtime.js'
import type { HostTargetReadService } from '../host/target-read-service.js'
import { publicChatV3AppendRequestSchema, publicChatV3HistoryRequestSchema, publicChatV3ImageRequestSchema,
  publicChatV3RequestResultRequestSchema } from './public-rpc-contract.js'
import { projectPublicMessage, publicImageMetadata } from './public-rpc-projection.js'

export async function handlePublicImageRpc(ctx: Context, runtime: AgentSwarmRuntime, targets: HostTargetReadService,
  endpoint: string, payload: unknown, signal: AbortSignal): Promise<unknown> {
  const schema = endpoint === 'v3/append' ? publicChatV3AppendRequestSchema : endpoint === 'v3/history' ? publicChatV3HistoryRequestSchema
    : endpoint === 'v3/requestResult' ? publicChatV3RequestResultRequestSchema : endpoint === 'v3/image' ? publicChatV3ImageRequestSchema : undefined
  const parsed = schema?.safeParse(payload)
  if (parsed === undefined || !parsed.success) throw new TeamDomainError('Invalid public v3 request', 'SWARM_RPC_INVALID_REQUEST')
  const request = parsed.data
  return await targets.withPublicTeam(request.target, async (scope, initial, verify) => {
    const response = (teamRevision = initial.revision) => ({ schemaVersion: 3 as const,
      binding: { rootSessionId: initial.captainSessionId, teamId: initial.id }, teamRevision, observedAt: Date.now() })
    if (endpoint === 'v3/append') {
      const input = publicChatV3AppendRequestSchema.parse(payload)
      const content = normalizePublicImageContent(input.content), sourceContent = publicImageUploadIdentity(content)
      const identity = { author: { kind: 'local-operator' as const }, requestId: input.requestId,
        ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }) }
      const digest = publicImageBindingDigest(initial.id, { ...identity, content: sourceContent })
      const result = await runtime.withPublicAdmissionFence(scope, initial.id, signal, async admissionSignal => {
        return await targets.withPublicTeam(request.target, async (freshScope, team, current) => {
          if (freshScope !== scope || team.id !== initial.id) throw new TeamDomainError('Public target changed', 'SWARM_HOST_BINDING_MISMATCH')
          const existing = team.publicChat?.messages.find(row => row.author.kind === 'local-operator' && row.requestId === input.requestId)
          if (existing !== undefined) {
            await current(); admissionSignal.throwIfAborted()
            if (existing.bindingDigest !== digest) throw new TeamDomainError('Public requestId already binds another payload', 'TEAM_PUBLIC_REQUEST_CONFLICT')
            return { ...response(team.revision), message: projectPublicMessage(existing, 3), replayed: true }
          }
          const recipients = publicMentionIds(content.filter(part => part.type !== 'image'))
          if (!await publicRecipientEligibility(ctx, scope, team, recipients, admissionSignal)) {
            throw new TeamDomainError('Public recipients require current Team identity and official lineage', 'TEAM_PUBLIC_RECIPIENT_INVALID')
          }
          await current(); admissionSignal.throwIfAborted()
          const uploads = content.filter(part => part.type === 'image')
          const attachments = ctx.get('attachments')
          if (uploads.length > 0 && attachments === undefined) throw new TeamDomainError('Image attachment service is unavailable; text remains available', 'TEAM_PUBLIC_IMAGE_UNAVAILABLE')
          let admitted: Awaited<ReturnType<NonNullable<typeof attachments>['admitPromptContent']>> = []
          try { if (uploads.length > 0) admitted = await attachments!.admitPromptContent(uploads.map(part => ({
            type: 'image', mediaType: part.mediaType, data: part.data, ...(part.name === undefined ? {} : { name: part.name }),
          }))) }
          catch (error) {
            admissionSignal.throwIfAborted()
            if (isAttachmentError(error)) {
              ctx.logger.warn(`agent-swarm: public image admission failed (${error.code}): ${String(error)}`)
              throw new TeamDomainError('Image upload was rejected by the attachment service', 'TEAM_PUBLIC_IMAGE_INVALID', { cause: error })
            }
            throw error
          }
          // Attachment storage is independently durable. A failed check leaves no Team message,
          // although unreachable content-addressed objects may remain in the official store.
          await current(); admissionSignal.throwIfAborted()
          let imageIndex = 0
          const stored: StoredPublicImageContentSegment[] = content.map((part, index) => {
            if (part.type !== 'image') return part
            const committed = admitted[imageIndex++], source = sourceContent[index]
            if (committed?.type !== 'image' || source?.type !== 'image') throw new TeamDomainError('Attachment batch was incomplete', 'TEAM_PUBLIC_IMAGE_INVALID')
            return { type: 'image', imageId: `image-${imageIndex}`, attachment: committed.attachment, source: source.source }
          })
          const committed = await runtime.domain.appendPublicMessage(scope, team.id, { ...identity, formatVersion: 3, content: stored,
            expectedCaptainSessionId: team.captainSessionId, expectedTeamRevision: team.revision })
          return { ...response(committed.teamRevision), message: projectPublicMessage(committed.message, 3), replayed: committed.replayed }
        })
      })
      runtime.kickPublicMessages(scope, initial.id)
      return result
    }
    if (endpoint === 'v3/requestResult') {
      const input = publicChatV3RequestResultRequestSchema.parse(payload)
      const message = initial.publicChat?.messages.find(row => row.author.kind === 'local-operator' && row.requestId === input.requestId)
      await verify(); signal.throwIfAborted()
      return message === undefined ? { ...response(), state: 'not-found' } : { ...response(), state: 'committed', message: projectPublicMessage(message, 3) }
    }
    if (endpoint === 'v3/image') {
      const input = publicChatV3ImageRequestSchema.parse(payload)
      const find = (team: typeof initial) => {
        const message = team.publicChat?.messages.find(row => row.id === input.messageId)
        return message !== undefined && isPublicMessageV3(message) ? message.content.find(part => part.type === 'image' && part.imageId === input.imageId) : undefined
      }
      const part = find(initial), attachments = ctx.get('attachments')
      if (part?.type !== 'image') throw new TeamDomainError('Image does not belong to this public message', 'TEAM_PUBLIC_IMAGE_NOT_FOUND')
      if (attachments === undefined) throw new TeamDomainError('Image attachment service is unavailable', 'TEAM_PUBLIC_IMAGE_UNAVAILABLE')
      let image: Awaited<ReturnType<typeof attachments.readImage>>
      try { image = await attachments.readImage(part.attachment, signal) }
      catch (error) { signal.throwIfAborted(); throw new TeamDomainError('Public image cannot be read', 'TEAM_PUBLIC_IMAGE_UNAVAILABLE', { cause: error }) }
      await verify(); signal.throwIfAborted()
      const latest = (await runtime.listTeamAggregates(scope)).find(team => team.id === initial.id)
      if (latest === undefined || !isDeepStrictEqual(find(latest), part) || !isDeepStrictEqual(image.ref, part.attachment)) {
        throw new TeamDomainError('Public image binding changed', 'SWARM_HOST_BINDING_MISMATCH')
      }
      await verify(); signal.throwIfAborted()
      return { ...response(), messageId: input.messageId, imageId: input.imageId,
        image: { ...publicImageMetadata(image.ref), data: Buffer.from(image.data).toString('base64') } }
    }
    const input = publicChatV3HistoryRequestSchema.parse(payload), messages = initial.publicChat?.messages ?? []
    const eligible = messages.filter(row => (input.beforeSequence === undefined || row.sequence < input.beforeSequence)
      && (input.afterSequence === undefined || row.sequence > input.afterSequence))
    const entries = (input.afterSequence === undefined ? eligible.slice(-input.limit) : eligible.slice(0, input.limit)).map(row => projectPublicMessage(row, 3))
    const first = entries[0]?.sequence, last = entries.at(-1)?.sequence
    const appendEligibility = await publicAppendEligibility(ctx, scope, initial, signal)
    const attachments = ctx.get('attachments')
    await verify(); signal.throwIfAborted()
    return { ...response(), entries, appendEligibility, totalCount: messages.length, returnedCount: entries.length, limit: input.limit,
      hasEarlier: first === undefined ? messages.some(row => row.sequence < (input.beforeSequence ?? 0)) : messages.some(row => row.sequence < first),
      hasMore: last === undefined ? messages.some(row => row.sequence > (input.afterSequence ?? Number.MAX_SAFE_INTEGER)) : messages.some(row => row.sequence > last),
      ...(first === undefined ? {} : { firstSequence: first, lastSequence: last }),
      limits: { maxTextBytes: runtime.config.limits.maxPublicTextBytes, maxMessages: runtime.config.limits.maxPublicMessages,
        maxBytes: runtime.config.limits.maxPublicBytes, maxSegments: runtime.config.limits.maxPublicSegments },
      imageAvailability: attachments === undefined ? { state: 'unavailable', reason: 'attachment-service-unavailable' }
        : { state: 'available', imageLimits: { ...attachments.imageLimits, mediaTypes: [...attachments.imageLimits.mediaTypes] } } }
  })
}
