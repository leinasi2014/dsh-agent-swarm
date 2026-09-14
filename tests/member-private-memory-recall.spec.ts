/**
 * M2 active-task private-memory recall — contract unit slice (task-6 GREEN).
 * Exercises the FIXED algorithm of docs/04-core-protocol.md §7.1 (pinned
 * 32884365c65251fea3b17cbf5d63129898016593): candidate ordering/cap, NFKC +
 * lowercase + byte-bounded codepoint-safe match text, word/adjacent-Han-
 * bigram extraction with field attribution, 4/2/1 weights and the hit
 * threshold, the deterministic total order with NO recent backfill, the
 * ≤3×768B / whole-contribution ≤4096B render bounds (shrink-then-drop, no
 * split codepoints, metadata-only overflow → no contribution, no observation
 * clock), the read-only store projections, the Host config default, and the
 * service delegation. Real-composition authority/boundary cases live in
 * member-private-memory-recall-real-composition.spec.ts.
 */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { afterEach, describe, expect, it } from 'vitest'
import { MemberPrivateMemoryStore, privateMemoryDomainSpec, type PrivateMemoryNote } from '../src/storage/member-private-memory.js'
import {
  RECALL_EXCERPT_BYTES, RECALL_MATCH_TEXT_BYTES, RECALL_MAX_CANDIDATES, RECALL_MAX_NOTES, RECALL_TOTAL_BYTES,
  extractTokens, normalizeMatchText, scoreRecallNote, selectRecallNotes, taskTokens, utf8Length,
} from '../src/runtime/member-private-memory-recall-selection.js'
import { renderRecallContribution } from '../src/runtime/member-private-memory-recall-render.js'
import { MemberPrivateMemoryService } from '../src/runtime/member-private-memory-service.js'
import { Config } from '../src/plugin/config.js'
import type { TeamScope } from '../src/domain/team-domain-port.js'
import { TeamId } from '../src/index.js'
import { FaultableBackend } from './helpers/storage-stack.js'

function tokens(text: string): ReadonlySet<string> {
  return extractTokens(normalizeMatchText(text))
}

function candidate(memoryId: string, headSeq: number, over: Partial<PrivateMemoryNote> = {}): PrivateMemoryNote {
  return {
    memoryId, headSeq, seq: headSeq, content: '', status: 'active', createdAt: 1, evidenceRefs: [],
    ...over,
  } as PrivateMemoryNote
}

const TASK = { subject: 'bind head cas', description: 'the recallprobe note informs selection', acceptanceCriteria: ['recallprobe evidence handled'] }

