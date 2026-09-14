/**
 * M2 active-task private-memory recall — pure lexical selection engine
 * (task-6, first slice). Fixed contract: docs/04-core-protocol.md §7.1 at
 * pinned commit 32884365c65251fea3b17cbf5d63129898016593.
 *
 * Explainable bounded LEXICAL selection only — no model call, no vector
 * store. Inputs are already ordered candidates from ONE same-fold history
 * (active notes, `headSeq` desc then `memoryId` lexicographic, capped at
 * {@link RECALL_MAX_CANDIDATES}). Task match text is subject, description
 * and each acceptanceCriterion joined by `\n`; note match text is each tag,
 * the applicability, then the content with the SAME separator, and field
 * attribution (tag / applicability / body) is preserved for scoring.
 *
 * Both texts go through NFKC, lowercasing, and a ≤4096-byte complete-
 * codepoint UTF-8 prefix before extraction of ≥2-character ASCII
 * letter/digit/underscore words and adjacent bigrams of contiguous Han runs;
 * dedupe is per field. Score = 4×tag-intersections + 2×applicability-
 * intersections + body-intersections; a note is eligible only with at least
 * one tag or applicability hit, or two DISTINCT body hits. Selection order:
 * score desc, `headSeq` desc, `memoryId` ascending; no hits NEVER backfills
 * from recent notes. Unknown-provenance legacy v1 notes match on body rules
 * only — provenance is never fabricated.
 *
 * @module dsh-agent-swarm/runtime/member-private-memory-recall-selection
 */

/** Candidate cap over one same-fold history (NOT a history-read/validation cap). */
export const RECALL_MAX_CANDIDATES = 64
/** At most three notes may be recalled per contribution. */
export const RECALL_MAX_NOTES = 3
/** Per-note body excerpt bound in UTF-8 bytes (pre-escape). */
export const RECALL_EXCERPT_BYTES = 768
/** Whole private contribution bound in UTF-8 bytes (wrapper + escaped text + metadata). */
export const RECALL_TOTAL_BYTES = 4096
/** Match-text bound in UTF-8 bytes after NFKC + lowercase (complete codepoints only). */
export const RECALL_MATCH_TEXT_BYTES = 4_096

/** One same-fold active note view the selector may consider. */
export interface RecallNoteCandidate {
  readonly memoryId: string
  readonly headSeq: number
  readonly content: string
  readonly tags?: readonly string[]
  readonly applicability?: string
  /** DECLARED quality metadata as stored (M3): model declaration tiers only. */
  readonly claim?: {
    readonly environment: string
    readonly version: string
    readonly outcome: 'reported_pass' | 'reported_failure' | 'declared_observed' | 'hypothesis'
    readonly taskId?: string
    readonly attemptId?: string
  }
  /** Host-observed provenance view for labeling (never a model-supplied fact). */
  readonly provenance?: { readonly kind: 'unattributed' } | { readonly kind: 'task'; readonly taskId: string }
  /** Host-witnessed result observation (M3 evidence segment): only the
   *  result's own error identity reaches the label — deliberately NOT part
   *  of the condition key (a witnessed pair is a provenance dimension, never
   *  a scoring or duplicate-suppression factor). */
  readonly observation?: { readonly isError: boolean }
}

/** The eligible in-progress Task whose text drives the selection. */
export interface RecallTaskText {
  readonly subject: string
  readonly description: string
  readonly acceptanceCriteria: readonly string[]
}

/** A selected note plus the winning excerpt source text (full content). */
export interface RankedRecallNote extends RecallNoteCandidate {
  readonly tagHits: number
  readonly applicabilityHits: number
  readonly bodyHits: number
  readonly score: number
}

/** UTF-8 byte length of a string. */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * NFKC-normalize, lowercase, then take at most `maxBytes` UTF-8 bytes on a
 * COMPLETE-codepoint boundary — codepoints are never split.
 */
export function normalizeMatchText(text: string, maxBytes = RECALL_MATCH_TEXT_BYTES): string {
  const normalized = text.normalize('NFKC').toLowerCase()
  if (new TextEncoder().encode(normalized).length <= maxBytes) return normalized
  let used = 0
  let taken = ''
  for (const character of normalized) {
    const size = new TextEncoder().encode(character).length
    if (used + size > maxBytes) break
    taken += character
    used += size
  }
  return taken
}

const ASCII_WORD = /[a-z0-9_][a-z0-9_]+/gu
/** Han runs by the PUBLIC-STANDARD Unicode script property (`\p{Script=Han}`): every plane — Unified, Ext A–G and beyond, Compatibility Ideographs — as one code-point-iterate run; adjacent-pair bigrams only. */
const HAN_RUN = /\p{Script=Han}+/gu

/** Longest complete-codepoint UTF-8 prefix helper (never splits a codepoint). */
function takeBytes(text: string, maxBytes: number): string {
  let used = 0
  let taken = ''
  for (const character of text) {
    const size = new TextEncoder().encode(character).length
    if (used + size > maxBytes) break
    taken += character
    used += size
  }
  return taken
}

/**
 * NFKC + lowercase each field, then apply the ONE combined ≤4096-byte budget
 * to the `\n`-JOINED text (the contract bounds the MERGED match text, not
 * each field): every field receives its visible prefix of the joined text
 * and a field falling entirely beyond the budget yields NOTHING (it can
 * never contribute a hit). Field attribution is preserved by returning the
 * fields separately.
 */
