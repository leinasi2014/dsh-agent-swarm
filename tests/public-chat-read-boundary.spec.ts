/**
 * C1 read-surface boundary pins (captured defects, docs/04 §8.6):
 * P1 — an over-budget page never dead-ends: single or consecutive entries
 *      larger than max_bytes come back as locatable headers whose public ids
 *      the exact-ID reader resolves in full.
 * P2 — the byte budget is verified against the final serialized artifact in
 *      BOTH boolean flag states at the exact critical boundary.
 * P3 — reads bind the real runtime close signal: once dispose has begun but
 *      the store is still open, an in-flight or new read is refused with
 *      TEAM_RUNTIME_CLOSING rather than returning a page.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { expect, it } from 'vitest'
import { createPublicChatReadSurface } from '../src/runtime/public-chat-read.js'
import { TeamDomainError } from '../src/domain/error.js'
import type { TeamDomainPort } from '../src/domain/team-domain-port.js'
import type { TeamPublicMessage } from '../src/domain/public-message.js'
import { withLiveChild } from './helpers/live-child.js'
import { RESTART_SIGNAL as SIGNAL, restartTool as tool } from './helpers/restart-real-composition.js'
import { Recording, setup, createTeam, addPublicMembers } from './helpers/public-chat-real-composition.js'

const CLOSING_TEXT = '预'.repeat(500) // 1500 UTF-8 bytes: above the 1024 floor

function v1Row(id: string, sequence: number, text: string, sessionId = 'member-x'): TeamPublicMessage {
  return {
    id, sequence, createdAt: 1, author: { kind: 'agent', sessionId, role: 'member', name: 'x' }, text,
    requestId: `r-${sequence}`, bindingDigest: `sha256:${'0'.repeat(64)}`, delivery: { state: 'not-requested' },
  } as unknown as TeamPublicMessage
}

/** Pure surface over a stub store: byte decisions and close checks are exact. */
function harness(
  messages: readonly TeamPublicMessage[],
  controller: AbortController,
  abortOnSecondMembership = false,
  abortOnPageTouch = false,
  membershipEvents: readonly (undefined | 'revoke' | 'rotate')[] = [],
) {
  const member = { id: 'member-x', session: { header: {} } } as unknown as Agent
  const ctx = {
    agents: new Map([[member.id, member]]), sessions: new Map([[member.id, member.session]]),
  } as unknown as Context
  let calls = 0
  let revoked = false
  const team = {
    id: 'team-x', captainSessionId: 'cap-x', revision: 1,
    get publicChat() {
      if (abortOnPageTouch) controller.abort(new Error('dispose began before the return'))
      return { messages }
    },
  }
  const port = {
    requireMembership: async () => {
      calls += 1
      if (abortOnSecondMembership && calls === 2) controller.abort(new Error('dispose began between IOs'))
      const event = membershipEvents[calls - 1]
      // Revocation is durable once committed: every LATER call must also see
      // the member gone (fixture fidelity per host round 14:41).
      if (event === 'revoke') revoked = true
      if (revoked) throw new TeamDomainError('No active membership in that scope', 'TEAM_NOT_JOINED')
      // QA pin: the aggregate may rotate between the two reads.
      if (event === 'rotate') return { team: { ...team, id: 'team-other', captainSessionId: 'cap-other' } }
      return { team }
    },
  } as unknown as TeamDomainPort
  const surface = createPublicChatReadSurface({ ctx, domain: () => port, scopeOf: () => 'scope-x' as never, closingSignal: () => controller.signal })
  return { surface, member, calls: () => calls }
}

it('P1: over-budget pages keep locatable public ids for single and consecutive oversized entries', async () => {
  const controller = new AbortController()
  const one = v1Row('public-11111111-1111-4111-8111-111111111111', 1, CLOSING_TEXT)
  const two = v1Row('public-22222222-2222-4222-8222-222222222222', 2, CLOSING_TEXT)
  for (const messages of [[one], [one, two]]) {
    const { surface, member } = harness(messages, controller)
    const page = await surface.history({ signal: new AbortController().signal, agent: member }, { limit: 10, maxBytes: 1_024 })
    expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(1_024)
    expect(page.truncated_by_bytes).toBe(true)
    expect(page.entries.length).toBeGreaterThan(0)
    expect(page.entries.every(row => row.text === '' && row.text_omitted_by_bytes === true && row.text_total === [...CLOSING_TEXT].length)).toBe(true)
    expect(page.entries.map(row => row.message_id)).toEqual(messages.map(row => row.id))
    for (const row of page.entries) {
      const full = await surface.message({ signal: new AbortController().signal, agent: member }, { messageId: row.message_id, offset: 0, maxChars: 20_000 })
      expect(full.text).toBe(CLOSING_TEXT)
      expect(full.complete).toBe(true)
    }
  }
})

