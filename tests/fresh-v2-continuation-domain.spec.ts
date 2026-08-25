import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertTeamStateV2 } from '../src/domain/state-validation-v2.js'
import { TeamV2ContinuationDomain, type ContinuationDispatchCheckpoint } from '../src/domain/team-domain-v2-continuation.js'
import { TeamV2StartDomain } from '../src/domain/team-domain-v2-start.js'
import {
  ContinuationEffectId,
  DispatchId,
  MAX_V2_EFFECT_RECEIPTS,
  TeamEffectId,
  type TeamStateV2,
} from '../src/domain/team-state-v2.js'
import { AttemptId, TaskId, type TeamId } from '../src/domain/types.js'
import { openV2StorageStack, type V2StorageStack } from './helpers/storage-stack.js'

const SCOPE = '/workspace'
const PROMPT_DIGEST = '1'.repeat(64)
const WITNESS_DIGEST = '2'.repeat(64)
const BINDING = { artifactContract: 'dsh-agent-swarm/a2a-continuation/test', legacyManifestCapacity: 64 }

describe('A2a same-Attempt continuation domain', () => {
  const sandboxes: string[] = []
  let stack: V2StorageStack | undefined

  afterEach(async () => {
    await stack?.close()
    stack = undefined
    for (const sandbox of sandboxes.splice(0)) {
      await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })

  async function runningAttempt(): Promise<{
    start: TeamV2StartDomain
    continuation: TeamV2ContinuationDomain
    teamId: TeamId
    taskId: TaskId
    attemptId: AttemptId
    taskRevision: number
  }> {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-a2a-domain-'))
    sandboxes.push(sandbox)
    let clock = 100
    stack = await openV2StorageStack(join(sandbox, 'storage'), BINDING, () => clock++)
    await stack.store.initializeFreshAuthority()
    const start = new TeamV2StartDomain(stack.store, {
      now: () => clock++,
      newTeamId: () => 'team-a2a-domain-0001',
      newAttemptId: () => 'attempt-a2a-domain-0001',
    })
    const continuation = new TeamV2ContinuationDomain(stack.store, () => clock++)
    const team = await start.createTeam(SCOPE, 'captain-1', 'A2a', 'Continuation')
    const member = await start.declareMember(SCOPE, team.id, 'captain-1', {
      name: 'worker', role: 'implementation', sessionId: 'member-1', provider: 'spawn',
      modelSource: 'unresolved', deniedTools: [], assignedSkills: [], maxDepth: 2,
    })
    const task = await start.createTask(SCOPE, team.id, 'captain-1', { subject: 'Work', description: 'Continue it' })
    const reserved = await start.reserveInitialAssignment(
      SCOPE, team.id, 'captain-1', task.id, task.revision, member.sessionId, PROMPT_DIGEST,
    )
    const initial = {
      initialPromptDigest: PROMPT_DIGEST,
      messageSeq: 4,
      turn: 1,
      step: 1,
      witnessCapabilityDigest: WITNESS_DIGEST,
      dispatchId: 'dispatch-initial-a2a',
      effectId: 'effect-initial-a2a',
    }
    await start.settleInitialAssignment(SCOPE, team.id, member.sessionId, task.id, reserved.attempt.id, initial)
    await start.enterInitialDispatch(SCOPE, team.id, member.sessionId, task.id, reserved.attempt.id, initial)
    await start.settleInitialAssistantEvidence(
      SCOPE, team.id, member.sessionId, task.id, reserved.attempt.id, initial,
      { eventSeq: 10, eventType: 'assistant/message' },
    )
    const current = stack.store.read(SCOPE, team.id)!.tasks[0]!
    return {
      start, continuation, teamId: team.id, taskId: current.id, attemptId: reserved.attempt.id,
      taskRevision: current.revision,
    }
  }

  it('persists request before parking, admits one effect, and returns the same Attempt to running only after assistant evidence', async () => {
    const fixture = await runningAttempt()
    const continuationEffectId = ContinuationEffectId('continuation-a2a-1')
    const requested = await fixture.continuation.requestMemberContinuation(SCOPE, fixture.teamId, {
      taskId: fixture.taskId,
      expectedTaskRevision: fixture.taskRevision,
      attemptId: fixture.attemptId,
      continuationEffectId,
      principal: { kind: 'member', memberId: 'worker', memberSessionId: 'member-1' },
      checkpointDigest: '3'.repeat(64),
      wakeCondition: 'Continue the same accepted scope after this turn settles.',
    })
    expect(requested).toMatchObject({ phase: 'requested', attemptId: fixture.attemptId })
    let persisted = stack!.store.read(SCOPE, fixture.teamId)!
    expect(persisted.attempts[0]).toMatchObject({ phase: 'running', currentContinuationIntent: { phase: 'requested' } })
    expect(persisted.attempts[0]).not.toHaveProperty('parked')
    assertTeamStateV2(persisted, 'pre-park-request')

    const dispatchId = DispatchId('dispatch-continuation-a2a-1')
    const resumeEffectId = TeamEffectId('effect-continuation-a2a-1')
    const parkedAfterTurn = await fixture.continuation.parkAfterTurn(SCOPE, fixture.teamId, {
      taskId: fixture.taskId,
      attemptId: fixture.attemptId,
      memberSessionId: 'member-1',
      settledTurn: 1,
      turnEndSeq: 11,
    })
    expect(parkedAfterTurn).toMatchObject({
      id: fixture.attemptId, phase: 'parked', currentContinuationIntent: { phase: 'requested' },
    })
    const admitted = await fixture.continuation.admitRequested(SCOPE, fixture.teamId, {
      taskId: fixture.taskId,
      attemptId: fixture.attemptId,
      memberSessionId: 'member-1',
      continuationEffectId,
      resumeEffectId,
      dispatchId,
      witnessCapabilityDigest: WITNESS_DIGEST,
    })
    expect(admitted).toMatchObject({
      attempt: { id: fixture.attemptId, phase: 'parked', currentContinuationIntent: { phase: 'admitted' } },
      dispatch: { kind: 'continuation', ordinal: 2, phase: 'frame-pending' },
    })
    expect(stack!.store.read(SCOPE, fixture.teamId)!.interactionEffects).toContainEqual(expect.objectContaining({
      effectId: resumeEffectId, requestId: continuationEffectId, kind: 'continuation', status: 'applied',
    }))
    const admittedState = stack!.store.read(SCOPE, fixture.teamId)!
    const missingEffect = structuredClone(admittedState) as TeamStateV2
    Object.assign(missingEffect.attempts[0]!.currentContinuationIntent!, { resumeEffectId: undefined })
    expect(() => assertTeamStateV2(missingEffect, 'missing continuation effect')).toThrow(/admitted dispatch tuple/)
    const mismatchedPhase = structuredClone(admittedState) as TeamStateV2
    Object.assign(mismatchedPhase.attempts[0]!.dispatchEpochs[1]!, { phase: 'dispatch-pending' })
    expect(() => assertTeamStateV2(mismatchedPhase, 'mismatched continuation phase')).toThrow(/phases are inconsistent/)
    const missingReservation = structuredClone(admittedState) as TeamStateV2
    missingReservation.interactionEffects.splice(0, 1)
    expect(() => assertTeamStateV2(missingReservation, 'missing continuation reservation'))
      .toThrow(/active reservation|Attempt\/dispatch tuple/)

    const accepted = await fixture.continuation.recordFrameAccepted(SCOPE, fixture.teamId, {
      taskId: fixture.taskId,
      attemptId: fixture.attemptId,
      continuationEffectId,
      dispatchId,
      frameMessageId: 'official-message-a2a-1',
    })
    expect(accepted).toMatchObject({ phase: 'frame-pending', frameMessageId: 'official-message-a2a-1' })
    const checkpoint: ContinuationDispatchCheckpoint = {
      taskId: fixture.taskId,
      attemptId: fixture.attemptId,
      continuationEffectId,
      dispatchId,
      resumeEffectId,
      frameMessageId: 'official-message-a2a-1',
      messageSeq: 13,
      turn: 2,
      step: 1,
      witnessCapabilityDigest: WITNESS_DIGEST,
    }
    expect(await fixture.continuation.claimFrame(SCOPE, fixture.teamId, checkpoint))
      .toMatchObject({ phase: 'dispatch-pending', turn: 2, step: 1, messageSeq: 13 })
    expect(await fixture.continuation.enterDispatch(SCOPE, fixture.teamId, checkpoint))
      .toMatchObject({ phase: 'dispatch-entered' })
    const settled = await fixture.continuation.settleAssistantEvidence(SCOPE, fixture.teamId, {
      checkpoint, eventSeq: 15, eventType: 'assistant/message',
    })
    expect(settled).toMatchObject({ attempt: { id: fixture.attemptId, phase: 'running' }, dispatch: { phase: 'settled' } })

    persisted = stack!.store.read(SCOPE, fixture.teamId)!
    expect(persisted.attempts).toHaveLength(1)
    expect(persisted.attempts[0]).toMatchObject({ id: fixture.attemptId, generation: 1, phase: 'running' })
    expect(persisted.attempts[0]).not.toHaveProperty('parked')
    expect(persisted.attempts[0]).not.toHaveProperty('currentContinuationIntent')
    expect(persisted.attempts[0]!.dispatchEpochs).toHaveLength(2)
    expect(persisted.interactionEffects).toContainEqual(expect.objectContaining({
      effectId: resumeEffectId, requestId: continuationEffectId, kind: 'continuation', status: 'settled',
    }))
    assertTeamStateV2(persisted, 'settled-continuation')

    const replayed = await fixture.continuation.requestMemberContinuation(SCOPE, fixture.teamId, {
      taskId: fixture.taskId,
      expectedTaskRevision: fixture.taskRevision,
      attemptId: fixture.attemptId,
      continuationEffectId,
      principal: { kind: 'member', memberId: 'worker', memberSessionId: 'member-1' },
      checkpointDigest: '3'.repeat(64),
      wakeCondition: 'Continue the same accepted scope after this turn settles.',
    })
    expect(replayed).toMatchObject({
      phase: 'settled', continuationEffectId, attemptId: fixture.attemptId, resumeEffectId, currentDispatchId: dispatchId,
    })
    await expect(fixture.continuation.requestMemberContinuation(SCOPE, fixture.teamId, {
      taskId: fixture.taskId,
      expectedTaskRevision: fixture.taskRevision,
      attemptId: fixture.attemptId,
      continuationEffectId,
      principal: { kind: 'member', memberId: 'worker', memberSessionId: 'member-1' },
      checkpointDigest: '3'.repeat(64),
      wakeCondition: 'A different settled semantic request must not reuse this key.',
    })).rejects.toMatchObject({ code: 'TEAM_CONTINUATION_CONFLICT' })
    expect(stack!.store.read(SCOPE, fixture.teamId)!.attempts[0]).not.toHaveProperty('currentContinuationIntent')

    const parked = await fixture.continuation.parkAfterTurn(SCOPE, fixture.teamId, {
      taskId: fixture.taskId,
      attemptId: fixture.attemptId,
      memberSessionId: 'member-1',
      settledTurn: 2,
      turnEndSeq: 16,
    })
    expect(parked).toMatchObject({ id: fixture.attemptId, phase: 'parked' })
    expect(parked).not.toHaveProperty('currentContinuationIntent')
  })

  it('is idempotent for one identity and rejects stale, forged, or competing continuation requests', async () => {
    const fixture = await runningAttempt()
    const input = {
      taskId: fixture.taskId,
      expectedTaskRevision: fixture.taskRevision,
      attemptId: fixture.attemptId,
      continuationEffectId: ContinuationEffectId('continuation-a2a-race'),
      principal: { kind: 'member' as const, memberId: 'worker', memberSessionId: 'member-1' },
    }
    const first = await fixture.continuation.requestMemberContinuation(SCOPE, fixture.teamId, input)
    expect(await fixture.continuation.requestMemberContinuation(SCOPE, fixture.teamId, input)).toEqual(first)
    await expect(fixture.continuation.requestMemberContinuation(SCOPE, fixture.teamId, {
      ...input, checkpointDigest: '4'.repeat(64),
    })).rejects.toMatchObject({ code: 'TEAM_CONTINUATION_CONFLICT' })
    await expect(fixture.continuation.requestMemberContinuation(SCOPE, fixture.teamId, {
      ...input, wakeCondition: 'Different semantic request under the same key.',
    })).rejects.toMatchObject({ code: 'TEAM_CONTINUATION_CONFLICT' })
    await expect(fixture.continuation.requestMemberContinuation(SCOPE, fixture.teamId, {
      ...input, continuationEffectId: ContinuationEffectId('continuation-a2a-other'),
    })).rejects.toMatchObject({ code: 'TEAM_CONTINUATION_CONFLICT' })
    await expect(fixture.continuation.requestMemberContinuation(SCOPE, fixture.teamId, {
      ...input, principal: { kind: 'member', memberId: 'forged', memberSessionId: 'member-1' },
    })).rejects.toMatchObject({ code: 'TEAM_TASK_OWNER_REQUIRED' })

    await fixture.continuation.parkAfterTurn(SCOPE, fixture.teamId, {
      taskId: fixture.taskId,
      attemptId: fixture.attemptId,
      memberSessionId: 'member-1',
      settledTurn: 1,
      turnEndSeq: 11,
    })
    await fixture.continuation.admitRequested(SCOPE, fixture.teamId, {
      taskId: fixture.taskId,
      attemptId: fixture.attemptId,
      memberSessionId: 'member-1',
      continuationEffectId: input.continuationEffectId,
      resumeEffectId: TeamEffectId('effect-continuation-race'),
      dispatchId: DispatchId('dispatch-continuation-race'),
      witnessCapabilityDigest: WITNESS_DIGEST,
    })
    const before = stack!.store.read(SCOPE, fixture.teamId)
    await expect(fixture.continuation.recordFrameAccepted(SCOPE, fixture.teamId, {
      taskId: TaskId('task-wrong'),
      attemptId: fixture.attemptId,
      continuationEffectId: input.continuationEffectId,
      dispatchId: DispatchId('dispatch-continuation-race'),
      frameMessageId: 'official-message-wrong',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_NOT_FOUND' })
    expect(stack!.store.read(SCOPE, fixture.teamId)).toEqual(before)
  })

  it('fails closed at receipt capacity and rejects inconsistent continuation phase tuples', async () => {
    const fixture = await runningAttempt()
    const continuationEffectId = ContinuationEffectId('continuation-a2a-capacity')
    const requested = await fixture.continuation.requestMemberContinuation(SCOPE, fixture.teamId, {
      taskId: fixture.taskId,
      expectedTaskRevision: fixture.taskRevision,
      attemptId: fixture.attemptId,
      continuationEffectId,
      principal: { kind: 'member', memberId: 'worker', memberSessionId: 'member-1' },
      checkpointDigest: '5'.repeat(64),
      wakeCondition: 'Preserve this exact request identity.',
    })
    expect(requested.phase).toBe('requested')
    await fixture.continuation.parkAfterTurn(SCOPE, fixture.teamId, {
      taskId: fixture.taskId,
      attemptId: fixture.attemptId,
      memberSessionId: 'member-1',
      settledTurn: 1,
      turnEndSeq: 11,
    })
    await stack!.store.transact(SCOPE, fixture.teamId, team => {
      Object.assign(team, {
        interactionEffects: Array.from({ length: MAX_V2_EFFECT_RECEIPTS }, (_value, index) => ({
          effectId: TeamEffectId(`effect-filled-${index}`),
          kind: 'interaction' as const,
          status: 'applied' as const,
          appliedAt: index,
          resultingTeamRevision: team.revision + 1,
          requestId: `request-filled-${index}`,
        })),
      })
    })
    const before = stack!.store.read(SCOPE, fixture.teamId)!
    const resumeEffectId = TeamEffectId('effect-continuation-capacity')
    const dispatchId = DispatchId('dispatch-continuation-capacity')
    await expect(fixture.continuation.admitRequested(SCOPE, fixture.teamId, {
      taskId: fixture.taskId,
      attemptId: fixture.attemptId,
      memberSessionId: 'member-1',
      continuationEffectId,
      resumeEffectId,
      dispatchId,
      witnessCapabilityDigest: WITNESS_DIGEST,
    })).rejects.toMatchObject({ code: 'TEAM_RESOURCE_LIMIT' })
    expect(stack!.store.read(SCOPE, fixture.teamId)).toEqual(before)
    expect(before.interactionEffects).toHaveLength(MAX_V2_EFFECT_RECEIPTS)
    expect(before.attempts[0]).toMatchObject({
      currentContinuationIntent: { continuationEffectId, phase: 'requested' },
      dispatchEpochs: [expect.objectContaining({ kind: 'initial', phase: 'settled' })],
    })
  })
})