function budgetedVisibleFields(fields: readonly string[], maxBytes = RECALL_MATCH_TEXT_BYTES): string[] {
  const normalized = fields.map(field => field.normalize('NFKC').toLowerCase())
  const visible: string[] = []
  let used = 0
  for (const field of normalized) {
    const separator = visible.length === 0 ? 0 : 1
    const room = maxBytes - used - separator
    if (room <= 0) {
      visible.push('')
      continue
    }
    const fieldBytes = new TextEncoder().encode(field).length
    if (fieldBytes <= room) {
      visible.push(field)
      used += separator + fieldBytes
    } else {
      visible.push(takeBytes(field, room))
      used = maxBytes
    }
  }
  return visible
}

/**
 * Extract the field's deduped token set from ALREADY-normalized text:
 * ≥2-character ASCII letter/digit/underscore words and adjacent bigrams of
 * contiguous Han runs (a one-character run yields no token).
 */
export function extractTokens(normalizedText: string): ReadonlySet<string> {
  const tokens = new Set<string>()
  for (const match of normalizedText.matchAll(ASCII_WORD)) tokens.add(match[0])
  for (const run of normalizedText.matchAll(HAN_RUN)) {
    const characters = [...run[0]]
    for (let index = 0; index + 1 < characters.length; index += 1) {
      const left = characters[index]
      const right = characters[index + 1]
      if (left !== undefined && right !== undefined) tokens.add(left + right)
    }
  }
  return tokens
}

/** Task match text = subject, description, then each acceptanceCriterion: ONE merged 4096-byte budget. */
export function taskTokens(task: RecallTaskText): ReadonlySet<string> {
  const tokens = new Set<string>()
  for (const field of budgetedVisibleFields([task.subject, task.description, ...task.acceptanceCriteria])) {
    for (const token of extractTokens(field)) tokens.add(token)
  }
  return tokens
}

/** Tokens of one field under the MERGED note-text budget (attribution preserved). */
function fieldTokens(normalizedField: string, task: ReadonlySet<string>): Set<string> {
  const hits = new Set<string>()
  for (const token of extractTokens(normalizedField)) if (task.has(token)) hits.add(token)
  return hits
}

/**
 * Score one candidate against the task tokens: 4×tag hits + 2×applicability
 * hits + body hits. Eligibility: ≥1 tag or applicability hit, or ≥2 DISTINCT
 * body hits. tags/applicability/content share ONE merged 4096-byte budget in
 * that order (fields beyond it contribute nothing; attribution is kept).
 * Missing tags/applicability (legacy v1) contribute zero — body rules only,
 * never re-attributed.
 */
export function scoreRecallNote(note: RecallNoteCandidate, task: ReadonlySet<string>): RankedRecallNote | undefined {
  const tags = note.tags ?? []
  const visible = budgetedVisibleFields([...tags, note.applicability ?? '', note.content])
  const tagHits = new Set<string>()
  for (const field of visible.slice(0, tags.length)) for (const hit of fieldTokens(field, task)) tagHits.add(hit)
  const applicabilityHits = fieldTokens(visible[tags.length] ?? '', task).size
  const bodyHits = fieldTokens(visible[tags.length + 1] ?? '', task).size
  if (tagHits.size === 0 && applicabilityHits === 0 && bodyHits < 2) return undefined
  return { ...note, tagHits: tagHits.size, applicabilityHits, bodyHits, score: tagHits.size * 4 + applicabilityHits * 2 + bodyHits }
}

/**
 * M3 duplicate suppression key: the ACTUAL knowledge content and conditions —
 * exact content (NEVER folded to NFKC/lowercase, which would merge
 * code/case-meaningful knowledge), canonical tags, applicability, and the
 * declared environment/version. It deliberately EXCLUDES the declared
 * outcome and any task/attempt citation or Host source: restating the same
 * knowledge with a different self-rating or a different provenance is still
 * the same knowledge and must not re-occupy recall slots (repetition never
 * raises a verification tier). Knowledge under a DIFFERENT real condition
 * stays separate. On a key collision the NEWEST carrier is kept, carrying
 * its own claim conservatively — without any promotion.
 */
function conditionKey(note: RecallNoteCandidate): string {
  const conditions = note.claim === undefined
    ? 'k:'
    : `k:${note.claim.environment}\u0000${note.claim.version}`
  return JSON.stringify([note.content, note.tags ?? [], note.applicability ?? '', conditions])
}

/**
 * Select at most {@link RECALL_MAX_NOTES} notes from the ordered candidate
 * list. Candidates arrive already filtered to active and ordered `headSeq`
 * desc / `memoryId` ascending and capped; this function re-applies the
 * deterministic full order (score desc, headSeq desc, memoryId asc), then
 * collapses same-knowledge/same-condition duplicates to their newest carrier
 * (repeated self-claims, restated self-ratings or re-cited provenance never
 * multiply recall slots), and returns NOTHING on zero hits — recent notes
 * are never a backfill.
 */
export function selectRecallNotes(candidates: readonly RecallNoteCandidate[], task: RecallTaskText): RankedRecallNote[] {
  const taskSet = taskTokens(task)
  if (taskSet.size === 0) return []
  const scored: RankedRecallNote[] = []
  for (const candidate of candidates.slice(0, RECALL_MAX_CANDIDATES)) {
    const ranked = scoreRecallNote(candidate, taskSet)
    if (ranked !== undefined) scored.push(ranked)
  }
  scored.sort((left, right) => right.score - left.score
    || right.headSeq - left.headSeq
    || (left.memoryId < right.memoryId ? -1 : left.memoryId > right.memoryId ? 1 : 0))
  const seen = new Set<string>()
  const collapsed: RankedRecallNote[] = []
  for (const note of scored) {
    const key = conditionKey(note)
    if (seen.has(key)) continue // same knowledge+conditions already carried by a NEWER headSeq
    seen.add(key)
    collapsed.push(note)
  }
  return collapsed.slice(0, RECALL_MAX_NOTES)
}
