import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertTeamStateV2 } from '../src/domain/state-validation-v2.js'
import { TeamV2StartDomain } from '../src/domain/team-domain-v2-start.js'
import type { TeamStateV2 } from '../src/domain/team-state-v2.js'
import { AttemptId, TaskId, TeamId, type TeamState } from '../src/domain/types.js'
import { transformTeamV1ToV2 } from '../src/migration/team-v1-to-v2.js'
import { canonicalV2, canonicalV2Digest, legacyManifestSetDigest } from '../src/protocol/canonical-v2.js'
import { teamRecordV2Of } from '../src/storage/team-spec-v2.js'
import {
  FaultableBackend,
  openV2FaultableStack,
  openV2StorageStack,
  type V2StorageStack,
} from './helpers/storage-stack.js'

const BINDING = { artifactContract: 'dsh-agent-swarm/a1-fresh-v2/test', legacyManifestCapacity: 64 }
const PROMPT_DIGEST = '1'.repeat(64)
const WITNESS_DIGEST = '2'.repeat(64)

type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer U)[]
    ? Mutable<U>[]
    : T[K] extends object
      ? Mutable<T[K]>
      : T[K]
}

function pathExists(path: string): Promise<boolean> {
  return stat(path).then(() => true, error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  })
}

function legacyFixture(): TeamState {
  return {
    schemaVersion: 1,
    id: TeamId('team-v2-vector-0001'),
    revision: 7,
    name: 'Legacy vector',
    description: 'Deterministic v1 to v2 fixture',
    captainSessionId: 'captain-1',
    phase: 'active',
    members: [{
      name: 'worker', role: 'implementation', sessionId: 'member-1', provider: 'spawn',
      modelSource: 'unresolved', phase: 'active', createdAt: 10,
    }],
    tasks: [{
      id: TaskId('task-1'), revision: 2, subject: 'work', description: 'legacy open task',
      acceptanceCriteria: ['done'], status: 'in_progress', blockedBy: [], writeScopes: [], priority: 0,
      ownerSessionId: 'member-1', currentAttemptId: AttemptId('attempt-1'), createdAt: 11, updatedAt: 12,
    }],
    attempts: [{
      id: AttemptId('attempt-1'), taskId: TaskId('task-1'), generation: 1, memberSessionId: 'member-1',
      phase: 'running', assignmentPhase: 'delivered', assignmentDeliveredAt: 12,
      evidence: [], createdAt: 11, updatedAt: 12,
    }],
    messages: [],
    budget: { usedTokens: 3, usedRequests: 1, usedRetries: 0 },
    usageCursors: { 'captain-1': 4, 'member-1': 2 },
    memory: [],
    nextTaskNumber: 2,
    nextMemoryNumber: 1,
    createdAt: 9,
    updatedAt: 12,
  }
}

