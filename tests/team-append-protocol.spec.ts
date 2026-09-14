/**
 * Issue #294 slice 1 RED: the append-only change protocol for an ACTIVE Team
 * (docs/04-core-protocol.md §2.3, committed 2c66097, blob 7b3fb559).
 *
 * Contract under test (§2.3 bullet -> assertion):
 * - :63 append is its own lifecycle event, not a re-plan. `staged` keeps §2.1,
 *   `archived` rejects.
 * - :64 append-only: never overwrites an existing member's running config and
 *   never touches the existing task DAG; an appended task may only depend on a
 *   task from the same append.
 * - :66 stable change id + idempotency: the same logical append returns the
 *   existing result and never creates a second member/task/event; a CAS
 *   failure rejects without partially applying anything.
 * - :69 the durable audit fact (actor / time / declaration / resulting
 *   revision) is reconstructable from the Team aggregate alone — no second
 *   state authority — and survives a storage reopen.
 *
 * Reverse hard scenario (blocks sliding into "plan v2"): on an active Team that
 * already has an approved plan, every re-plan entry keeps its existing phase
 * rejection and the old `planDraft` stays byte-identical across an append.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TeamDomain } from '../src/domain/team-domain.js'
import type { TeamAppendChange, TeamPlanDraft, TeamState } from '../src/domain/types.js'
import { TeamDomainError } from '../src/domain/error.js'
import { openStorageStack, type StorageStack } from './helpers/storage-stack.js'

const approvedPlan: TeamPlanDraft = {
  members: [{ name: 'researcher', role: '性能与安全分析' }],
  tasks: [{
    key: 't1', subject: '性能与安全分析', description: '分析最近交付',
    dependencies: [], targetMemberName: 'researcher',
  }],
}

const sliceOneAppend: TeamAppendChange = {
  changeId: 'append-1',
  initiatedBySessionId: 'captain-session',
  members: [{ name: 'builder', role: '实现' }],
  tasks: [{
    key: 'a1', subject: '切片实现', description: '实现仅追加协议骨架',
    dependencies: [], targetMemberName: 'builder',
  }],
}

const codeOf = async (run: () => Promise<unknown>): Promise<string> =>
  await run().then(() => 'NO_ERROR', (error: unknown) => error instanceof TeamDomainError ? error.code : `NOT_DOMAIN_ERROR:${String(error)}`)

/** Byte identity of the stored plan; normalizePlanDraft emits keys in a fixed order. */
const planFingerprint = (team: TeamState): string => JSON.stringify(team.planDraft ?? null)

