/** Visual requests and linked result delivery commit in the existing Team transaction. */
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { expectDomain } from './error.js'
import { actorMembership, nonEmpty, type TeamDomainDeps } from './team-domain-shared.js'
import type { TeamScope } from './team-domain-port.js'
import type { TeamId, TeamState } from './types.js'
import { freezeAuthor } from './team-domain-public.js'
import { isPublicMessageV3, publicDeliveries, publicChatReservedBytes, publicChatReservedMessageCount, publicManagedParent,
  PUBLIC_REQUEST_ID_PATTERN, type TeamPublicMessageV3 } from './public-message.js'
import { publicImageBindingDigest, publicImageProjection, publicMessageFrameV3, type StoredPublicImageContentSegment, type StoredPublicImageSegment } from './public-image-message.js'
import { publicVisualAssistanceOutcomeSchema, type PublicVisualAssistance } from '../shared/public-image-content.js'
import { VISUAL_ASSISTANCE_TTL_MS, visualRequestDigest, visualCompletionDigest, type VisualAssistance, type RequestVisualAssistanceInput,
  type CompleteVisualAssistanceInput, type VisualAssistanceResult } from './visual-assistance.js'

export const assistanceRows = (team: TeamState): VisualAssistance[] => team.publicChat?.schemaVersion === 3 ? team.publicChat.assistances ?? [] : []
const receipt = (value: string) => expectDomain(PUBLIC_REQUEST_ID_PATTERN.test(value), 'Invalid assistance request identity', 'TEAM_INPUT_INVALID')

export function normalizeAssistanceRequest(input: RequestVisualAssistanceInput): RequestVisualAssistanceInput {
  receipt(input.requestId)
  expectDomain(input.imageIds.length > 0 && input.imageIds.length <= 256 && new Set(input.imageIds).size === input.imageIds.length,
    'Select a nonempty unique image set', 'TEAM_INPUT_INVALID')
  return { ...input, imageIds: input.imageIds.toSorted(), question: nonEmpty(input.question, 'Visual question', 8192) }
}

export function findAssistanceRequest(team: TeamState, actor: string, raw: RequestVisualAssistanceInput): VisualAssistance | undefined {
  const input = normalizeAssistanceRequest(raw), expected = visualRequestDigest(input)
  const row = assistanceRows(team).find(item => item.requesterSessionId === actor && item.requests.some(entry => entry.requestId === input.requestId))
  if (row !== undefined) expectDomain(row.requests.some(item => item.requestId === input.requestId && item.digest === expected),
    'Assistance request identity already binds another payload', 'TEAM_VISUAL_REQUEST_CONFLICT')
  return row
}

export function findInflightVisualAssistance(team: TeamState, actor: string, input: RequestVisualAssistanceInput, now: number): VisualAssistance | undefined {
  return assistanceRows(team).find(row => row.result === undefined && row.expiresAt > now
    && row.sourceMessageId === input.sourceMessageId && row.requesterSessionId === actor && isDeepStrictEqual(row.imageIds, input.imageIds))
}

function sourceImages(team: TeamState, actor: string, input: RequestVisualAssistanceInput) {
  actorMembership(team, actor)
  const source = team.publicChat?.messages.find(row => row.id === input.sourceMessageId)
  expectDomain(source !== undefined && isPublicMessageV3(source) && source.assistance === undefined
    && publicDeliveries(source).some(row => row.recipientSessionId === actor && row.state !== 'not-delivered'),
  'Only an original recipient can request visual assistance', 'TEAM_VISUAL_PERMISSION_REVOKED')
  if (source === undefined || !isPublicMessageV3(source)) throw new Error('Validated public source missing')
  const images = source.content.filter((part): part is StoredPublicImageSegment => part.type === 'image' && input.imageIds.includes(part.imageId))
  expectDomain(images.length === input.imageIds.length, 'Original image is unavailable', 'TEAM_VISUAL_IMAGE_UNAVAILABLE')
  return images
}

/** No arbitrary refs enter this boundary: selection is resolved from the canonical source again. */
export function validateAssistanceRequest(team: TeamState, actor: string, input: RequestVisualAssistanceInput): void {
  sourceImages(team, actor, input)
  expectDomain(input.helperSessionId !== actor && (input.helperSessionId === team.captainSessionId
    || team.members.some(row => row.sessionId === input.helperSessionId && row.phase === 'active')),
  'No available visual helper matches that member', 'TEAM_VISUAL_HELPER_UNAVAILABLE')
  expectDomain(!assistanceRows(team).some(row => row.helperSessionId === actor && row.sourceMessageId === input.sourceMessageId
    && row.imageIds.some(id => input.imageIds.includes(id))), 'A visual helper cannot delegate this collaboration again', 'TEAM_VISUAL_CHAIN_FORBIDDEN')
}

