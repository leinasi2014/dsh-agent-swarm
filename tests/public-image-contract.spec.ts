import { describe, expect, it } from 'vitest'
import type { ZodType } from 'zod'
import * as contract from '../src/rpc/public-rpc-contract.js'
import * as imageVocabulary from '../src/shared/public-image-content.js'
import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import { isCanonicalPublicImageBase64, normalizePublicImageContent, publicImageAvailabilitySchema,
  publicImageContentSchema, publicImageHistorySegmentSchema, publicImageLimitsSchema,
  type PublicImageUploadSegment } from '../src/shared/public-image-content.js'

// Namespace lookup lets the pre-v3 baseline fail on the missing contract itself.
function schema(name: string): ZodType {
  const value: unknown = Reflect.get(contract, name)
  expect(value, `${name} must expose the v3 wire contract`).toBeDefined()
  expect(value, `${name} must expose the v3 wire contract`).toHaveProperty('safeParse')
  return value as ZodType
}

const target = { rootSessionId: 'captain', teamId: 'team' }
const image = { type: 'image', mediaType: 'image/png', data: 'AQID', name: 'detail.png' } satisfies PublicImageUploadSegment
const append = { schemaVersion: 3, target, requestId: 'image-request:1', content: [image] } satisfies contract.PublicChatV3AppendRequest