it('P2: the budget is enforced against the exact final artifact in both flag states at the boundary', async () => {
  const controller = new AbortController()
  const messages = [
    v1Row('public-33333333-3333-4333-8333-333333333333', 1, '甲'.repeat(120)),
    v1Row('public-44444444-4444-4444-8444-444444444444', 2, '乙'.repeat(120)),
  ]
  const { surface, member } = harness(messages, controller)
  const exec = { signal: new AbortController().signal, agent: member }
  const wide = await surface.history(exec, { limit: 10, maxBytes: 65_536 })
  expect(wide.truncated_by_bytes).toBe(false)
  const exact = Buffer.byteLength(JSON.stringify(wide), 'utf8')

  // Critical budget with the complete page (flag false): accepted unchanged.
  const at = await surface.history(exec, { limit: 10, maxBytes: exact })
  expect(at).toEqual(wide)
  expect(Buffer.byteLength(JSON.stringify(at), 'utf8')).toBe(exact)

  // One byte tighter: the untrimmed artifact would exceed, so the surface
  // must switch to the trimmed representation and fit within budget-1.
  const under = await surface.history(exec, { limit: 10, maxBytes: exact - 1 })
  expect(under.truncated_by_bytes).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(under), 'utf8')).toBeLessThanOrEqual(exact - 1)
  expect(under.entries.length).toBeGreaterThan(0) // never a dead end (P1)
})