function appendLinkedMessage(team: TeamState, row: VisualAssistance, kind: 'request' | 'result'): void {
  const request = kind === 'request', actor = request ? row.requesterSessionId : row.helperSessionId
  const images = request ? sourceImages(team, row.requesterSessionId, { requestId: row.requests[0]!.requestId, sourceMessageId: row.sourceMessageId,
    imageIds: row.imageIds, helperSessionId: row.helperSessionId, question: row.question }) : []
  const previous = request ? undefined : team.publicChat?.messages.find(message => message.id === row.requestMessageId)
  // The row keeps a sorted dedup set. Public links preserve actual source block order,
  // including the result after a requester has been removed or its Team archived.
  const imageIds = request ? images.map(image => image.imageId)
    : previous !== undefined && isPublicMessageV3(previous) && previous.assistance?.kind === 'request' ? previous.assistance.imageIds : undefined
  expectDomain(imageIds !== undefined, 'Visual request image mapping is missing', 'TEAM_STATE_CORRUPT')
  const content: StoredPublicImageContentSegment[] = request ? [{ type: 'text', text: row.question },
    ...images.map((image, index) => ({ ...structuredClone(image), imageId: `image-${index + 1}` }))]
    : [{ type: 'text', text: row.result!.outcome.state === 'completed' ? row.result!.outcome.summary.trim()
      : `Visual assistance failed: ${row.result!.outcome.reason}.` }]
  const base = { assistanceId: row.assistanceId, sourceMessageId: row.sourceMessageId, imageIds,
    requesterSessionId: row.requesterSessionId, helperSessionId: row.helperSessionId, expiresAt: row.expiresAt }
  const assistance: PublicVisualAssistance = request ? { ...base, kind: 'request' }
    : { ...base, kind: 'result', resultId: row.resultId, outcome: row.result!.outcome }
  const body = { id: request ? row.requestMessageId : row.resultId, sequence: (team.publicChat?.messages.length ?? 0) + 1,
    createdAt: request ? row.createdAt : row.result!.completedAt, author: !request && row.result!.origin === 'host'
      ? { kind: 'system' as const } : freezeAuthor(team, { kind: 'agent', sessionId: actor }),
    text: content[0]!.type === 'text' ? content[0]!.text : '', replyTo: row.sourceMessageId,
    requestId: `${row.assistanceId}:${kind}`, formatVersion: 3 as const, content, mentionLabels: [], assistance }
  const recipientSessionId = request ? row.helperSessionId : row.requesterSessionId
  const recipient = { state: 'queued' as const, recipientSessionId, parentSessionId: recipientSessionId === team.captainSessionId
    ? publicManagedParent(team.managedOrigin)! : team.captainSessionId, frameVersion: 3 as const,
    frame: publicMessageFrameV3(team.id, body, recipientSessionId) }
  const message: TeamPublicMessageV3 = { ...body, bindingDigest: publicImageBindingDigest(team.id, body),
    delivery: { kind: 'requested', recipients: [recipient] } }
  message.delivery = { kind: 'requested', recipients: [{ ...recipient,
    projection: publicImageProjection(message, recipient, request ? 'images' : 'text-only') }] }
  Object.assign(team, { publicChat: { ...team.publicChat, schemaVersion: 3, messages: [...(team.publicChat?.messages ?? []), message] } })
}

function capacity(deps: TeamDomainDeps, team: TeamState): void {
  expectDomain(publicChatReservedMessageCount(team.publicChat) <= deps.limits.maxPublicMessages
    && publicChatReservedBytes(team.publicChat!) <= deps.limits.maxPublicBytes
    && assistanceRows(team).reduce((sum, row) => sum + row.requests.length, 0) <= deps.limits.maxPublicMessages,
  'Visual collaboration capacity reached', 'TEAM_PUBLIC_CAPACITY')
}