describe('recall selection (fixed lexical algorithm)', () => {
  it('normalizes NFKC + lowercase and truncates on a complete-codepoint UTF-8 boundary', () => {
    expect(normalizeMatchText('ＷＩＤＥ Ｃａｓｅ')).toBe('wide case')
    const emoji = normalizeMatchText('😀'.repeat(RECALL_MATCH_TEXT_BYTES / 4 + 25))
    expect(utf8Length(emoji)).toBe(RECALL_MATCH_TEXT_BYTES)
    expect(emoji).toBe('😀'.repeat(RECALL_MATCH_TEXT_BYTES / 4))
    const mixed = normalizeMatchText('あ😀'.repeat(2000))
    expect(utf8Length(mixed)).toBeLessThanOrEqual(RECALL_MATCH_TEXT_BYTES)
    // The next codepoint (3 or 4 bytes) must NOT fit: the cut is maximal.
    expect(utf8Length(mixed.at(-1) ?? '') + utf8Length(mixed)).toBeGreaterThan(RECALL_MATCH_TEXT_BYTES - 4)
  })

  it('extracts ≥2-character ASCII words and adjacent bigrams of contiguous Han runs', () => {
    const found = tokens('Recall_probe v2 ab a 记忆召回 单 记')
    expect(found.has('recall_probe')).toBe(true)
    expect(found.has('v2')).toBe(true)
    expect(found.has('ab')).toBe(true)
    expect(found.has('a')).toBe(false) // single characters never match
    expect([...found].filter(token => /[\u4e00-\u9fff]/.test(token)).toSorted()).toEqual(['召回', '忆召', '记忆'])
    // A single-character Han run yields no bigram.
    expect(tokens('单').size).toBe(0)
  })

  it('joins task fields with attribution and dedupes across fields', () => {
    const joined = taskTokens(TASK)
    expect(joined.has('recallprobe')).toBe(true) // appears in description AND acceptanceCriteria — deduped set
    expect(joined.has('bind')).toBe(true)
    expect(joined.has('handled')).toBe(true)
    expect(joined.has('selection')).toBe(true)
    expect([...joined].filter(token => token === 'recallprobe')).toHaveLength(1)
  })

  it('scores tag/applicability/body intersections 4/2/1 with the exact threshold', () => {
    const taskSet = tokens([TASK.subject, TASK.description, ...TASK.acceptanceCriteria].join('\n'))
    const tagHit = scoreRecallNote(candidate('m-1', 5, { content: 'unrelated body', tags: ['recallprobe'], applicability: 'nothing' }), taskSet)
    expect(tagHit?.tagHits).toBe(1)
    expect(tagHit?.score).toBe(4)
    const applicHit = scoreRecallNote(candidate('m-2', 5, { content: 'unrelated body', tags: ['zzz'], applicability: 'recallprobe only' }), taskSet)
    expect(applicHit?.score).toBe(2)
    const oneBody = scoreRecallNote(candidate('m-3', 5, { content: 'only recallprobe appears once here' }), taskSet)
    expect(oneBody).toBeUndefined() // ONE distinct body word fails the threshold (rejected → undefined)
    const twoBody = scoreRecallNote(candidate('m-4', 5, { content: 'recallprobe evidence and notes' }), taskSet)
    expect(twoBody?.bodyHits).toBe(2)
    expect(twoBody?.score).toBe(2)
    const repeated = scoreRecallNote(candidate('m-5', 5, { content: 'recallprobe recallprobe recallprobe' }), taskSet)
    expect(repeated).toBeUndefined() // repeats are not two DISTINCT body words
  })

  it('orders by score desc, headSeq desc, memoryId asc and never backfills without hits', () => {
    const picked = selectRecallNotes([
      candidate('b', 9, { content: 'recallprobe evidence body words', tags: ['recallprobe'] }),
      candidate('a', 3, { content: 'recallprobe evidence also here', tags: ['recallprobe'] }),
      candidate('c', 12, { content: 'zzz qq', tags: ['head'] }),
    ], TASK)
    expect(picked.map(note => note.memoryId)).toEqual(['b', 'a', 'c'])
    expect(selectRecallNotes([candidate('x', 40, { content: 'nothing related at all' })], TASK)).toEqual([])
    expect(selectRecallNotes([], TASK)).toEqual([])
    expect(selectRecallNotes([candidate('x', 1, { content: 'recallprobe evidence' })], { subject: '', description: '', acceptanceCriteria: [] })).toEqual([])
  })

  it('caps at 64 CANDIDATES (window on the ordered input, not a scoring cap)', () => {
    const many = Array.from({ length: RECALL_MAX_CANDIDATES }, (_, index) => candidate(`n-${String(index).padStart(3, '0')}`, 100 - index, { content: 'recallprobe evidence ok' }))
    const beyond = candidate('z-out-of-window', 1, { content: 'completely unrelated words here', tags: ['recallprobe'] })
    const picked = selectRecallNotes([...many, beyond], TASK)
    expect(picked.length).toBeLessThanOrEqual(RECALL_MAX_NOTES)
    expect(picked.some(note => note.memoryId === 'z-out-of-window')).toBe(false) // 65th never considered
    expect(picked.every(note => note.tagHits === 0)).toBe(true) // window notes match on body only
  })

  it('matches legacy v1 notes on body rules only and never fabricates provenance metadata', () => {
    const legacy = candidate('v1-1', 7, { content: 'recallprobe evidence from an archived source' })
    const legacyPicked = selectRecallNotes([legacy], TASK)
    expect(legacyPicked).toHaveLength(1)
    expect(legacyPicked[0]?.tagHits).toBe(0)
    expect(legacyPicked[0]?.applicabilityHits).toBe(0)
    expect(legacyPicked[0]?.bodyHits).toBe(2) // exactly recallprobe + evidence
  })

  it('applies ONE merged 4096-byte budget: fields beyond it never hit (both sides)', () => {
    // Task side: acceptanceCriteria beyond the merged budget contributes nothing.
    const padded = { subject: 'recallprobe', description: 'x'.repeat(RECALL_MATCH_TEXT_BYTES), acceptanceCriteria: ['handled evidence'] }
    expect(taskTokens(padded).has('handled')).toBe(false)
    expect(taskTokens(padded).has('recallprobe')).toBe(true)
    // Note side: a huge tags field pushes content beyond the budget.
    const taskSet = tokens('recallprobe evidence body words')
    const hugeTagNote = candidate('m', 5, { content: 'recallprobe evidence', tags: ['p'.repeat(RECALL_MATCH_TEXT_BYTES), 'recallprobe'], applicability: 'evidence' })
    expect(scoreRecallNote(hugeTagNote, taskSet)).toBeUndefined() // content/applicability fell beyond the merged 4096 budget
    // Boundary: content entirely beyond the budget cannot reach the 2-word threshold even when it WOULD match.
    const boundaryNote = candidate('b', 5, { content: 'tail deep', tags: ['p'.repeat(RECALL_MATCH_TEXT_BYTES - 8)] })
    expect(scoreRecallNote(boundaryNote, tokens('tail deep'))).toBeUndefined()
    // Same note WITHOUT the tag padding DOES match (control for the budget effect).
    expect(scoreRecallNote({ ...boundaryNote, tags: [] }, tokens('tail deep'))?.bodyHits).toBe(2)
  })

  it('extracts bigrams from surrogate-pair Han extensions as whole codepoints', () => {
    const extB = '\u{20000}\u{20001}' // Han ext-B pair → one bigram
    const found = extractTokens(normalizeMatchText(extB))
    expect(found.size).toBe(1)
    expect([...found][0]).toBe(extB)
  })

  it('RED: full Han lexing covers Ext-C and Extension G planes, cross-plane adjacency, and never spans a separator', () => {
    // Hand-written expectations (NOT produced by the tokenizer under test).
    // Planes: U+2A700/U+2A701 = Ext-C first pair; U+30000/U+30001 = Extension G
    // first pair. The current character-class stops at U+2A6DF (Ext-B end), so
    // these planes yield NO tokens today → behavior RED. The GREEN fix is a
    // public-standard full Han classification, not more hand-added ranges.
    const extC = '\u{2a700}\u{2a701}'
    const extG = '\u{30000}\u{30001}'
    // Codepoint completeness: whole astral pairs, never lone surrogates.
    const foundC = extractTokens(normalizeMatchText(extC))
    expect([...foundC].toSorted()).toEqual([extC])
    const foundG = extractTokens(normalizeMatchText(extG))
    expect([...foundG].toSorted()).toEqual([extG])
    // Cross-plane adjacency inside ONE contiguous Han run forms bigrams:
    // basic-Han 鿿 (U+9FFF) directly followed by the Ext-C and Ext-G first
    // ideographs — hand-written adjacent pairs, no separators.
    const cross = '鿿\u{2a700}\u{30000}'
    const foundCross = extractTokens(normalizeMatchText(cross))
    expect([...foundCross].toSorted()).toEqual(['鿿\u{2a700}', '\u{2a700}\u{30000}'])
    // NFKC budget semantics unchanged: these planes are NFKC-invariant and
    // count as one codepoint per ideograph for the byte budget.
    expect(normalizeMatchText(extG)).toBe(extG)
    expect(utf8Length(extG)).toBe(8)
    // Non-Han separators never join runs across them (regression guard).
    expect(extractTokens(normalizeMatchText(`${extC.slice(0, 2)}x\u{2a701}`)).size).toBe(0)
  })
})

