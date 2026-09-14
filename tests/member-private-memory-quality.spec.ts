/**
 * M3 first slice — experience quality and recall impact (task-10).
 * tests-only RED over the CURRENT frozen implementation; the product stays
 * untouched until the host returns the CONTROL/RED receipt. Plan boundary:
 * docs/07-implementation-roadmap.md §4.1 @ f8e4046d (read-only).
 *
 * CONTRACT (declaration segment, as frozen and host-verified 77/77; the
 * evidence segment lives in member-private-memory-quality-real-composition):
 * - A v2 maintenance add/revise may carry an optional model DECLARED
 *   `claim`: { environment, version, outcome ∈ reported_pass |
 *   reported_failure | declared_observed | hypothesis, optional
 *   task_id/attempt_id }. These are DECLARATION tiers only: the Host
 *   write-time binding check (an explicit citation must match the Host's own
 *   observed attribution; omitted → no citation) proves PROVENANCE only,
 *   never a conclusion. There is NO `confirmed_*` tier and no path from
 *   repetition, self-report, agreement, accepted tasks or quotes to
 *   "verified" — promotion requires real host-checkable evidence authority,
 *   which this segment does not claim (the evidence segment adds verified
 *   EXISTENCE references only, never verified conclusions).
 * - Legacy v1/v2 notes without a claim stay readable as quality-UNKNOWN;
 *   nothing is invented as source or confidence.
 * - Recall impact (M2 score/order/budget EXACTLY unchanged): candidates
 *   collapse per ACTUAL condition key (exact content, canonical tags,
 *   applicability, declared environment/version — deliberately NOT the
 *   self-rating or any provenance, so restating a self-rating or re-citing
 *   a source never re-occupies slots nor raises a tier); the newest carrier
 *   wins, DIFFERENT real conditions stay separate knowledge.
 * - Render labels every note `data-quality="declared:<tier>|unverified"`
 *   plus `data-source="task:<id>|unknown"` (Host provenance only), the
 *   note's bounded `data-applicability` (beyond the fixed bound cut on a
 *   complete-codepoint prefix and marked `data-applicability-truncated=
 *   "list"` — the model must re-check via its own list tool), and the
 *   declared `data-environment`/`data-version`, all inside the absolute
 *   4096-byte bound; the word "confirmed" never appears.
 * - A quality change rides a revise/add operation that advances headSeq, so
 *   the existing final-delegation re-check must refuse a frozen request
 *   carrying the superseded version (real public-composition negative here,
 *   with the adapter zero-increment counted).
 * Control cases (C*) pass today and must keep passing; R-cases are RED.
 */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { afterEach, describe, expect, it } from 'vitest'
import { MemberPrivateMemoryStore, privateMemoryDomainSpec, type PrivateMemoryNote } from '../src/storage/member-private-memory.js'
import { RECALL_TOTAL_BYTES, selectRecallNotes, utf8Length, type RankedRecallNote, type RecallTaskText } from '../src/runtime/member-private-memory-recall-selection.js'
import { renderRecallContribution } from '../src/runtime/member-private-memory-recall-render.js'
import type { PrivateMemoryMaintenanceInput } from '../src/storage/member-private-memory-operations.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassiveAdapter, boundSetup, dispose, latestNamedContribution, memberRequests, mount, reentryOnce, runMemberTurn, snapshot, tool, type Mounted } from './helpers/private-memory-composition.js'
import { FaultableBackend } from './helpers/storage-stack.js'

const RECALL_NAME = 'agent-swarm:private-memory-recall'

interface QualityClaim {
  readonly environment: string
  readonly version: string
  /** DECLARED outcome tiers only — never a Host-verified conclusion. */
  readonly outcome: 'reported_pass' | 'reported_failure' | 'declared_observed' | 'hypothesis'
  readonly taskId?: string
  readonly attemptId?: string
}

/** Test-side contract input shapes: narrow intersections over the CURRENT
 *  public types (the fields land on them only with the minimal product
 *  change — nothing is hidden behind `as never`). */
type ClaimCandidate = RankedRecallNote & { readonly claim?: QualityClaim }
type ClaimNote = PrivateMemoryNote & { readonly claim?: QualityClaim }
type ClaimMaintenanceInput = PrivateMemoryMaintenanceInput & { readonly claim?: QualityClaim }