it('P3: the real runtime close signal refuses reads after dispose begins while the store is still open', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-public-read-close-'))
  const f = await setup(sandbox, new Recording(), false)
  let disposing: Promise<unknown> | undefined
  try {
    const { root, captain } = await createTeam(f, sandbox)
    const memberIds = await addPublicMembers(f, root, captain.id)
    const alphaId = memberIds[0]!
    await withLiveChild(f.ctx, root, captain.id, SIGNAL, async liveCaptain => {
      await withLiveChild(f.ctx, liveCaptain, alphaId, SIGNAL, async alphaLive => {
        expect((await tool(f.ctx, alphaLive, 'close-preflight', 'agent_swarm_public_history', {})).isError).toBe(false)
        // Begin real disposal synchronously: closingSignal aborts at dispose
        // entry, while store close only happens after many awaits (drain,
        // waits) — this is exactly the window in which reads must be refused.
        // The promise is awaited only after the maintenance leases exit, so
        // dispose's child drain never serializes behind this test's own lease.
        disposing = f.ctx.agentSwarm.dispose().catch(() => undefined)
        expect(f.ctx.agentSwarm.closingSignal.aborted).toBe(true)
        const refused = await tool(f.ctx, alphaLive, 'close-race-read', 'agent_swarm_public_history', {})
        expect(refused.isError).toBe(true)
        expect(refused.error).toMatchObject({ info: { code: 'TEAM_RUNTIME_CLOSING' } })
        const refusedMessage = await tool(f.ctx, alphaLive, 'close-race-exact', 'agent_swarm_public_message', { message_id: 'public-00000000-0000-4000-8000-000000000000' })
        expect(refusedMessage.error).toMatchObject({ info: { code: 'TEAM_RUNTIME_CLOSING' } })
      })
    })
  } finally {
    await disposing
    await f.close().catch(() => undefined)
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 40_000)

it('P3b: the close signal is enforced before IO, after IO, and before returning a fully read page', async () => {
  const messages = [v1Row('public-55555555-5555-4555-8555-555555555555', 1, '公开原文')]

  // Before IO: already disposed => zero store touches.
  const pre = new AbortController()
  pre.abort(new Error('dispose began before the read'))
  const preHarness = harness(messages, pre)
  await expect(preHarness.surface.history({ signal: new AbortController().signal, agent: preHarness.member }, { limit: 10, maxBytes: 32_768 }))
    .rejects.toMatchObject({ code: 'TEAM_RUNTIME_CLOSING' })
  expect(preHarness.calls()).toBe(0)

  // After IO: close begins exactly between the two membership reads, on the
  // harness's exact registered member identity.
  const mid = new AbortController()
  const midHarness = harness(messages, mid, true)
  await expect(midHarness.surface.history({ signal: new AbortController().signal, agent: midHarness.member }, { limit: 10, maxBytes: 32_768 }))
    .rejects.toMatchObject({ code: 'TEAM_RUNTIME_CLOSING' })
  expect(midHarness.calls()).toBe(2)

  // Before returning: all IO finished; touching the page flips the signal.
  const late = new AbortController()
  const lateHarness = harness(messages, late, false, true)
  await expect(lateHarness.surface.history({ signal: new AbortController().signal, agent: lateHarness.member }, { limit: 10, maxBytes: 32_768 }))
    .rejects.toMatchObject({ code: 'TEAM_RUNTIME_CLOSING' })

  // The executing tool call's own abort is honored independently.
  const dead = new AbortController()
  dead.abort(new Error('tool call cancelled'))
  const okHarness = harness(messages, new AbortController())
  await expect(okHarness.surface.message({ signal: dead.signal, agent: okHarness.member }, { messageId: messages[0]!.id, offset: 0, maxChars: 100 }))
    .rejects.toThrow('tool call cancelled')
})

/**
 * Budget pagination must never skip or repeat messages. Direction contract:
 * default/before pages keep the NEWEST end of the fitted window (a backward
 * reader continues at before_sequence = first_sequence without losing the
 * newer part of the requested window), after pages keep the EARLIEST end,
 * and has_earlier/has_more are recomputed from the final kept range — a
 * header-only page whose text merely awaits exact-id reads must never be
 * reported as a continuation page.
 */
const BUDGET_TEXT = '补'.repeat(250)
function budgetRows(count: number, versions: readonly (1 | 2 | 3)[] = [1]) {
  return Array.from({ length: count }, (_, index) => {
    const base = v1Row(`public-${String(index + 1).padStart(8, '0')}-0000-4000-8000-000000000000`, index + 1, BUDGET_TEXT)
    // Mixed wire versions share one ascending sequence space (QA pin).
    const version = versions[index % versions.length]!
    if (version === 1) return base
    const content = [{ type: 'text' as const, text: BUDGET_TEXT }]
    return { ...base, formatVersion: version, content, ...(version === 2 ? { mentionLabels: [] } : {}) } as unknown as typeof base
  })
}

it('P4: default and before pages keep the newest end; a backward drain sees every message exactly once', async () => {
  const controller = new AbortController()
  const rows = budgetRows(8, [1, 2, 3, 1, 2, 3, 1, 2])
  const { surface, member } = harness(rows, controller)
  const exec = { signal: new AbortController().signal, agent: member }

  const first = await surface.history(exec, { limit: 50, maxBytes: 4_096 })
  expect(first.truncated_by_bytes).toBe(true)
  expect(first.entries.length).toBeGreaterThan(0)
  expect(first.entries.length).toBeLessThan(rows.length)
  // The requested default window ends at the newest message; budget pressure
  // may drop OLDER part of the window, never the newest one.
  expect(first.last_sequence).toBe(rows.length)
  expect(first.has_more).toBe(false)
  expect(first.has_earlier).toBe(true)

  const seen = first.entries.map(row => row.sequence)
  let cursor = first.first_sequence!
  for (let guard = 0; guard < 20; guard += 1) {
    const page = await surface.history(exec, { limit: 50, maxBytes: 4_096, beforeSequence: cursor })
    expect(page.entries.length).toBeGreaterThan(0)
    expect(page.last_sequence).toBe(cursor - 1)
    seen.push(...page.entries.map(row => row.sequence))
    if (!page.has_earlier) break
    cursor = page.first_sequence!
  }
  expect(seen.toSorted((a, b) => a - b)).toEqual(rows.map(row => row.sequence))
  expect(new Set(seen).size).toBe(seen.length)
})

it('P5: after pages keep the earliest end; a forward drain sees every newer message exactly once', async () => {
  const controller = new AbortController()
  const rows = budgetRows(8)
  const { surface, member } = harness(rows, controller)
  const exec = { signal: new AbortController().signal, agent: member }

  const seen: number[] = []
  let cursor = 1
  for (let guard = 0; guard < 20; guard += 1) {
    const page = await surface.history(exec, { limit: 50, maxBytes: 4_096, afterSequence: cursor })
    expect(page.entries.length).toBeGreaterThan(0)
    expect(page.entries[0]!.sequence).toBe(cursor + 1)
    seen.push(...page.entries.map(row => row.sequence))
    if (!page.has_more) break
    cursor = page.last_sequence!
  }
  expect(seen.toSorted((a, b) => a - b)).toEqual(rows.slice(1).map(row => row.sequence))
  expect(new Set(seen).size).toBe(seen.length)
})

it('P6: header fallback keeps the newest ids, never claims a continuation page, and a header drain stays exact', async () => {
  const controller = new AbortController()
  const rows = budgetRows(5).map(row => ({ ...row, text: CLOSING_TEXT }))
  const { surface, member } = harness(rows, controller)
  const exec = { signal: new AbortController().signal, agent: member }

  // A lone oversized message is a dead end BY CONTENT COMPLETENESS, not by
  // pagination: it is locatable, and no continuation page exists. The lone
  // page is read through the harness's own registered Agent (the live-Session
  // guard rejects foreign identities — by design).
  const lone = harness([rows[0]!], controller)
  const loneExec = { signal: new AbortController().signal, agent: lone.member }
  const single = await lone.surface.history(loneExec, { limit: 10, maxBytes: 1_024 })
  expect(single).toMatchObject({ entries: [{ sequence: 1, text: '', text_omitted_by_bytes: true }], returned_count: 1, truncated_by_bytes: true })
  expect(single.has_more).toBe(false)
  expect(single.has_earlier).toBe(false)
  expect((await lone.surface.message(loneExec, { messageId: rows[0]!.id, offset: 0, maxChars: 20_000 })).text).toBe(CLOSING_TEXT)

  // Many oversized rows: the fitted headers are a contiguous NEWEST suffix,
  // has_more stays false, and before-continuation covers every id exactly once.
  const first = await surface.history(exec, { limit: 50, maxBytes: 1_024 })
  expect(first.truncated_by_bytes).toBe(true)
  expect(first.entries.length).toBeLessThan(rows.length)
  expect(first.entries.at(-1)!.sequence).toBe(rows.length)
  expect(first.has_more).toBe(false)
  expect(first.has_earlier).toBe(true)
  const seen = first.entries.map(row => row.sequence)
  let cursor = first.first_sequence!
  for (let guard = 0; guard < 20; guard += 1) {
    const page = await surface.history(exec, { limit: 50, maxBytes: 1_024, beforeSequence: cursor })
    expect(page.entries.length).toBeGreaterThan(0)
    expect(page.last_sequence).toBe(cursor - 1)
    seen.push(...page.entries.map(row => row.sequence))
    if (!page.has_earlier) break
    cursor = page.first_sequence!
  }
  expect(seen.toSorted((a, b) => a - b)).toEqual(rows.map(row => row.sequence))
  expect(new Set(seen).size).toBe(seen.length)
})

// Surface-boundary membership contract pins with a STICKY revocation fixture
// (revocation is durable: later calls keep rejecting). Corrected per QA's
// retraction and the 14:5x precheck: real-Store linearization evidence lives
// in public-chat-read-race.spec.ts (KV durable + final settle stamps); the
// durable-revocation delivery semantics remain Root's open decision — no
// verdict is claimed here.
it('P7: membership revocation or Team rotation at any read stage never returns a page', async () => {
  const messages = [v1Row('public-88888888-8888-4888-8888-888888888888', 1, '公开原文')]
  const ok = new AbortController()

  // Commit lands before the read: the first IO itself rejects; nothing is read.
  const early = harness(messages, ok, false, false, ['revoke'])
  await expect(early.surface.history({ signal: new AbortController().signal, agent: early.member }, { limit: 10, maxBytes: 32_768 }))
    .rejects.toMatchObject({ code: 'TEAM_NOT_JOINED' })
  expect(early.calls()).toBe(1)

  // Revocation queues between the two membership reads: the second IO rejects
  // and stays rejected (durable) for every later call, including the exact-ID
  // reader — three total store touches (read ok, read reject, message reject).
  const mid = harness(messages, ok, false, false, [undefined, 'revoke'])
  await expect(mid.surface.history({ signal: new AbortController().signal, agent: mid.member }, { limit: 10, maxBytes: 32_768 }))
    .rejects.toMatchObject({ code: 'TEAM_NOT_JOINED' })
  await expect(mid.surface.message({ signal: new AbortController().signal, agent: mid.member }, { messageId: messages[0]!.id, offset: 0, maxChars: 100 }))
    .rejects.toMatchObject({ code: 'TEAM_NOT_JOINED' })
  expect(mid.calls()).toBe(3)

  // Adversarial rotation: the same live Agent now resolves to another Team
  // binding mid-read; the page is discarded as a target change, not returned.
  const rotated = harness(messages, ok, false, false, [undefined, 'rotate'])
  await expect(rotated.surface.history({ signal: new AbortController().signal, agent: rotated.member }, { limit: 10, maxBytes: 32_768 }))
    .rejects.toMatchObject({ code: 'TEAM_PUBLIC_DELIVERY_MISMATCH' })
})