const identity = { taskId: 'task-1', attemptId: 'attempt-1' }

function ranked(memoryId: string, headSeq: number, content: string) {
  return { memoryId, headSeq, content, tagHits: 1, applicabilityHits: 0, bodyHits: 0, score: 4 }
}

describe('recall contribution renderer (absolute byte bounds)', () => {

  it('wraps the named contribution with the fixed identity attributes and is deterministic (no observation clock)', () => {
    const first = renderRecallContribution(identity, [ranked('private-memory-3', 12, 'recallprobe lesson')])
    const second = renderRecallContribution(identity, [ranked('private-memory-3', 12, 'recallprobe lesson')])
    expect(first).toBeDefined()
    expect(first).toBe(second) // byte-identical: no per-call clock inside the contribution
    expect(first).toContain('<private-memory-recall')
    expect(first).toContain('task="task-1"')
    expect(first).toContain('attempt="attempt-1"')
    expect(first).toContain('data-memory-id="private-memory-3"')
    expect(first).toContain('data-head-seq="12"')
    expect(first).toContain('recallprobe lesson')
  })

  it('escapes note text as data, never markup', () => {
    const rendered = renderRecallContribution(identity, [ranked('m', 1, 'x <script>alert(1)</script> & "q"')]) ?? ''
    expect(rendered).toContain('&lt;script&gt;')
    expect(rendered).not.toContain('<script>')
    expect(utf8Length(rendered)).toBeLessThanOrEqual(RECALL_TOTAL_BYTES)
  })

  it('caps selections at three notes and the whole contribution at 4096 bytes', () => {
    const picked = selectRecallNotes(
      ['a', 'b', 'c', 'd'].map(id => candidate(id, 10, { content: `recallprobe evidence ${id}`, tags: ['recallprobe'] })),
      TASK,
    )
    expect(picked).toHaveLength(RECALL_MAX_NOTES)
    const rendered = renderRecallContribution(identity, picked) ?? ''
    expect((rendered.match(/data-memory-id=/g) ?? []).length).toBe(RECALL_MAX_NOTES)
    expect(utf8Length(rendered)).toBeLessThanOrEqual(RECALL_TOTAL_BYTES)
  })

  it('shrinks excerpts to ≤768 bytes on codepoint boundaries with a mark before dropping entries', () => {
    const wide = '记'.repeat(1000) // 3 bytes per character
    const rendered = renderRecallContribution(identity, [ranked('wide', 5, wide), ranked('tail', 4, 'recallprobe evidence tail')]) ?? ''
    expect(utf8Length(rendered)).toBeLessThanOrEqual(RECALL_TOTAL_BYTES)
    expect(rendered).toContain('data-memory-id="wide"')
    expect(rendered).toContain('data-memory-id="tail"')
    // The wide excerpt alone must not exceed its 768-byte bound (mark included).
    expect(rendered).not.toContain('记'.repeat(RECALL_EXCERPT_BYTES / 3 + 2)) // 771 bytes > 768
    expect(rendered).toContain('记'.repeat(200))
    // No split codepoints: the rendered text round-trips exactly as UTF-8.
    expect(Buffer.from(rendered, 'utf8').toString('utf8')).toBe(rendered)
    expect(rendered).toContain('…')
  })

  it('drops later entries (in selection order) when the total would overflow', () => {
    // Each entry's FIXED identity (a 1600-char memoryId attribute) plus one
    // 768-byte excerpt consumes more than half of the 4096 bound: the second
    // entry cannot carry even its own identity attributes and must drop out.
    const wideId = 'm'.repeat(1600)
    const body = 'x'.repeat(800)
    const rendered = renderRecallContribution(identity, [
      ranked(wideId, 3, body), ranked('m'.repeat(1601), 2, body), ranked('m'.repeat(1602), 1, body),
    ]) ?? ''
    expect(rendered).toContain(`data-memory-id="${wideId}"`)
    expect(rendered).toContain('…')
    expect(utf8Length(rendered)).toBeLessThanOrEqual(RECALL_TOTAL_BYTES)
    const kept = (rendered.match(/data-memory-id=/g) ?? []).length
    expect(kept).toBe(1)
  })

  it('returns NO contribution when the fixed identity metadata alone cannot fit', () => {
    const hugeId = 'i'.repeat(4200)
    expect(renderRecallContribution(identity, []) ).toBeUndefined()
    expect(renderRecallContribution({ taskId: hugeId, attemptId: hugeId }, [ranked('m', 1, 'x')])).toBeUndefined()
  })
})