function candidate(memoryId: string, headSeq: number, content: string, applicability: string, tags?: string[], claim?: QualityClaim): ClaimCandidate {
  return {
    memoryId, headSeq, content,
    ...(tags === undefined ? {} : { tags }), applicability,
    tagHits: 0, applicabilityHits: 0, bodyHits: 2, score: 2,
    ...(claim === undefined ? {} : { claim }),
  }
}

const TASK: RecallTaskText = { subject: 'bind head cas', description: 'the recallprobe note informs selection', acceptanceCriteria: ['recallprobe evidence handled'] }
const CLAIM_BODY = 'recallprobe evidence handled wide cas'
const KEY = { environment: 'win-x64', version: 'node-24' } as const

type Media = Map<string, { tables: Map<string, Map<string, unknown>>; global: unknown }>

async function mountStore(media: Media): Promise<{ store: MemberPrivateMemoryStore; close(): Promise<void> }> {
  const ctx = new Context()
  const fibers: Fiber[] = []
  const backend = new FaultableBackend(media) // the SAME media map survives a full re-creation
  fibers.push(await ctx.plugin(Storage))
  ctx.storage.backend.register('faultable', backend)
  ctx.provide(storageBackendServiceKey('faultable'), backend)
  fibers.push(await ctx.plugin(StorageDomain, { backend: 'faultable' }))
  const domain = await ctx.storageDomain.open(privateMemoryDomainSpec)
  const store = new MemberPrivateMemoryStore(ctx, domain)
  return { store, close: async () => { store.close(); await domain.close(); for (const fiber of fibers.toReversed()) await fiber.dispose() } }
}

describe('M3 quality: declaration labels and condition-key duplicate suppression', () => {
  it('R1 same knowledge+conditions collapse to the newest carrier; restated self-ratings or re-cited provenance never re-occupy slots or raise a tier', () => {
    const claim = { ...KEY, outcome: 'declared_observed' } as const
    const picked = selectRecallNotes([
      // Fully identical knowledge + conditions (content, tags, applicability,
      // environment, version) → one carrier, newest headSeq.
      candidate('private-memory-1', 11, CLAIM_BODY, 'recallprobe selection', ['keep'], claim),
      candidate('private-memory-2', 12, CLAIM_BODY, 'recallprobe selection', ['keep'], claim),
      // Same text, DIFFERENT version condition → separate knowledge kept.
      candidate('private-memory-3', 13, CLAIM_BODY, 'recallprobe selection', ['keep'], { ...KEY, version: 'node-22', outcome: 'declared_observed' }),
      // Same text/conditions but different applicability → also separate.
      candidate('private-memory-4', 10, CLAIM_BODY, 'general', ['keep'], claim),
      // Shortest restatement premise (captain ②): SAME knowledge + same
      // real conditions, only a restated self-rating and a different Host
      // source — still duplicate knowledge: it collapses to THIS newest
      // carrier without any tier promotion.
      { ...candidate('private-memory-5', 14, CLAIM_BODY, 'recallprobe selection', ['keep'], { ...KEY, outcome: 'hypothesis' }), provenance: { kind: 'task', taskId: 'task-elsewhere' } },
    ], TASK)
    expect(picked.map(note => note.memoryId)).toEqual(['private-memory-5', 'private-memory-3', 'private-memory-4'])
    const text = renderRecallContribution({ taskId: 'task-1', attemptId: 'attempt-1' }, picked) ?? ''
    expect(text.match(/data-memory-id=/g)).toHaveLength(3)
    // Repetition never promotes: the carried tier is exactly the newest
    // declaration, still a DECLARATION.
    expect(text).toContain('data-quality="declared:hypothesis"')
    expect(text).not.toMatch(/confirmed/i)
    expect(utf8Length(text)).toBeLessThanOrEqual(RECALL_TOTAL_BYTES)
  })

  it('R2 notes are labeled by DECLARED tier, host-known source vs unknown source; quality stays unverified; no "confirmed" tier exists', () => {
    // Source is the HOST-observed provenance (host-derived durable field),
    // never the model-cited id — the frozen RED fixture is corrected to that
    // real Host input shape (the one fixture-semantics correction the
    // captain allowed); the RED itself (no labels in the current product)
    // is unchanged.
    const text = renderRecallContribution({ taskId: 'task-1', attemptId: 'attempt-1' }, [
      { ...candidate('private-memory-1', 5, `${CLAIM_BODY} one`, 'general', undefined, { ...KEY, outcome: 'reported_pass' }), provenance: { kind: 'task', taskId: 'task-9' } },
      candidate('private-memory-2', 4, `${CLAIM_BODY} two`, 'general'),
      candidate('private-memory-3', 3, `${CLAIM_BODY} three`, 'z'.repeat(200)),
    ]) ?? ''
    // Declared outcome + host-known provenance stay two separate facts.
    expect(text).toContain('data-quality="declared:reported-pass"')
    expect(text).toContain('data-source="task:task-9"')
    // Real conditions are readable per item: the note's own applicability
    // travels as a bounded attribute, so items kept by R1's same-key
    // distinction remain condition-distinguishable to the model.
    expect(text).toContain('data-applicability="general"')
    // Truncation is EXPLICIT (captain rule ⑦): a cut applicability carries
    // a marker telling the model to re-check its own list tool; short
    // applicability never shows the marker.
    expect(text).toContain('data-applicability-truncated="list"')
    const generalLine = text.split('<note ').find(entry => entry.includes('data-applicability="general"'))
    expect(generalLine).not.toContain('data-applicability-truncated')
    // No claim at all → unknown source AND unverified quality.
    expect(text).toContain('data-quality="unverified"')
    expect(text).toContain('data-source="unknown"')
    // Quality is NEVER presented as verified truth.
    expect(text).toContain('unverified')
    expect(text).not.toMatch(/confirmed/i)
  })

  it('C1 quality never reorders the fixed score/headSeq/memoryId selection [CONTROL — passes today]', () => {
    const picked = selectRecallNotes([
      candidate('private-memory-1', 4, `${CLAIM_BODY} second`, 'general', undefined, { ...KEY, outcome: 'reported_failure' }),
      candidate('private-memory-2', 5, `${CLAIM_BODY} first`, 'general'),
    ], TASK)
    expect(picked.map(note => note.memoryId)).toEqual(['private-memory-2', 'private-memory-1'])
  })
})