describe('A1a strict fresh-v2 foundation', () => {
  const sandboxes: string[] = []
  let stack: V2StorageStack | undefined

  afterEach(async () => {
    await stack?.close()
    stack = undefined
    for (const sandbox of sandboxes.splice(0)) {
      await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })

  async function fresh(now = 100): Promise<{ root: string; domain: TeamV2StartDomain }> {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-v2-'))
    sandboxes.push(sandbox)
    const root = join(sandbox, 'storage')
    let clock = now
    stack = await openV2StorageStack(root, BINDING, () => clock++)
    await stack.store.initializeFreshAuthority()
    return {
      root,
      domain: new TeamV2StartDomain(stack.store, {
        now: () => clock++,
        newTeamId: () => 'team-fresh-v2-0001',
        newAttemptId: () => 'attempt-fresh-v2-0001',
      }),
    }
  }

  it('uses deterministic canonical encoding and a fixed empty legacy-manifest vector', () => {
    expect(canonicalV2({ z: 2, a: [true, null, 'x'] })).toBe('{"a":[true,null,"x"],"z":2}')
    expect(canonicalV2Digest('test/domain', { b: 2, a: 1 }))
      .toBe(canonicalV2Digest('test/domain', { a: 1, b: 2 }))
    expect(legacyManifestSetDigest([])).toBe('8c8f248da7b51cb37e3bacf2397141cfe9b440ed2edd5deea8b213f84b394570')
  })

  it('gates Team writes on one read-back-verified fresh authority and reopens without v1 media', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-v2-authority-'))
    sandboxes.push(sandbox)
    const root = join(sandbox, 'storage')
    let clock = 200
    stack = await openV2StorageStack(root, BINDING, () => clock++)
    const domain = new TeamV2StartDomain(stack.store, { now: () => clock++, newTeamId: () => 'team-authority-v2-0001' })
    await expect(domain.createTeam('/workspace', 'captain-1', 'Team', 'Description'))
      .rejects.toMatchObject({ code: 'TEAM_RUNTIME_NOT_STARTED' })

    const authority = await stack.store.initializeFreshAuthority()
    expect(authority).toMatchObject({ authorityEpoch: 2, origin: 'fresh', teamSchemaVersion: 2 })
    expect(authority.legacyManifest).toEqual({
      capacity: 64, count: 0, digests: [], setDigest: legacyManifestSetDigest([]),
    })
    const team = await domain.createTeam('/workspace', 'captain-1', 'Team', 'Description')
    expect(team.schemaVersion).toBe(2)
    expect(await pathExists(join(root, 'agent_swarm.json'))).toBe(false)
    expect(await pathExists(join(root, 'agent_swarm_v2.json'))).toBe(true)

    await stack.close()
    stack = await openV2StorageStack(root, BINDING, () => clock++)
    const reopened = await stack.store.initializeFreshAuthority()
    expect(reopened).toEqual(authority)
    expect(stack.store.read('/workspace', team.id)).toEqual(team)

    await stack.close()
    stack = await openV2StorageStack(root, { ...BINDING, artifactContract: 'another-artifact' }, () => clock++)
    await expect(stack.store.initializeFreshAuthority()).rejects.toMatchObject({ code: 'TEAM_STATE_VERSION_UNSUPPORTED' })
  })

  it('leaves authority and Team state unchanged when the durable backend rejects a write', async () => {
    const backend = new FaultableBackend()
    let clock = 250
    stack = await openV2FaultableStack(backend, BINDING, () => clock++)
    backend.failNextWrites = 1
    await expect(stack.store.initializeFreshAuthority()).rejects.toThrow(/injected write failure/)
    expect(stack.store.readAuthority()).toBeUndefined()

    await stack.store.initializeFreshAuthority()
    const domain = new TeamV2StartDomain(stack.store, {
      now: () => clock++, newTeamId: () => 'team-fault-v2-0001', newAttemptId: () => 'attempt-fault-v2-0001',
    })
    const team = await domain.createTeam('/workspace', 'captain-1', 'Team', 'Description')
    const member = await domain.declareMember('/workspace', team.id, 'captain-1', {
      name: 'worker', role: 'implementation', sessionId: 'member-1', provider: 'spawn',
      modelSource: 'unresolved', deniedTools: [], assignedSkills: [], maxDepth: 2,
    })
    const task = await domain.createTask('/workspace', team.id, 'captain-1', { subject: 'Work', description: 'Do work' })
    const before = stack.store.read('/workspace', team.id)
    backend.failNextWrites = 1
    await expect(domain.reserveInitialAssignment(
      '/workspace', team.id, 'captain-1', task.id, task.revision, member.sessionId, PROMPT_DIGEST,
    )).rejects.toThrow(/injected write failure/)
    expect(stack.store.read('/workspace', team.id)).toEqual(before)
  })

  it('commits declared -> starting -> active/delivered/dispatch-pending atomically and idempotently', async () => {
    const { domain } = await fresh()
    const team = await domain.createTeam('/workspace', 'captain-1', 'Team', 'Description')
    const member = await domain.declareMember('/workspace', team.id, 'captain-1', {
      name: 'worker', role: 'implementation', sessionId: 'member-1', provider: 'spawn',
      modelSource: 'unresolved', deniedTools: ['dangerous'], assignedSkills: ['typescript'], maxDepth: 3,
    })
    expect(member.phase).toBe('declared')
    const task = await domain.createTask('/workspace', team.id, 'captain-1', {
      subject: 'Implement', description: 'Build the first vertical', acceptanceCriteria: ['tested'],
    })

    const races = await Promise.allSettled([
      domain.reserveInitialAssignment('/workspace', team.id, 'captain-1', task.id, task.revision, member.sessionId, PROMPT_DIGEST),
      domain.reserveInitialAssignment('/workspace', team.id, 'captain-1', task.id, task.revision, member.sessionId, PROMPT_DIGEST),
    ])
    expect(races.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const reserved = races.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof domain.reserveInitialAssignment>>>
    expect(reserved.value.member).toMatchObject({ phase: 'starting', startingAttemptId: reserved.value.attempt.id })
    expect(reserved.value.attempt).toMatchObject({ phase: 'reserved', assignmentPhase: 'reserved', dispatchEpochs: [] })

    const checkpoint = {
      initialPromptDigest: PROMPT_DIGEST,
      messageSeq: 4,
      turn: 1,
      step: 1,
      witnessCapabilityDigest: WITNESS_DIGEST,
      dispatchId: 'dispatch-initial-1',
      effectId: 'effect-initial-1',
    }
    const settled = await domain.settleInitialAssignment(
      '/workspace', team.id, member.sessionId, task.id, reserved.value.attempt.id, checkpoint,
    )
    expect(settled.member).toMatchObject({ phase: 'active', initialMessageSeq: 4 })
    expect(settled.member).not.toHaveProperty('startingAttemptId')
    expect(settled.attempt).toMatchObject({ phase: 'reserved', assignmentPhase: 'delivered' })
    expect(settled.dispatch).toMatchObject({ phase: 'dispatch-pending', kind: 'initial', ordinal: 1 })
    expect(await domain.settleInitialAssignment(
      '/workspace', team.id, member.sessionId, task.id, reserved.value.attempt.id, checkpoint,
    )).toEqual(settled)

    const persisted = stack!.store.read('/workspace', team.id)!
    assertTeamStateV2(persisted, 'persisted')
    expect(persisted.attempts).toHaveLength(1)
  })

  it('rejects every broken declared -> starting tuple without changing the authoritative Team', async () => {
    const { domain } = await fresh(300)
    const team = await domain.createTeam('/workspace', 'captain-1', 'Team', 'Description')
    const member = await domain.declareMember('/workspace', team.id, 'captain-1', {
      name: 'worker', role: 'implementation', sessionId: 'member-1', provider: 'spawn',
      modelSource: 'unresolved', deniedTools: [], assignedSkills: [], maxDepth: 2,
    })
    const task = await domain.createTask('/workspace', team.id, 'captain-1', { subject: 'Work', description: 'Do work' })
    await domain.reserveInitialAssignment(
      '/workspace', team.id, 'captain-1', task.id, task.revision, member.sessionId, PROMPT_DIGEST,
    )
    const authoritative = stack!.store.read('/workspace', team.id)!
    const mutations: ReadonlyArray<readonly [string, (draft: Mutable<TeamStateV2>) => void]> = [
      ['starting member without fence', draft => { delete draft.members[0]!.startingAttemptId }],
      ['non-starting member with fence', draft => { draft.members[0]!.phase = 'declared' }],
      ['starting member with message evidence', draft => { draft.members[0]!.initialMessageSeq = 1 }],
      ['starting member with activation evidence', draft => { draft.members[0]!.activatedAt = 1 }],
      ['task outside in_progress', draft => { draft.tasks[0]!.status = 'submitted' }],
      ['task points at another attempt', draft => { draft.tasks[0]!.currentAttemptId = AttemptId('attempt-other') }],
      ['task names another owner', draft => { draft.tasks[0]!.ownerSessionId = 'member-other' }],
      ['attempt names another owner', draft => { draft.attempts[0]!.memberSessionId = 'member-other' }],
      ['attempt is already running', draft => { draft.attempts[0]!.phase = 'running' }],
      ['assignment is already delivered', draft => {
        draft.attempts[0]!.assignmentPhase = 'delivered'
        draft.attempts[0]!.assignmentDeliveredAt = 1
      }],
      ['two members name the same starting attempt', draft => {
        draft.members.push({ ...structuredClone(draft.members[0]!), name: 'worker-2', sessionId: 'member-2' })
      }],
    ]
    for (const [label, mutate] of mutations) {
      const malformed = structuredClone(authoritative) as Mutable<TeamStateV2>
      mutate(malformed)
      expect(() => assertTeamStateV2(malformed, label), label).toThrow()
      expect(stack!.store.read('/workspace', team.id), `${label} changed the medium`).toEqual(authoritative)
    }
  })

  it('fails the exact starting tuple without mutating a successor and rejects every malformed invariant', async () => {
    const { root, domain } = await fresh(500)
    const team = await domain.createTeam('/workspace', 'captain-1', 'Team', 'Description')
    const member = await domain.declareMember('/workspace', team.id, 'captain-1', {
      name: 'worker', role: 'implementation', sessionId: 'member-1', provider: 'spawn',
      modelSource: 'unresolved', deniedTools: [], assignedSkills: [], maxDepth: 2,
    })
    const task = await domain.createTask('/workspace', team.id, 'captain-1', { subject: 'Work', description: 'Do work' })
    const reserved = await domain.reserveInitialAssignment(
      '/workspace', team.id, 'captain-1', task.id, task.revision, member.sessionId, PROMPT_DIGEST,
    )
    const failed = await domain.failInitialAssignment(
      '/workspace', team.id, member.sessionId, task.id, reserved.attempt.id, 'child start failed',
    )
    expect(failed.member.phase).toBe('failed')
    expect(failed.task).toMatchObject({ status: 'pending' })
    expect(failed.task).not.toHaveProperty('currentAttemptId')
    expect(failed.attempt.phase).toBe('cancelled')
    expect(await domain.failInitialAssignment(
      '/workspace', team.id, member.sessionId, task.id, reserved.attempt.id, 'child start failed',
    )).toEqual(failed)

    const persisted = stack!.store.read('/workspace', team.id)!
    const malformed = structuredClone(persisted) as TeamStateV2 & { extra?: true }
    malformed.extra = true
    expect(() => assertTeamStateV2(malformed, 'unknown-root-key')).toThrow(/Unrecognized key/)

    const raw = teamRecordV2Of('/workspace', persisted) as ReturnType<typeof teamRecordV2Of> & {
      team: TeamStateV2 & { members: Array<TeamStateV2['members'][number] & { unexpected?: true }> }
    }
    raw.team.members[0]!.unexpected = true
    await stack!.domain.table('teams').put(persisted.id, raw)
    expect(() => stack!.store.read('/workspace', team.id)).toThrow(/unexpected/i)
    await stack!.close()
    stack = undefined
    await expect(openV2StorageStack(root, BINDING)).rejects.toThrow(/stored record .* does not match its schema/i)
  })

  it('transforms v1 only with verified evidence, preserves input and yields a fixed digest', () => {
    const source = legacyFixture()
    const before = structuredClone(source)
    const evidence = {
      members: {
        'member-1': {
          maxDepth: 3,
          initialPromptDigest: '3'.repeat(64),
          initialMessageSeq: 5,
          activatedAt: 13,
        },
      },
      attempts: {
        'attempt-1': {
          phase: 'parked' as const,
          parkedAt: 14,
          parkedReason: 'migration-unknown' as const,
          lastSessionSeq: 8,
        },
      },
    }
    const transformed = transformTeamV1ToV2(source, evidence)
    expect(source).toEqual(before)
    expect(transformed.kind).toBe('transformed')
    if (transformed.kind !== 'transformed') return
    expect(transformed.team).toMatchObject({ schemaVersion: 2, interactionEffects: [] })
    expect(transformed.team.attempts[0]).toMatchObject({ phase: 'parked', parked: { parkedReason: 'migration-unknown' } })
    expect(transformed.digest).toBe('7ed1e9dd23234338f23e51669aada57984c9f0f6285513274af8eb94d8aa59ad')
    expect(transformTeamV1ToV2(structuredClone(source), structuredClone(evidence))).toEqual(transformed)

    const missing = transformTeamV1ToV2(source, { members: {}, attempts: {} })
    expect(missing).toMatchObject({ kind: 'blocked' })
    if (missing.kind === 'blocked') expect(missing.blockers.join('\n')).toMatch(/maxDepth|running state/)

    const provisioning = legacyFixture()
    provisioning.members[0] = { ...provisioning.members[0]!, phase: 'provisioning' }
    const unresolved = transformTeamV1ToV2(provisioning, evidence)
    expect(unresolved).toMatchObject({ kind: 'blocked' })
    if (unresolved.kind === 'blocked') expect(unresolved.blockers.join('\n')).toMatch(/must be reconciled/)

    const completed = legacyFixture()
    completed.tasks[0] = { ...completed.tasks[0]!, status: 'completed', output: 'accepted output' }
    completed.attempts[0] = { ...completed.attempts[0]!, phase: 'accepted', output: 'accepted output' }
    const completedResult = transformTeamV1ToV2(completed, { members: evidence.members, attempts: {} })
    expect(completedResult).toMatchObject({
      kind: 'transformed',
      team: {
        tasks: [{ status: 'completed', currentAttemptId: 'attempt-1' }],
        attempts: [{ phase: 'accepted' }],
      },
    })
  })
})
