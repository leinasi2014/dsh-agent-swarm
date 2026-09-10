/** Client-safe public input vocabulary. Names never decide who receives a message. */
import { z } from 'zod'

export const MAX_PUBLIC_CONTENT_SEGMENTS = 256
export const publicSegmentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z.object({ type: z.literal('mention'), memberId: z.string().min(1).max(256) }).strict(),
])
export const publicContentSchema = z.array(publicSegmentSchema).min(1).max(MAX_PUBLIC_CONTENT_SEGMENTS)
export type PublicSegment = z.infer<typeof publicSegmentSchema>
export interface PublicMentionLabel { readonly memberId: string; readonly label: string }

/** Normalize storage/digest form; escapes remain intact until display rendering. */
export function normalizePublicContent(input: readonly PublicSegment[]): PublicSegment[] {
  const parsed = publicContentSchema.parse(input)
  const content: PublicSegment[] = []
  for (const segment of parsed) {
    if (segment.type === 'mention') { content.push({ ...segment }); continue }
    const last = content.at(-1)
    if (last?.type === 'text') last.text += segment.text
    else if (segment.text !== '') content.push({ ...segment })
  }
  const first = content[0], last = content.at(-1)
  if (first?.type === 'text') first.text = first.text.trimStart()
  if (last?.type === 'text') last.text = last.text.trimEnd()
  return content.filter(segment => segment.type === 'mention' || segment.text !== '')
}

/** UTF-16 positions match the browser selection API. Used for UI candidates and admission. */
export function publicMentionStarts(text: string): number[] {
  const result: number[] = []
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '@') continue
    let slashes = 0
    for (let before = index - 1; before >= 0 && text[before] === '\\'; before--) slashes++
    if (slashes % 2 === 1) continue
    if (index === 0 || !/[A-Za-z0-9_]/u.test(text[index - 1]!)) result.push(index)
  }
  return result
}

export function hasUnconfirmedPublicMention(content: readonly PublicSegment[]): boolean {
  return content.some(segment => segment.type === 'text' && publicMentionStarts(segment.text).length > 0)
}

/** Decode odd backslash runs before @ once; even runs and other escapes stay literal. */
export function renderPublicText(text: string): string {
  return text.replace(/\\+@/gu, value => {
    const count = value.length - 1
    return count % 2 === 1 ? '\\'.repeat(Math.floor(count / 2)) + '@' : value
  })
}

export function publicMentionIds(content: readonly PublicSegment[]): string[] {
  return [...new Set(content.flatMap(segment => segment.type === 'mention' ? [segment.memberId] : []))]
}

/** Agent replies and legacy projections use literalText: their text never becomes mention syntax. */
export function renderPublicContent(content: readonly PublicSegment[], labels: readonly PublicMentionLabel[], literalText = false): string {
  const byId = new Map(labels.map(row => [row.memberId, row.label]))
  return content.map(segment => {
    if (segment.type === 'text') return literalText ? segment.text : renderPublicText(segment.text)
    const label = byId.get(segment.memberId)
    if (label === undefined) throw new Error('Public mention has no frozen label')
    return `@${label}`
  }).join('')
}
