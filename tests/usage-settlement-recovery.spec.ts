/**
 * Billing settlement loss faces and the recovery net (issue #92).
 *
 * The permanent billed-token gap (composition `usedTokens` stuck one usage
 * event below the adapter's truth across the whole settle window) is not an
 * event-order defect: the official firehose publishes per-session events
 * synchronously in seq order and every writer here submits contiguous
 * suffixes above its cursor, so replay and reorder stay exactly-once at the
 * fold. The proven loss faces were (a) a flush resolving membership through
 * the authority-facing active-phase-only lookup — a member's first turn
 * bills while its roster row is still `provisioning`, so the flush silently
 * discarded the entries — and (b) usage appended during runtime disposal
 * being dropped at the accountant's entry gate with no reload-time fold to
 * heal it. These specs pin the fixes: billing-side membership resolution,
 * closing-time folding, the activation roster recovery net, and the
 * unchanged reorder/replay idempotency of the seq cursor.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { UsageAccountant } from '../src/runtime/usage-accounting.js'
import { TeamDomain } from '../src/domain/team-domain.js'
import type { TeamScope } from '../src/domain/team-domain-port.js'
import type { TeamId } from '../src/domain/types.js'
import { openStorageStack, type StorageStack } from './helpers/storage-stack.js'

const WORKSPACE = 'D:\\issue-92\\workspace'

function usageEvent(seq: number, tokens: number): SessionEvent {
  return {
    type: 'assistant/message',
    seq,
    time: 0,
    data: { usage: { inputTokens: tokens, outputTokens: 0 } },
  } as unknown as SessionEvent
}

function sessionOf(id: string): Session {
  return { id, header: { cwd: WORKSPACE } } as unknown as Session
}

function liveAgentOf(id: string, events: readonly SessionEvent[]): Agent {
  return { id, session: { events } } as unknown as Agent
}

/** The accountant's non-domain collaborators: no live agents, no history. */
const coldLanes = {
  agents: { get: (_id: SessionId): Agent | undefined => undefined },
  history: async (_sessionId: string): Promise<readonly SessionEvent[] | undefined> => undefined,
}