export async function requestVisualAssistance(deps: TeamDomainDeps, scope: TeamScope, teamId: TeamId, actor: string,
  raw: RequestVisualAssistanceInput, expectedRevision: number): Promise<VisualAssistanceResult> {
  const input = normalizeAssistanceRequest(raw)
  return await deps.store.transact(scope, teamId, team => {
    actorMembership(team, actor)
    const existing = findAssistanceRequest(team, actor, input)
    if (existing !== undefined) return { assistance: structuredClone(existing), replayed: true }
    expectDomain(team.revision === expectedRevision, 'Team changed during visual admission; retry unchanged', 'TEAM_REVISION_CONFLICT')
    sourceImages(team, actor, input)
    const rows = assistanceRows(team), now = deps.now(), matching = findInflightVisualAssistance(team, actor, input, now)
    if (matching !== undefined) {
      matching.requests.push({ requestId: input.requestId, digest: visualRequestDigest(input) }); capacity(deps, team)
      return { assistance: structuredClone(matching), replayed: true }
    }
    validateAssistanceRequest(team, actor, input)
    const row: VisualAssistance = { assistanceId: `visual-${randomUUID()}`, requestMessageId: `public-${randomUUID()}`,
      resultId: `public-${randomUUID()}`, sourceMessageId: input.sourceMessageId, requesterSessionId: actor,
      helperSessionId: input.helperSessionId, imageIds: input.imageIds, question: input.question, createdAt: now,
      expiresAt: now + VISUAL_ASSISTANCE_TTL_MS, visited: [actor, input.helperSessionId], requests: [{ requestId: input.requestId, digest: visualRequestDigest(input) }] }
    appendLinkedMessage(team, row, 'request')
    Object.assign(team, { publicChat: { ...team.publicChat!, assistances: [...rows, row] } }); capacity(deps, team)
    return { assistance: structuredClone(row), replayed: false }
  })
}

export async function completeVisualAssistance(deps: TeamDomainDeps, scope: TeamScope, teamId: TeamId, actor: string,
  input: CompleteVisualAssistanceInput): Promise<VisualAssistanceResult> {
  receipt(input.requestId)
  const outcome = publicVisualAssistanceOutcomeSchema.parse(input.outcome), expected = visualCompletionDigest({ ...input, outcome })
  return await deps.store.transact(scope, teamId, team => {
    actorMembership(team, actor)
    const row = assistanceRows(team).find(candidate => candidate.assistanceId === input.assistanceId)
    expectDomain(row !== undefined && row.helperSessionId === actor, 'Only the designated helper can complete this request', 'TEAM_VISUAL_PERMISSION_REVOKED')
    if (row === undefined) throw new Error('Validated assistance missing')
    const reused = assistanceRows(team).find(item => item.helperSessionId === actor && item.result?.requestId === input.requestId)
    expectDomain(reused === undefined || reused.result!.digest === expected, 'Completion identity already binds another payload', 'TEAM_VISUAL_REQUEST_CONFLICT')
    if (row.result !== undefined) {
      if (row.result.requestId === input.requestId && row.result.digest === expected) return { assistance: structuredClone(row), replayed: true }
      expectDomain(row.result.outcome.state !== 'failed' || row.result.outcome.reason !== 'expired', 'Visual assistance expired', 'TEAM_VISUAL_EXPIRED')
      expectDomain(row.result.requestId === input.requestId && row.result.digest === expected, 'Visual assistance is already terminal', 'TEAM_VISUAL_TERMINAL')
      return { assistance: structuredClone(row), replayed: true }
    }
    expectDomain(row.expiresAt > deps.now(), 'Visual assistance expired', 'TEAM_VISUAL_EXPIRED')
    actorMembership(team, row.requesterSessionId)
    row.result = { origin: 'helper', completedAt: Math.max(row.createdAt, deps.now()), outcome, requestId: input.requestId, digest: expected }
    appendLinkedMessage(team, row, 'result'); capacity(deps, team)
    return { assistance: structuredClone(row), replayed: false }
  })
}

/** Existing activity/read/recovery checks call this; no timer or new scheduler owns these results. */
export async function reconcileVisualAssistance(deps: TeamDomainDeps, scope: TeamScope, teamId: TeamId): Promise<void> {
  await deps.store.transact(scope, teamId, team => {
    for (const row of assistanceRows(team)) {
      if (row.result !== undefined) continue
      const active = (id: string) => id === team.captainSessionId || team.members.some(member => member.sessionId === id && member.phase === 'active')
      const reason = team.phase !== 'active' || !active(row.requesterSessionId) ? 'permission-revoked'
        : !active(row.helperSessionId) ? 'helper-unavailable' : row.expiresAt <= deps.now() ? 'expired' : undefined
      if (reason === undefined) continue
      row.result = { origin: 'host', completedAt: Math.max(row.createdAt, deps.now()), outcome: { state: 'failed', reason } }
      appendLinkedMessage(team, row, 'result')
    }
  })
}
