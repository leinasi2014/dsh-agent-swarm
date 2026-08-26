/** Bounded, projection-only SW-I2 receipt pages with host-authenticated cursors. */

import { Buffer } from 'node:buffer'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { TeamDomainError } from '../domain/error.js'
import type { TeamId } from '../domain/types.js'
import type {
  HumanInteractionReceiptPage,
  HumanInteractionReceiptPageInput,
  HumanInteractionReceiptProjection,
} from './human-interaction-contract.js'
import type {
  HumanInteractionOverlayStore,
  HumanInteractionPageKey,
  HumanInteractionRecordPage,
} from './human-interaction-store.js'

const MAX_HUMAN_RECEIPT_PAGE_LIMIT = 50
const MAX_CURSOR_BYTES = 1_024

interface CursorPayload {
  readonly v: 1
  readonly s: string
  readonly t: string
  readonly u: readonly [number, string]
  readonly a: readonly [number, string]
}

interface NormalizedPageInput {
  readonly scope: string
  readonly teamId: TeamId
  readonly limit: number
  readonly cursor?: CursorPayload
}

function pageError(message: string, code = 'TEAM_INTERACTION_PAGE_INVALID'): TeamDomainError {
  return new TeamDomainError(message, code)
}

function digestAuthority(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url')
}

function isPageKey(value: unknown): value is readonly [number, string] {
  return Array.isArray(value)
    && value.length === 2
    && Number.isSafeInteger(value[0])
    && (value[0] as number) >= 0
    && typeof value[1] === 'string'
    && /^human-[a-z0-9-]{8,80}$/.test(value[1])
}

function toPageKey(value: readonly [number, string]): HumanInteractionPageKey {
  return { createdAt: value[0], requestId: value[1] }
}

function project(page: HumanInteractionRecordPage): HumanInteractionReceiptProjection[] {
  return page.records.map(({ receipt }) => ({
    requestId: receipt.requestId,
    teamId: receipt.teamId,
    status: receipt.status,
    ...(receipt.routedMessageId === undefined ? {} : { routedMessageId: receipt.routedMessageId }),
    ...(receipt.answerMessageId === undefined ? {} : { answerMessageId: receipt.answerMessageId }),
    ...(receipt.resultingTaskId === undefined ? {} : { resultingTaskId: receipt.resultingTaskId }),
    ...(receipt.resultingTeamRevision === undefined ? {} : { resultingTeamRevision: receipt.resultingTeamRevision }),
    ...(receipt.code === undefined ? {} : { code: receipt.code }),
    updatedAt: receipt.updatedAt,
  }))
}

/** One plugin-lifetime cursor issuer. A reload intentionally invalidates old cursors. */
export class HumanInteractionReceiptPager {
  private readonly key: Buffer

  constructor(
    private readonly overlay: HumanInteractionOverlayStore,
    key: Uint8Array = randomBytes(32),
  ) {
    this.key = Buffer.from(key)
  }

  async page(
    input: HumanInteractionReceiptPageInput,
    authorize: (input: { readonly scope: string; readonly teamId: TeamId }) => Promise<void>,
  ): Promise<HumanInteractionReceiptPage> {
    const normalized = this.parseInput(input)
    await authorize(normalized)
    const after = normalized.cursor === undefined ? undefined : toPageKey(normalized.cursor.a)
    const upper = normalized.cursor === undefined ? undefined : toPageKey(normalized.cursor.u)
    const records = this.overlay.pageRecords(normalized.scope, normalized.teamId, normalized.limit, after, upper)
    const items = project(records)
    const last = records.records.at(-1)
    const nextCursor = records.hasMore && records.upperBound !== undefined && last !== undefined
      ? this.encode({
          v: 1,
          s: digestAuthority(normalized.scope),
          t: digestAuthority(normalized.teamId),
          u: [records.upperBound.createdAt, records.upperBound.requestId],
          a: [last.createdAt, last.request.requestId],
        })
      : undefined
    return { items, ...(nextCursor === undefined ? {} : { nextCursor }) }
  }

  private parseInput(input: HumanInteractionReceiptPageInput): NormalizedPageInput {
    let descriptors: Record<string, PropertyDescriptor>
    try {
      if (typeof input !== 'object' || input === null || Array.isArray(input)) throw pageError('receipt page input is invalid')
      const prototype = Object.getPrototypeOf(input)
      if (prototype !== Object.prototype && prototype !== null) throw pageError('receipt page input is invalid')
      descriptors = Object.getOwnPropertyDescriptors(input)
    } catch (error) {
      if (error instanceof TeamDomainError) throw error
      throw pageError('receipt page input is invalid')
    }
    const allowed = new Set(['scope', 'teamId', 'limit', 'cursor'])
    if (Object.keys(descriptors).some(key => !allowed.has(key))) throw pageError('receipt page input is invalid')
    for (const descriptor of Object.values(descriptors)) {
      if (!('value' in descriptor)) throw pageError('receipt page input is invalid')
    }
    const scope = descriptors.scope?.value as unknown
    const teamId = descriptors.teamId?.value as unknown
    const limit = descriptors.limit?.value as unknown
    const cursor = descriptors.cursor?.value as unknown
    if (typeof scope !== 'string' || scope === '' || Buffer.byteLength(scope, 'utf8') > 4_096
      || typeof teamId !== 'string' || teamId === '' || Buffer.byteLength(teamId, 'utf8') > 128
      || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_HUMAN_RECEIPT_PAGE_LIMIT
      || (cursor !== undefined && (typeof cursor !== 'string' || Buffer.byteLength(cursor, 'utf8') > MAX_CURSOR_BYTES))) {
      throw pageError('receipt page input is invalid')
    }
    const decoded = cursor === undefined ? undefined : this.decode(cursor)
    if (decoded !== undefined
      && (decoded.s !== digestAuthority(scope) || decoded.t !== digestAuthority(teamId))) {
      throw pageError('receipt page cursor does not match its authority tuple', 'TEAM_INTERACTION_CURSOR_INVALID')
    }
    return {
      scope,
      teamId: teamId as TeamId,
      limit: limit as number,
      ...(decoded === undefined ? {} : { cursor: decoded }),
    }
  }

  private encode(payload: CursorPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    const signature = createHmac('sha256', this.key).update(encoded, 'utf8').digest('base64url')
    return `${encoded}.${signature}`
  }

  private decode(cursor: string): CursorPayload {
    try {
      const parts = cursor.split('.')
      if (parts.length !== 2 || parts[0] === '' || parts[1] === '') throw new Error('shape')
      const encoded = parts[0] as string
      const supplied = Buffer.from(parts[1] as string, 'base64url')
      if (supplied.toString('base64url') !== parts[1]) throw new Error('signature encoding')
      const expected = createHmac('sha256', this.key).update(encoded, 'utf8').digest()
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('signature')
      const bytes = Buffer.from(encoded, 'base64url')
      if (bytes.toString('base64url') !== encoded) throw new Error('payload encoding')
      const value = JSON.parse(bytes.toString('utf8')) as unknown
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('payload')
      const record = value as Record<string, unknown>
      if (Object.keys(record).toSorted().join(',') !== 'a,s,t,u,v'
        || record.v !== 1
        || typeof record.s !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(record.s)
        || typeof record.t !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(record.t)
        || !isPageKey(record.u) || !isPageKey(record.a)) throw new Error('payload')
      return record as unknown as CursorPayload
    } catch {
      throw pageError('receipt page cursor is invalid', 'TEAM_INTERACTION_CURSOR_INVALID')
    }
  }
}