async function mountStore(): Promise<{ store: MemberPrivateMemoryStore; close(): Promise<void> }> {
  const ctx = new Context()
  const fibers: Fiber[] = []
  const backend = new FaultableBackend()
  fibers.push(await ctx.plugin(Storage))
  ctx.storage.backend.register('faultable', backend)
  ctx.provide(storageBackendServiceKey('faultable'), backend)
  fibers.push(await ctx.plugin(StorageDomain, { backend: 'faultable' }))
  const domain: Domain<typeof privateMemoryDomainSpec> = await ctx.storageDomain.open(privateMemoryDomainSpec)
  const store = new MemberPrivateMemoryStore(ctx, domain)
  return {
    store,
    close: async () => {
      store.close()
      await domain.close()
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    },
  }
}

describe('read-only store projections for recall (task-6)', () => {
  const roots: Array<{ close(): Promise<void> }> = []

  afterEach(async () => {
    for (const mounted of roots.splice(0)) await mounted.close()
  })

  it('returns active notes only, ordered headSeq desc then memoryId asc, capped, detached', async () => {
    const mounted = await mountStore()
    roots.push(mounted)
    const add = (operationId: string, content: string, tags: string[]) => mounted.store.appendMaintenance('s', 't', 'm',
      { operation: 'add', operationId, content, evidenceRefs: [], tags, applicability: 'general' }, { kind: 'unattributed' }, undefined, write => write())
    await add('op-1', 'first active', ['keep'])
    await add('op-2', 'to be invalidated', ['drop'])
    await add('op-3', 'third active', ['keep'])
    await mounted.store.appendMaintenance('s', 't', 'm',
      { operation: 'invalidate', operationId: 'op-4', targetMemoryId: 'private-memory-2', expectedHeadSeq: 2 }, { kind: 'unattributed' }, undefined, write => write())
    const active = mounted.store.recentActiveNotes('s', 't', 'm', 64)
    expect(active.map(note => note.memoryId)).toEqual(['private-memory-3', 'private-memory-1'])
    expect(mounted.store.recentActiveNotes('s', 't', 'm', 1).map(note => note.memoryId)).toEqual(['private-memory-3'])
    // Detached deep copies: two reads never share object identity.
    expect(mounted.store.recentActiveNotes('s', 't', 'm', 64)[0]).not.toBe(mounted.store.recentActiveNotes('s', 't', 'm', 64)[0])
    const versions = mounted.store.noteVersions('s', 't', 'm')
    // M1 fixed contract: headSeq is the note's LATEST operation seq, not its
    // creation seq — the terminal invalidate committed at physical seq 4.
    expect(versions.get('private-memory-2')).toEqual({ headSeq: 4, status: 'invalidated' })
    expect(versions.get('private-memory-1')).toEqual({ headSeq: 1, status: 'active' })
  })

  it('folds legacy v1 notes into the projection with their own identity', async () => {
    const mounted = await mountStore()
    roots.push(mounted)
    await mounted.store.append('s', 't', 'm', 'legacy body', [])
    const active = mounted.store.recentActiveNotes('s', 't', 'm', 64)
    expect(active.map(note => note.memoryId)).toEqual(['private-memory-1'])
    expect(active[0]?.tags).toBeUndefined()
  })

  it('exposes the projections through the service and fails loud when unmounted', async () => {
    const mounted = await mountStore()
    roots.push(mounted)
    const service = new MemberPrivateMemoryService({
      domain: () => { throw new Error('unused') },
      scopeOf: () => { throw new Error('unused') },
      store: () => mounted.store,
      liveAgent: () => undefined,
    })
    await mounted.store.append('s', 't', 'm', 'service-visible', [])
    const scope = 's' as TeamScope
    expect(service.recallCandidates(scope, TeamId('t'), 'm', 64).map(note => note.content)).toEqual(['service-visible'])
    expect(service.recallNoteVersions(scope, TeamId('t'), 'm').get('private-memory-1')?.status).toBe('active')
    const unmounted = new MemberPrivateMemoryService({
      domain: () => { throw new Error('unused') },
      scopeOf: () => { throw new Error('unused') },
      store: () => undefined,
      liveAgent: () => undefined,
    })
    expect(() => unmounted.recallCandidates(scope, TeamId('t'), 'm', 64)).toThrowError(/not mounted/u)
    expect(() => unmounted.recallNoteVersions(scope, TeamId('t'), 'm')).toThrowError(/not mounted/u)
  })
})

describe('Host config privateMemoryRecall (grant surface)', () => {
  it('defaults to disabled and accepts only the two fixed tiers', () => {
    expect(Config({}).privateMemoryRecall).toBe('disabled')
    expect(Config({ privateMemoryRecall: 'active-task' }).privateMemoryRecall).toBe('active-task')
    expect(() => Config({ privateMemoryRecall: 'on' } as never)).toThrowError()
    expect(() => Config({ privateMemoryRecall: 'captain-approved' } as never)).toThrowError()
  })
})