describe('M3 quality: durable claims, honest legacy, tool binding, late change', () => {
  const stores: Array<{ close(): Promise<void> }> = []
  const dirs: string[] = []
  const mountedList: Mounted[] = []
  afterEach(async () => {
    for (const mounted of stores.splice(0)) await mounted.close()
    for (const mounted of mountedList.splice(0)) await dispose(mounted)
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  it('R3 claims persist, survive a full store/domain re-creation over the same media, and legacy/plain notes are never upgraded', async () => {
    const media: Media = new Map()
    const mounted = await mountStore(media)
    stores.push(mounted)
    await mounted.store.append('s', 't', 'm', 'legacy body', []) // v1: unknown provenance/quality forever
    const claimInput: ClaimMaintenanceInput = {
      operation: 'add', operationId: 'op-c', content: 'claimed lane note', evidenceRefs: [], tags: ['keep'], applicability: 'general',
      claim: { ...KEY, outcome: 'reported_pass' },
    }
    await mounted.store.appendMaintenance('s', 't', 'm', claimInput, { kind: 'unattributed' }, undefined, write => write())
    await mounted.store.appendMaintenance('s', 't', 'm', {
      operation: 'add', operationId: 'op-plain', content: 'plain v2 note', evidenceRefs: [], tags: ['keep'], applicability: 'general',
    }, { kind: 'unattributed' }, undefined, write => write())
    const rows = mounted.store.recentActiveNotes('s', 't', 'm', 64) as readonly ClaimNote[]
    expect(rows.find(note => note.content === 'claimed lane note')?.claim).toEqual({ ...KEY, outcome: 'reported_pass' })
    // Honest unknowns: nothing is invented for the legacy or the plain note.
    for (const id of ['private-memory-1', 'private-memory-3']) {
      expect(rows.find(note => note.memoryId === id)?.claim).toBeUndefined()
    }
    // NOTE (honest layer): this is a store/domain re-creation over the SAME
    // in-memory media — durable read-back evidence, NOT a cross-process
    // real-Profile cold recovery (the controller measures that on the real
    // scenario later).
    await mounted.close()
    const reopened = await mountStore(media)
    stores.push(reopened)
    const again = reopened.store.recentActiveNotes('s', 't', 'm', 64) as readonly ClaimNote[]
    expect(again.find(note => note.content === 'claimed lane note')?.claim).toEqual({ ...KEY, outcome: 'reported_pass' })
    expect(again.find(note => note.memoryId === 'private-memory-1')?.claim).toBeUndefined()
  }, 60_000)

  it('R4 the tool face accepts a complete legal payload with an OWN observed binding and rejects a foreign task', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-quality-bind-'))
    dirs.push(sandbox)
    const mounted = await mount(sandbox, { privateMemoryRecall: 'active-task' })
    mountedList.push(mounted)
    const adapter = new PassiveAdapter()
    mounted.ctx.llm.registerAdapter(['mock'], adapter)
    const { setup, resolved, note } = await boundSetup(mounted, 'qualbind', join(sandbox, 'workspace'))
    const board = await snapshot(mounted.ctx, setup.lead, setup.teamId)
    const claimed = board.team.tasks.find(row => row.ownerSessionId === setup.memberId && row.status === 'in_progress')
    expect(claimed, 'premise: the member owns the in-progress task').toBeDefined()
    // Foreign binding rejected — paired with the OWN positive below.
    // Honest layer: today an unknown field may fail with the field name in
    // the message; this pairing only shows the FUTURE distinction, never
    // claims that source-of-truth validation is proven by rejection alone.
    const forged = await tool(mounted.ctx, resolved.agent, 'q-forged', 'agent_swarm_maintain_private_memory', {
      operation: 'add', operation_id: 'op-forged', content: 'recallprobe lesson forged',
      evidence_refs: [], tags: ['recallprobe'], applicability: 'recallprobe selection',
      claim: { environment: 'win-x64', version: 'node-24', outcome: 'declared_observed', task_id: 'task-does-not-exist' },
    })
    expect(forged.isError, 'a foreign/unknown task binding must be rejected').toBe(true)
    // The member's OWN real task/attempt binding is accepted — provenance
    // only; the note remains a DECLARATION, never trusted truth.
    const own = await tool(mounted.ctx, resolved.agent, 'q-own', 'agent_swarm_maintain_private_memory', {
      operation: 'add', operation_id: 'op-own', content: 'recallprobe lesson observed',
      evidence_refs: [], tags: ['recallprobe'], applicability: 'recallprobe selection',
      claim: { environment: 'win-x64', version: 'node-24', outcome: 'declared_observed', task_id: claimed!.id, attempt_id: claimed!.currentAttemptId },
    })
    expect(own.isError, 'a real own task/attempt binding must be accepted').toBe(false)
    await runMemberTurn(resolved.agent, 'recallprobe selection exercise turn')
    const recalled = latestNamedContribution(memberRequests(adapter, setup.memberId).at(-1)!.options, RECALL_NAME)
    expect(recalled, 'premise: the current selection carries a named contribution').toContain(`data-memory-id="${note.memoryId}"`)
    expect(recalled).toContain('data-quality=')
    expect(recalled).not.toMatch(/confirmed/i)
  }, 90_000)

  it('R5 a quality revise advances headSeq so the frozen named request is refused with zero adapter increment', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-quality-late-'))
    dirs.push(sandbox)
    const mounted = await mount(sandbox, { privateMemoryRecall: 'active-task' })
    mountedList.push(mounted)
    const adapter = new PassiveAdapter()
    mounted.ctx.llm.registerAdapter(['mock'], adapter)
    const { setup, resolved, note } = await boundSetup(mounted, 'quallate', join(sandbox, 'workspace'))
    await runMemberTurn(resolved.agent, 'recallprobe selection exercise turn')
    const frozen = memberRequests(adapter, setup.memberId).at(-1)!.options
    expect(latestNamedContribution(frozen, RECALL_NAME), 'premise: the note is recalled').toContain(`data-memory-id="${note.memoryId}"`)
    // Quality change through the member's real tool face (full legal
    // replacement payload carrying the new claim).
    const revised = await tool(mounted.ctx, resolved.agent, 'q-revise', 'agent_swarm_maintain_private_memory', {
      operation: 'revise', operation_id: 'op-revise', target_memory_id: note.memoryId, expected_head_seq: note.headSeq,
      content: 'recallprobe lesson: bind head CAS to the newest operation seq (revised claim)',
      evidence_refs: [], tags: ['recallprobe'], applicability: 'recallprobe selection',
      claim: { environment: 'win-x64', version: 'node-24', outcome: 'reported_failure' },
    })
    // Contract premise: the claim-carrying revise itself must succeed;
    // under the CURRENT product this fails as an unknown field — that is
    // this case's first RED step, not a claim about the guard itself.
    expect(revised.isError, 'the quality revise must succeed').toBe(false)
    const before = memberRequests(adapter, setup.memberId).length
    expect((await reentryOnce(mounted.ctx, frozen)).threw, 'the superseded frozen contribution must refuse').toBe(true)
    expect(memberRequests(adapter, setup.memberId).length, 'refusal never reaches the adapter').toBe(before)
  }, 90_000)
})