describe('public v3 image wire contract', () => {
  it('exposes bounded assistance links and outcomes only in read projections', () => {
    const value: unknown = Reflect.get(imageVocabulary, 'publicVisualAssistanceSchema')
    expect(value, 'visual assistance read vocabulary must exist').toHaveProperty('safeParse')
    const parse = value as ZodType
    const request = { kind: 'request', assistanceId: 'assistance-1', sourceMessageId: 'public-1', imageIds: ['image-2', 'image-1'],
      requesterSessionId: 'member-1', helperSessionId: 'member-2', expiresAt: 123 }
    expect(parse.parse(request)).toEqual(request)
    const result = { ...request, kind: 'result', resultId: 'result-1', outcome: { state: 'completed', summary: '图中是一个圆形。' } }
    expect(parse.parse(result)).toEqual(result)
    expect(parse.safeParse({ ...result, outcome: { state: 'failed', reason: 'expired' } }).success).toBe(true)
    for (const invalid of [{ ...request, imageIds: [] }, { ...request, imageIds: ['image-1', 'image-1'] },
      { ...request, helperSessionId: request.requesterSessionId }, { ...request, expiresAt: -1 },
      { ...request, visited: ['private'] }, { ...request, attachmentId: 'private' },
      { ...request, outcome: result.outcome }, { ...result, resultId: '' },
      { ...result, outcome: { state: 'completed', summary: ' ' } },
      { ...result, outcome: { state: 'completed', summary: 'x'.repeat(8193) } },
      { ...result, outcome: { state: 'failed', reason: 'arbitrary-provider-stack' } }]) {
      expect(parse.safeParse(invalid).success).toBe(false)
    }
    expect(schema('publicChatV3AppendRequestSchema').safeParse({ ...append, assistance: request }).success).toBe(false)
  })

  it('exposes only append, history, requestResult and authorized image read in v3', () => {
    expect(Reflect.get(contract, 'PUBLIC_RPC_V3_ENDPOINTS')).toEqual({
      history: 'v3/history', append: 'v3/append', requestResult: 'v3/requestResult', image: 'v3/image',
    })
    expect(contract.PUBLIC_RPC_V2_ENDPOINTS.directory).toBe('v2/directory')
  })

  it('accepts a pure image and preserves ordered mixed input including repeated mentions', () => {
    const parse = schema('publicChatV3AppendRequestSchema')
    expect(parse.safeParse(append).success).toBe(true)
    const content = [{ type: 'text', text: '看这里' }, { type: 'mention', memberId: 'member' }, image,
      { type: 'mention', memberId: 'member' }, { ...image, mediaType: 'image/gif', name: 'animation.gif' }]
    expect(parse.parse({ ...append, content })).toEqual({ ...append, content })
  })

  it.each(['path', 'url', 'attachmentId', 'attachment', 'imageId', 'author', 'width', 'height', 'bytes', 'originalDimensions', 'receipt'])(
    'rejects caller-controlled image field %s', key => {
    expect(schema('publicChatV3AppendRequestSchema').safeParse({ ...append, content: [{ ...image, [key]: 'forged' }] }).success).toBe(false)
  })

  it.each(['', 'AQI', 'AQ I=', 'data:image/png;base64,AQI=', 'AQI_', 'AR==', 'AQJ=', 'https://example.test/image.png'])(
    'rejects noncanonical or empty image data %j', data => {
    expect(schema('publicChatV3AppendRequestSchema').safeParse({ ...append, content: [{ ...image, data }] }).success).toBe(false)
  })

  it('rejects alternate request authority, versions, ambiguous cursors and invalid request IDs', () => {
    const parse = schema('publicChatV3AppendRequestSchema')
    for (const value of [{ ...append, author: { kind: 'agent' } }, { ...append, schemaVersion: 2 },
      { ...append, requestId: 'with space' }, { ...append, target: { ...target, parentSessionId: 'wrong' } },
      { ...append, content: [] }, { ...append, content: [{ ...image, mediaType: 'image/svg+xml' }] }]) {
      expect(parse.safeParse(value).success).toBe(false)
    }
    const history = schema('publicChatV3HistoryRequestSchema')
    expect(history.safeParse({ schemaVersion: 3, target, afterSequence: 0 }).success).toBe(true)
    expect(history.safeParse({ schemaVersion: 3, target, beforeSequence: 2, afterSequence: 0 }).success).toBe(false)
    expect(schema('publicChatV3RequestResultRequestSchema').safeParse({ schemaVersion: 3, target, requestId: append.requestId }).success).toBe(true)
  })

  it('requires both owning message and message-local image ID to read image bytes', () => {
    const parse = schema('publicChatV3ImageRequestSchema')
    const request = { schemaVersion: 3, target, messageId: 'public-message', imageId: 'image-1' }
    expect(parse.parse(request)).toEqual(request)
    expect(parse.safeParse({ ...request, attachmentId: 'sha256:forged' }).success).toBe(false)
    expect(parse.safeParse({ schemaVersion: 3, target, imageId: 'image-1' }).success).toBe(false)
  })

  it('exposes history metadata without bytes, storage references or paths', () => {
    const history = { type: 'image', imageId: 'image-1', mediaType: 'image/jpeg', bytes: 123,
      width: 320, height: 200, name: 'detail.jpg', originalDimensions: { width: 640, height: 400 } }
    expect(publicImageHistorySegmentSchema.parse(history)).toEqual(history)
    for (const key of ['data', 'attachmentId', 'attachment', 'url', 'path']) {
      expect(publicImageHistorySegmentSchema.safeParse({ ...history, [key]: 'private' }).success).toBe(false)
    }
    for (const key of ['bytes', 'width', 'height']) {
      expect(publicImageHistorySegmentSchema.safeParse({ ...history, [key]: 0 }).success).toBe(false)
    }
    expect(publicImageHistorySegmentSchema.safeParse({ ...history, originalDimensions: { width: 640, height: 400, path: 'private' } }).success).toBe(false)
  })

  it('publishes the exact official six-field policy or explicit absence independently of text input', () => {
    const limits = { maxImageBytes: 40, maxImagesPerMessage: 2, maxMessageImageBytes: 60,
      maxImagePixels: 100, maxImageDimension: 10, mediaTypes: ['image/png', 'image/jpeg'] } satisfies ImageAttachmentLimits
    const parsed: ImageAttachmentLimits = publicImageLimitsSchema.parse(limits)
    expect(parsed).toEqual(limits)
    expect(publicImageAvailabilitySchema.parse({ state: 'available', imageLimits: limits })).toEqual({ state: 'available', imageLimits: limits })
    expect(publicImageAvailabilitySchema.parse({ state: 'unavailable', reason: 'attachment-service-unavailable' })).toEqual({ state: 'unavailable', reason: 'attachment-service-unavailable' })
    expect(publicImageAvailabilitySchema.safeParse({ state: 'available' }).success).toBe(false)
    expect(publicImageLimitsSchema.safeParse({ ...limits, maxBytes: 40 }).success).toBe(false)
    expect(publicImageContentSchema.safeParse([{ type: 'text', text: '仍然可以发文本' }]).success).toBe(true)
  })

  it('normalizes only adjacent text and outside whitespace, leaving ordered original image identity intact', () => {
    const input = [{ type: 'text' as const, text: '  开始' }, { type: 'text' as const, text: ' 中间 ' }, image,
      { type: 'text' as const, text: ' 图后 ' }, { type: 'mention' as const, memberId: 'm' }, image,
      { type: 'text' as const, text: ' 结束  ' }]
    const before = structuredClone(input)
    expect(normalizePublicImageContent(input)).toEqual([{ type: 'text', text: '开始 中间 ' }, image,
      { type: 'text', text: ' 图后 ' }, { type: 'mention', memberId: 'm' }, image, { type: 'text', text: ' 结束' }])
    expect(input).toEqual(before)
    expect(normalizePublicImageContent([image])).toEqual([image])
    expect(publicImageContentSchema.safeParse([{ type: 'text', text: '  ' }]).success).toBe(false)
    expect(publicImageContentSchema.safeParse(Array.from({ length: 257 }, () => image)).success).toBe(false)
  })

  it('matches canonical byte encodings without relying on declared MIME or decoding a raster', () => {
    for (let value = 0; value <= 255; value++) {
      for (const bytes of [[value], [value, 255 - value], [value, 0, 255 - value]]) {
        expect(isCanonicalPublicImageBase64(Buffer.from(bytes).toString('base64'))).toBe(true)
      }
    }
    expect(isCanonicalPublicImageBase64('AAA\n')).toBe(false)
    // Structurally valid upload bytes are deliberately not claimed to be a valid PNG.
    expect(publicImageContentSchema.safeParse([image]).success).toBe(true)
  })
})