/** Key-order-insensitive comparison: zod rebuilds nested objects in schema order. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(',')}}`
}

async function approveOnePlan(scope: string, stack: StorageStack, turn: number): Promise<TeamState> {
  const domain = stack.port as TeamDomain
  const staged = await domain.createStagedManaged(scope, `managed:root:turn:${turn}`, '评审团队', '分析最近交付')
  await domain.setPlanDraft(scope, staged.id, staged.revision, approvedPlan)
  // approveStagedPlan is the atomic commit and returns the committed aggregate.
  const active = await domain.approveStagedPlan(scope, staged.id, staged.revision + 1, 'captain-session')
  // The plan task graph is minted by the RUNTIME (createPlannedTasks), not by
  // approveStagedPlan, so a domain-only fixture creates its pre-existing task.
  await domain.createTask(scope, active.id, 'captain-session', {
    subject: '性能与安全分析', description: '分析最近交付',
  })
  // Likewise the plan member is provisioned by the RUNTIME after approval
  // (provisionMember/settleMember in apply.ts), never by approveStagedPlan.
  // §2.3:64 protects THAT member's running config, so the fixture must carry
  // its settled row for the append guards to have a pre-existing member.
  await stack.store.transact(scope, staged.id, team => {
    team.members.push({
      name: 'researcher', role: '性能与安全分析', sessionId: 'member-researcher',
      provider: 'stub', phase: 'active', createdAt: 1_000,
    })
  })
  const withTask = await stack.store.read(scope, staged.id)
  if (withTask === undefined) throw new Error('approved Team vanished')
  return withTask
}

describe('active Team append-only protocol (§2.3, issue #294 slice 1)', () => {
  let sandbox: string
  let scope: string
  let stack: StorageStack
  let domain: TeamDomain

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-append-'))
    scope = join(sandbox, 'workspace')
    stack = await openStorageStack(join(sandbox, 'storage'), () => 1_000)
    domain = stack.port as TeamDomain
  })

  afterEach(async () => {
    await stack.close()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('appends members and tasks to an active Team as one durable change', async () => {
    const team = await approveOnePlan(scope, stack, 1)
    const appended = await domain.appendActiveTeam(scope, team.id, team.revision, sliceOneAppend)

    // Slice-1 ruling: an append records the member DECLARATION but must never
    // mint a TeamMember row — that lands with provision in slice 2 (§2.3:67),
    // because a phantom 'provisioning' row with no resumable child would be
    // settled as failed by recoverInterrupted. This guard blocks anyone who
    // later tries to mint rows early.
    expect(appended.members).toHaveLength(team.members.length)
    expect(canonical(appended.members)).toBe(canonical(team.members))
    expect(appended.tasks.map(task => task.subject)).toEqual(['性能与安全分析', '切片实现'])
    expect(appended.revision).toBe(team.revision + 1)
    // :69 the audit fact is readable back off the aggregate itself.
    expect(appended.appendChanges).toHaveLength(1)
    expect(appended.appendChanges?.[0]).toMatchObject({
      changeId: 'append-1', initiatedBySessionId: 'captain-session',
      createdAt: 1_000, resultingRevision: team.revision + 1,
    })
  })

  it('REVERSE hard scenario: re-plan entries keep their phase rejection and the old planDraft is byte-identical', async () => {
    const team = await approveOnePlan(scope, stack, 2)
    const before = planFingerprint(team)
    expect(before).not.toBe('null')

    // Every §2.1 entry must stay phase-gated on an active Team.
    expect(await codeOf(() => domain.setPlanDraft(scope, team.id, team.revision, approvedPlan))).toBe('TEAM_PHASE_INVALID')
    expect(await codeOf(() => domain.approveStagedPlan(scope, team.id, team.revision, 'other-captain'))).toBe('TEAM_PHASE_INVALID')
    expect(await codeOf(() => domain.discardStagedPlan(scope, team.id, team.revision))).toBe('TEAM_PHASE_INVALID')

    const appended = await domain.appendActiveTeam(scope, team.id, team.revision, sliceOneAppend)
    // An append is its own event: it must not mint a plan v2 nor edit the old one.
    expect(planFingerprint(appended)).toBe(before)
    expect(appended.appendChanges).toHaveLength(1)
  })

  it('keeps §2.1 for staged Teams and rejects append on archived Teams', async () => {
    const staged = await domain.createStagedManaged(scope, 'managed:root:turn:3', '评审团队', '分析最近交付')
    expect(await codeOf(() => domain.appendActiveTeam(scope, staged.id, staged.revision, sliceOneAppend))).toBe('TEAM_PHASE_INVALID')

    const team = await approveOnePlan(scope, stack, 4)
    await domain.archiveTeam(scope, team.id, 'captain-session', '收工')
    const archived = await stack.store.read(scope, team.id)
    expect(archived?.phase).toBe('archived')
    expect(await codeOf(() => domain.appendActiveTeam(scope, team.id, archived!.revision, sliceOneAppend))).toBe('TEAM_PHASE_INVALID')
  })

  it('repeats the same change id idempotently: existing result, no second event', async () => {
    const team = await approveOnePlan(scope, stack, 5)
    const first = await domain.appendActiveTeam(scope, team.id, team.revision, sliceOneAppend)
    const again = await domain.appendActiveTeam(scope, team.id, first.revision, sliceOneAppend)

    expect(again.revision).toBe(first.revision)
    expect(again.members).toHaveLength(1)
    expect(again.tasks).toHaveLength(2)
    expect(again.appendChanges).toHaveLength(1)
    // A reused id carrying a different payload must not be silently accepted.
    expect(await codeOf(() => domain.appendActiveTeam(scope, team.id, again.revision, {
      ...sliceOneAppend, members: [{ name: 'imposter', role: '冒充' }],
    }))).toBe('TEAM_APPEND_CHANGE_CONFLICT')
  })

  it('rejects a CAS conflict without partially applying the append', async () => {
    const team = await approveOnePlan(scope, stack, 6)
    const fingerprint = canonical(team)

    expect(await codeOf(() => domain.appendActiveTeam(scope, team.id, team.revision + 99, sliceOneAppend))).toBe('TEAM_REVISION_CONFLICT')

    const after = await stack.store.read(scope, team.id)
    // Same canonical comparison as everywhere else in this file: raw
    // JSON.stringify is key-order dependent (zod emits schema order), so it
    // can never equal the canonical fingerprint of the same unchanged data.
    expect(canonical(after)).toBe(fingerprint)
    expect(after?.appendChanges).toBeUndefined()
  })

  it('never overwrites an existing member running config (:64)', async () => {
    const team = await approveOnePlan(scope, stack, 7)
    expect(await codeOf(() => domain.appendActiveTeam(scope, team.id, team.revision, {
      changeId: 'append-clash', initiatedBySessionId: 'captain-session',
      members: [{ name: 'researcher', role: '被改写的职责' }], tasks: [],
    }))).toBe('TEAM_APPEND_NOT_APPEND_ONLY')

    const after = await stack.store.read(scope, team.id)
    expect(after?.members).toEqual(team.members)
  })

  it('refuses an appended task that depends on a pre-existing task (:64)', async () => {
    const team = await approveOnePlan(scope, stack, 8)
    const existingTaskId = team.tasks[0]!.id
    expect(await codeOf(() => domain.appendActiveTeam(scope, team.id, team.revision, {
      changeId: 'append-topo', initiatedBySessionId: 'captain-session',
      members: [{ name: 'builder', role: '实现' }],
      tasks: [{ key: 'a1', subject: '依赖旧任务', description: '越界依赖既有 DAG', dependencies: [existingTaskId] }],
    }))).toBe('TEAM_APPEND_TOPOLOGY_FORBIDDEN')

    const after = await stack.store.read(scope, team.id)
    expect(after?.tasks).toEqual(team.tasks)
  })

  it('refuses a member declaration that forges personal identity fields (:68)', async () => {
    const team = await approveOnePlan(scope, stack, 9)
    // The same payload must be refused identically through both entry points.
    const viaAppend = await codeOf(() => domain.appendActiveTeam(scope, team.id, team.revision, {
      changeId: 'append-identity', initiatedBySessionId: 'captain-session',
      members: [{ name: 'builder', role: '实现', displayName: '伪造显示名' }], tasks: [],
    }))
    const viaPlan = await codeOf(() => domain.setPlanDraft(scope, team.id, team.revision, {
      members: [{ name: 'forged', role: '实现', displayName: '伪造显示名' }], tasks: [],
    }))
    expect(viaAppend).toBe(viaPlan)
    expect(viaAppend).not.toBe('NO_ERROR')

    const after = await stack.store.read(scope, team.id)
    expect(after?.members).toEqual(team.members)
    expect(after?.appendChanges).toBeUndefined()
  })

  it('survives a storage reopen: the append fact and its tasks reload unchanged', async () => {
    const team = await approveOnePlan(scope, stack, 10)
    const appended = await domain.appendActiveTeam(scope, team.id, team.revision, sliceOneAppend)
    const fingerprint = canonical(appended)

    await stack.close()
    stack = await openStorageStack(join(sandbox, 'storage'), () => 1_000)
    const reloaded = await stack.store.read(scope, team.id)
    // Proves the durable field is declared in the Storage Domain zod schema:
    // the official load path strips keys undeclared there.
    expect(canonical(reloaded)).toBe(fingerprint)
    expect(reloaded?.appendChanges?.[0]?.changeId).toBe('append-1')
  })

  it('leaves pre-append records byte-identical after reload (no fabricated backfill)', async () => {
    const team = await approveOnePlan(scope, stack, 11)
    const before = canonical(team)
    await stack.close()
    stack = await openStorageStack(join(sandbox, 'storage'), () => 1_000)
    const reloaded = await stack.store.read(scope, team.id)
    expect(canonical(reloaded)).toBe(before)
    expect(reloaded?.appendChanges).toBeUndefined()
  })
})