describe('billing settlement loss faces (issue #92)', () => {
  let sandbox: string
  let scope: TeamScope
  let stack: StorageStack
  let domain: TeamDomain
  let ctx: Context
  let accountant: UsageAccountant

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'dsh-usage-recovery-'))
    scope = WORKSPACE
    stack = await openStorageStack(join(sandbox, 'storage'))
    domain = stack.port as TeamDomain
    ctx = stack.ctx
    accountant = new UsageAccountant(ctx, { domain: () => stack.port, isClosing: () => false, ...coldLanes })
  })

  afterEach(async () => {
    await stack.close()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  async function provisionedTeam(): Promise<TeamId> {
    const team = await domain.createTeam(scope, 'captain-session', 'Billing team', 'issue #92')
    await domain.provisionMember(scope, team.id, 'captain-session', {
      name: 'first-turn-worker',
      role: 'Bills while still provisioning',
      sessionId: 'member-session',
      provider: 'spawn',
    })
    return team.id
  }

  it('scenario 34: bills a provisioning member\'s first-turn usage that the authority membership face refuses', async () => {
    const teamId = await provisionedTeam()
    // The real authority face refuses the provisioning row — exactly the
    // window whose silent flush discard produced the permanent gap.
    expect(await domain.findMembership(scope, 'member-session')).toBeUndefined()
    expect((await domain.findAccountingMembership(scope, 'member-session'))?.team.id).toBe(teamId)

    accountant.observeSessionEvent(sessionOf('member-session'), usageEvent(15, 173))
    await accountant.wait()

    const settled = await domain.snapshot(scope, teamId, 'captain-session')
    expect(settled.team.budget.usedTokens).toBe(173)
    expect(settled.team.usageCursors['member-session']).toBe(15)
  })

  it('scenario 34: folds usage observed while the runtime is closing instead of dropping it at the entry gate', async () => {
    const teamId = await provisionedTeam()
    await domain.settleMember(scope, teamId, 'member-session', { active: true })
    const closing = new UsageAccountant(ctx, { domain: () => stack.port, isClosing: () => true, ...coldLanes })

    closing.observeSessionEvent(sessionOf('member-session'), usageEvent(30, 23))
    await closing.wait()

    const settled = await domain.snapshot(scope, teamId, 'captain-session')
    expect(settled.team.budget.usedTokens).toBe(23)
    expect(settled.team.usageCursors['member-session']).toBe(30)
  })

  it('scenario 34: activation roster recovery folds a cold member\'s dropped usage exactly once and is cursor-idempotent on repeats', async () => {
    const teamId = await provisionedTeam()
    await domain.settleMember(scope, teamId, 'member-session', { active: true })
    // The live path dropped both events (the loss these tests reproduce);
    // only the persisted history still carries them. The captain has no
    // history of its own — every session reads only its durable log.
    const stored: Record<string, readonly SessionEvent[]> = {
      'member-session': [
        usageEvent(15, 173),
        { type: 'step/start', seq: 16, time: 0, data: {} } as unknown as SessionEvent,
        usageEvent(30, 23),
      ],
    }
    const history = vi.fn(async (sessionId: string): Promise<readonly SessionEvent[] | undefined> => stored[sessionId])
    const recovering = new UsageAccountant(ctx, { domain: () => stack.port, isClosing: () => false, agents: coldLanes.agents, history })

    await recovering.recoverTeamUsage(scope, (await domain.snapshot(scope, teamId, 'captain-session')).team)
    let settled = await domain.snapshot(scope, teamId, 'captain-session')
    expect(settled.team.budget.usedTokens).toBe(196)
    expect(settled.team.usageCursors['member-session']).toBe(30)

    await recovering.recoverTeamUsage(scope, settled.team)
    settled = await domain.snapshot(scope, teamId, 'captain-session')
    expect(settled.team.budget.usedTokens).toBe(196)
    expect(history).toHaveBeenCalledTimes(4)
  })

  it('scenario 34: a late live flush after a recovery refold is cursor-skipped, so both writer lanes count each event once', async () => {
    const teamId = await provisionedTeam()
    await domain.settleMember(scope, teamId, 'member-session', { active: true })
    const agent = liveAgentOf('member-session', [usageEvent(15, 173), usageEvent(30, 23)])
    const liveAgents = { get: (id: SessionId): Agent | undefined => (id === 'member-session' ? agent : undefined) }
    const lanes = { ...coldLanes, agents: liveAgents }
    const recovering = new UsageAccountant(ctx, { domain: () => stack.port, isClosing: () => false, ...lanes })

    // The recovery refold commits first (the delivery-driven lane)...
    await recovering.recoverTeamUsage(scope, (await domain.snapshot(scope, teamId, 'captain-session')).team)
    // ...then the live firehose lane replays the same events late.
    accountant = new UsageAccountant(ctx, { domain: () => stack.port, isClosing: () => false, ...lanes })
    accountant.observeSessionEvent(sessionOf('member-session'), usageEvent(15, 173))
    accountant.observeSessionEvent(sessionOf('member-session'), usageEvent(30, 23))
    await accountant.wait()

    const settled = await domain.snapshot(scope, teamId, 'captain-session')
    expect(settled.team.budget.usedTokens).toBe(196)
    expect(settled.team.usageCursors['member-session']).toBe(30)
  })

  it('folds one batch\'s out-of-order arrivals exactly once and skips their replay', async () => {
    const teamId = await provisionedTeam()
    await domain.settleMember(scope, teamId, 'member-session', { active: true })

    // Same flush batch, arrival order reversed: seq 30 lands before seq 15.
    accountant.observeSessionEvent(sessionOf('member-session'), usageEvent(30, 23))
    accountant.observeSessionEvent(sessionOf('member-session'), usageEvent(15, 173))
    await accountant.wait()
    // Replay of both events (reload-style redelivery of the same history).
    accountant.observeSessionEvent(sessionOf('member-session'), usageEvent(15, 173))
    accountant.observeSessionEvent(sessionOf('member-session'), usageEvent(30, 23))
    await accountant.wait()

    const settled = await domain.snapshot(scope, teamId, 'captain-session')
    expect(settled.team.budget.usedTokens).toBe(196)
    expect(settled.team.usageCursors['member-session']).toBe(30)
  })

  it('resolves billing membership across roster phases: provisioning matches, the active ledger wins cross-tier, and same-tier ambiguity still fails loud', async () => {
    const teamId = await provisionedTeam()
    expect((await domain.findAccountingMembership(scope, 'member-session'))?.team.id).toBe(teamId)
    expect((await domain.findAccountingMembership(scope, 'captain-session'))?.role).toBe('captain')
    expect(await domain.findAccountingMembership(scope, 'stranger-session')).toBeUndefined()

    // Cross-tier: the same session also captained an archived Team — the
    // live ledger wins for billing.
    const archived = await domain.createTeam(scope, 'member-session', 'Drained team', 'archived after drain')
    await domain.archiveTeam(scope, archived.id, 'member-session', 'drain complete')
    expect((await domain.findAccountingMembership(scope, 'member-session'))?.team.id).toBe(teamId)

    // Same-tier ambiguity keeps the F11 fail-loud vocabulary (a second
    // captain owns the probe team — one captain owns one active Team).
    const second = await domain.createTeam(scope, 'captain-two', 'Second team', 'ambiguity probe')
    await domain.provisionMember(scope, second.id, 'captain-two', {
      name: 'shared-worker',
      role: 'ambiguous row',
      sessionId: 'member-session',
      provider: 'spawn',
    })
    await expect(domain.findAccountingMembership(scope, 'member-session')).rejects.toMatchObject({
      code: 'TEAM_MEMBERSHIP_AMBIGUOUS',
    })
  })
})
