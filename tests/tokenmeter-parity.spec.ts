/**
 * M4-1 (issue #127): official tokenMeter / Team ledger parity — the Option B
 * boundary proof.
 *
 * Both accounting faces fold the SAME live session event stream in one real
 * composition: the official `tokenUsage` projection (the real `SessionStore` +
 * `SessionProjectionRegistry` + `TokenMeter` plugins — fold semantics verified
 * identical at rc.8 and 0.1.1-rc.2, docs/09 §1 M4-1 — driven eagerly by
 * the registry's `session/event` subscription) and the plugin's cumulative
 * Team budget ledger (the real storage stack with `UsageAccountant` wired to
 * the same firehose, exactly like plugin activation does). The specs pin the
 * accounting boundary defined in docs/04-core-protocol.md:
 *
 * - numeric equality on every log shape where the faces are defined to agree
 *   (usage chunk superseded by the final message usage — equal or corrective —
 *   and an aborted turn's usage-bearing message), with the M1B cursor keeping
 *   replayed observation free (exactly-once, the red-line semantics);
 * - the one declared divergence: a provider usage chunk whose request failed
 *   before any usage-bearing assistant message bills on the official face and
 *   deliberately does not bill the Team ledger;
 * - the read-model split inside the official package itself: `measure()` is
 *   current-surface pressure (moves on non-usage surface growth) while
 *   `tokenUsage` is the cumulative fold (does not), so neither official face
 *   can replace the ledger's job.
 *
 * The official packages are devDependency-only evidence consumers here: this
 * spec is the cross-check, not a runtime integration (the boundary decision).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { createMessage, type TokenUsage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TeamDomain } from '../src/domain/team-domain.js'
import type { TeamDomainPort } from '../src/domain/team-domain-port.js'
import { TeamId } from '../src/domain/types.js'
import { UsageAccountant } from '../src/runtime/usage-accounting.js'
import { StorageDomainTeamStore } from '../src/storage/storage-domain-team-store.js'
import { teamDomainSpec } from '../src/storage/team-spec.js'
import { mountStorageStackOn } from './helpers/storage-stack.js'

const WORKSPACE = 'D:/issue-127/workspace'
const SCOPE = resolve(WORKSPACE)

/** Sum of the official projection's disjoint buckets — the comparable total. */
function bucketSum(usage: TokenUsageProjection): number {
  return usage.uncachedInputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

/** The same disjoint-bucket sum the plugin ledger bills for one usage event. */
function billed(usage: TokenUsage): number {
  return usage.inputTokens
    + usage.outputTokens
    + (usage.cacheReadTokens ?? 0)
    + (usage.cacheWriteTokens ?? 0)
}

describe('official tokenUsage projection versus the Team ledger (issue #127 boundary)', () => {
  let sandbox: string
  let ctx: Context
  let fibers: Fiber[]
  let domain: TeamDomainPort
  let store: StorageDomainTeamStore
  let openedDomain: Awaited<ReturnType<Context['storageDomain']['open']>>
  let accountant: UsageAccountant
  let detachFirehose: () => void

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'dsh-tokenmeter-parity-'))
    ctx = new Context()
    fibers = []
    fibers.push(await ctx.plugin(SessionStore))
    fibers.push(await ctx.plugin(SessionProjectionRegistry))
    fibers.push(await ctx.plugin(TokenMeter))
    await mountStorageStackOn(ctx, join(sandbox, 'storage'))
    openedDomain = await ctx.storageDomain.open(teamDomainSpec)
    store = new StorageDomainTeamStore(ctx, openedDomain)
    domain = new TeamDomain(store)
    accountant = new UsageAccountant(ctx, {
      domain: () => domain,
      isClosing: () => false,
      agents: { get: () => undefined },
      history: async () => undefined,
    })
    // The same wiring plugin activation installs: one firehose observer
    // feeding the single Team measurement path.
    detachFirehose = ctx.on('session/event', (session, event) => {
      accountant.observeSessionEvent(session, event)
    })
  })

  afterEach(async () => {
    detachFirehose()
    await accountant.wait()
    await store.close()
    await openedDomain.close()
    for (const fiber of fibers.toReversed()) await fiber.dispose()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  /** One legal usage step: chunk sample superseded by the final message usage. */
  function billedStep(session: Session, turn: number, step: number, chunk: TokenUsage, final: TokenUsage): void {
    session.append('step/start', { turn, step })
    const source = session.append('assistant/chunk', {
      turn,
      step,
      chunk: { type: 'usage', usage: chunk },
    }).seq
    session.append('assistant/message', {
      turn,
      step,
      message: createMessage({
        role: 'assistant',
        content: [],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
      usage: final,
    }, { surfaceOp: 'append', sourceEventSeqs: [source] })
    session.append('step/end', { turn, step })
  }

  /** An aborted turn's partial content: the message carries usage, no chunk. */
  function interruptedStep(session: Session, turn: number, step: number, final: TokenUsage): void {
    session.append('step/start', { turn, step })
    session.append('assistant/message', {
      turn,
      step,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'partial answer before the interrupt' }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
      usage: final,
      interrupted: true,
    }, { surfaceOp: 'append', sourceEventSeqs: [] })
    session.append('step/end', { turn, step })
  }

  /** A failed request: the provider usage chunk landed, no message followed. */
  function failedRequestStep(session: Session, turn: number, step: number, chunk: TokenUsage): void {
    session.append('step/start', { turn, step })
    session.append('assistant/chunk', {
      turn,
      step,
      chunk: { type: 'usage', usage: chunk },
    })
    session.append('step/end', { turn, step })
  }

  function officialTotal(session: Session): number {
    const value = ctx.sessionProjections.snapshot(session).values.tokenUsage
    if (value === undefined) throw new Error('tokenUsage projection is not registered')
    return bucketSum(value)
  }

  async function teamUsedTokens(teamId: string): Promise<number> {
    const snapshot = await domain.snapshot(SCOPE, TeamId(teamId), captainId)
    return snapshot.team.budget.usedTokens
  }

  let captainId: string

  async function rosterSessions(): Promise<{ captain: Session; member: Session; teamId: string }> {
    const captain = ctx.sessions.create(SessionId('parity-captain'), { meta: { cwd: WORKSPACE } })
    const member = ctx.sessions.create(SessionId('parity-member'), { meta: { cwd: WORKSPACE } })
    captainId = captain.id
    const teamId = (await domain.createTeam(SCOPE, captain.id, 'Parity team', 'issue #127')).id
    await domain.provisionMember(SCOPE, teamId, captain.id, {
      name: 'parity-worker',
      role: 'bills the same stream',
      sessionId: member.id,
      provider: 'spawn',
    })
    return { captain, member, teamId }
  }

  it('equals the official projection across a roster, and replayed observation stays free', async () => {
    const { captain, member, teamId } = await rosterSessions()
    const captainSteps: TokenUsage[] = [
      { inputTokens: 120, outputTokens: 30, cacheReadTokens: 400, cacheWriteTokens: 50 },
      { inputTokens: 90, outputTokens: 12 },
      { inputTokens: 7, outputTokens: 5, cacheWriteTokens: 3 },
    ]
    const memberSteps: TokenUsage[] = [
      { inputTokens: 200, outputTokens: 45, cacheReadTokens: 600 },
      { inputTokens: 15, outputTokens: 9, cacheReadTokens: 2, cacheWriteTokens: 8 },
    ]
    captainSteps.forEach((usage, index) => billedStep(captain, 1, index + 1, usage, usage))
    memberSteps.forEach((usage, index) => billedStep(member, 1, index + 1, usage, usage))

    await accountant.wait()

    const expected = [...captainSteps, ...memberSteps].reduce((total, usage) => total + billed(usage), 0)
    expect(officialTotal(captain)).toBe(captainSteps.reduce((total, usage) => total + billed(usage), 0))
    expect(officialTotal(member)).toBe(memberSteps.reduce((total, usage) => total + billed(usage), 0))
    await expect(teamUsedTokens(teamId)).resolves.toBe(expected)
    expect(officialTotal(captain) + officialTotal(member)).toBe(expected)

    // The official fold is a pure function of the durable log: reading again
    // changes nothing on either face.
    expect(officialTotal(captain) + officialTotal(member)).toBe(expected)
    await expect(teamUsedTokens(teamId)).resolves.toBe(expected)

    // Replay the whole firehose at the ledger (the M1B cursor contract): every
    // event seq is already folded, so the exactly-once cursor skips them all.
    for (const session of [captain, member]) {
      for (const event of session.events) accountant.observeSessionEvent(session, event)
    }
    await accountant.wait()
    await expect(teamUsedTokens(teamId)).resolves.toBe(expected)
  })

  it('equals the official projection when the final message corrects the chunk sample', async () => {
    const { captain, member, teamId } = await rosterSessions()
    // Chunk reported (50, 10); the final assistant message corrected it to
    // (40, 8). The official fold REPLACES the sample (README: "a final
    // assistant-message usage for the same (turn, step) replaces that sample
    // instead of double-counting it"); the ledger only ever saw the message.
    billedStep(captain, 1, 1, { inputTokens: 50, outputTokens: 10 }, { inputTokens: 40, outputTokens: 8 })
    await accountant.wait()

    expect(officialTotal(captain)).toBe(48)
    await expect(teamUsedTokens(teamId)).resolves.toBe(48)
    expect(officialTotal(member)).toBe(0)
  })

  it('equals the official projection for an aborted turn whose partial content carries usage', async () => {
    const { captain, teamId } = await rosterSessions()
    // The #92-registered official shape: an aborted turn still appends its
    // assistant message WITH usage whenever partial content was assembled.
    interruptedStep(captain, 1, 1, { inputTokens: 64, outputTokens: 17 })
    await accountant.wait()

    expect(officialTotal(captain)).toBe(81)
    await expect(teamUsedTokens(teamId)).resolves.toBe(81)
  })

  it('pins the declared divergence: a failed request bills officially, never the Team ledger', async () => {
    const { captain, teamId } = await rosterSessions()
    const settled: TokenUsage = { inputTokens: 30, outputTokens: 6 }
    billedStep(captain, 1, 1, settled, settled)
    // The request failed after its provider usage chunk: zero content was
    // assembled, so no usage-bearing assistant message exists. The official
    // projection deliberately counts the surviving chunk sample ("usage
    // chunks are counted even when a request later fails"); the Team ledger
    // bills only committed assistant-message usage — the boundary decision.
    const failed: TokenUsage = { inputTokens: 500, outputTokens: 0, cacheReadTokens: 70 }
    failedRequestStep(captain, 1, 2, failed)
    await accountant.wait()

    expect(officialTotal(captain)).toBe(billed(settled) + billed(failed))
    await expect(teamUsedTokens(teamId)).resolves.toBe(billed(settled))
    // A reload-time refold over the same durable log cannot change either
    // number: both faces are pure folds of the committed events.
    for (const event of captain.events) accountant.observeSessionEvent(captain, event)
    await accountant.wait()
    await expect(teamUsedTokens(teamId)).resolves.toBe(billed(settled))
    expect(officialTotal(captain)).toBe(billed(settled) + billed(failed))
  })

  it('splits the official read models: measure() is current pressure, not a cumulative ledger', async () => {
    const { captain, teamId } = await rosterSessions()
    const settled: TokenUsage = { inputTokens: 11, outputTokens: 6 }
    billedStep(captain, 1, 1, settled, settled)
    await accountant.wait()
    const cumulative = billed(settled)
    expect(officialTotal(captain)).toBe(cumulative)
    await expect(teamUsedTokens(teamId)).resolves.toBe(cumulative)

    const before = ctx.tokenMeter.measure(captain)
    expect(before.logRevision).toBe(captain.events.length)
    // Surface growth without any usage event: the cumulative faces hold
    // still (the projection is usage-driven; the Team ledger saw no message
    // usage), while measure() reprices the CURRENT surface — the read-model
    // fact that keeps request-pressure metering off the budget path.
    captain.append('user/message', createMessage({
      role: 'user',
      content: [{ type: 'text', text: 'grow the surface without billing anything' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const after = ctx.tokenMeter.measure(captain)

    expect(after.surfaceTokens).toBeGreaterThan(before.surfaceTokens)
    expect(after.logRevision).toBe(captain.events.length)
    expect(officialTotal(captain)).toBe(cumulative)
    await expect(teamUsedTokens(teamId)).resolves.toBe(cumulative)
  })
})
