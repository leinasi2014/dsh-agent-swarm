import { publicMentionStarts, type PublicSegment } from '../shared/public-content.js'
interface DraftToken { readonly start: number; readonly end: number; readonly memberId: string; readonly label: string }
/** Blob identities are local to a Host/Main/Team draft scope, never attachment authority. */
type PublicDraftImageError = 'format' | 'empty' | 'decode'
export interface PublicDraftImage {
  readonly blobId: string; readonly mediaType: string; readonly name?: string
  readonly status?: 'checking' | 'ready' | 'invalid'; readonly width?: number; readonly height?: number; readonly error?: PublicDraftImageError
}
export interface PublicDraft { readonly text: string; readonly version: number; readonly replyTo?: string; readonly tokens: readonly DraftToken[]; readonly images?: readonly PublicDraftImage[] }
export function addDraftImages(draft: PublicDraft, images: readonly PublicDraftImage[]): PublicDraft {
  if (images.length === 0) return draft
  const combined = [...draft.images ?? [], ...images]
  if (new Set(combined.map(image => image.blobId)).size !== combined.length) throw new Error('Duplicate draft image identity')
  return { ...draft, images: combined, version: draft.version + 1 }
}
export function removeDraftImage(draft: PublicDraft, blobId: string): PublicDraft {
  const images = draft.images?.filter(image => image.blobId !== blobId)
  return images === undefined || images.length === draft.images?.length ? draft : { ...draft, images, version: draft.version + 1 }
}
export function replyDraft(draft: PublicDraft, replyTo: string | undefined): PublicDraft {
  const { replyTo: _previous, ...rest } = draft
  return { ...rest, version: draft.version + 1, ...(replyTo === undefined ? {} : { replyTo }) }
}
export function draftContent(draft: Pick<PublicDraft, 'text' | 'tokens'>): PublicSegment[] {
  const content: PublicSegment[] = []; let position = 0
  for (const token of draft.tokens) {
    if (token.start > position) content.push({ type: 'text', text: draft.text.slice(position, token.start) })
    content.push({ type: 'mention', memberId: token.memberId }); position = token.end
  }
  if (position < draft.text.length) content.push({ type: 'text', text: draft.text.slice(position) })
  return content
}
export function replaceDraftRange(draft: PublicDraft, start: number, end: number, text: string, mention?: { memberId: string; label: string }): PublicDraft {
  for (const token of draft.tokens) if ((start < token.end && end > token.start) || (start === end && start > token.start && start < token.end)) {
    start = Math.min(start, token.start); end = Math.max(end, token.end)
  }
  const delta = text.length - (end - start)
  const tokens = draft.tokens.filter(token => token.end <= start || token.start >= end).map(token => token.start >= end ? { ...token, start: token.start + delta, end: token.end + delta } : token)
  if (mention !== undefined) tokens.push({ start, end: start + text.length, ...mention })
  return { ...draft, text: draft.text.slice(0, start) + text + draft.text.slice(end), tokens: tokens.toSorted((a, b) => a.start - b.start), version: draft.version + 1 }
}
/** A browser text edit is one replacement; touching a token removes that entire identity. */
export function editDraft(draft: PublicDraft, text: string): PublicDraft {
  let start = 0, oldEnd = draft.text.length, newEnd = text.length
  while (start < oldEnd && start < newEnd && draft.text[start] === text[start]) start++
  while (oldEnd > start && newEnd > start && draft.text[oldEnd - 1] === text[newEnd - 1]) { oldEnd--; newEnd-- }
  const inserted = text.slice(start, newEnd), removed = oldEnd - start
  // Without a native edit range, equal labels can make several replacements
  // produce the same text. Such text cannot prove which identity survived.
  const ambiguous = (removed > 0 || inserted !== '') && draft.tokens.some(token => [token.start, token.end - removed].some(position => position >= 0 && position !== start && position + removed <= draft.text.length && draft.text.slice(0, position) + inserted + draft.text.slice(position + removed) === text))
  if (ambiguous) return { ...draft, text, tokens: [], version: draft.version + 1 }
  return replaceDraftRange(draft, start, oldEnd, inserted)
}
export function mentionCandidate(draft: Pick<PublicDraft, 'text' | 'tokens'>, caret: number): { start: number; end: number; query: string } | undefined {
  if (draft.tokens.some(token => caret > token.start && caret <= token.end)) return undefined
  const start = draft.tokens.filter(token => token.end <= caret).at(-1)?.end ?? 0
  const text = draft.text.slice(start, caret)
  const at = publicMentionStarts(text).at(-1)
  if (at === undefined || /\s/u.test(text.slice(at + 1))) return undefined
  return { start: start + at, end: caret, query: text.slice(at + 1) }
}
