import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TeamV2ContinuationDomain, type ContinuationDispatchCheckpoint } from '../src/domain/team-domain-v2-continuation.js'
import { TeamV2ContinuationRecoveryDomain } from '../src/domain/team-domain-v2-continuation-recovery.js'
import { TeamV2StartDomain } from '../src/domain/team-domain-v2-start.js'
import { TeamV2TaskControlDomain } from '../src/domain/team-domain-v2-task-control.js'
import { ContinuationEffectId, DispatchId, TeamEffectId } from '../src/domain/team-state-v2.js'
import { type AttemptId, type TaskId, type TeamId } from '../src/domain/types.js'
import { openV2StorageStack, type V2StorageStack } from './helpers/storage-stack.js'

const SCOPE = '/workspace'
const PROMPT_DIGEST = '1'.repeat(64)
const WITNESS_DIGEST = '2'.repeat(64)
const BINDING = { artifactContract: 'dsh-agent-swarm/a2a-task-control/test', legacyManifestCapacity: 64 }

describe('fresh-v2 atomic submit and reassignment fences', () => {
  const sandboxes: string[] = []
  let stack: V2StorageStack | undefined

  afterEach(async () => {
    await stack?.close()
    stack = undefined
    for (const sandbox of sandboxes.splice(0)) {
      await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })

  async function enteredInitial(): Promise<{
    teamId: TeamId; taskId: TaskId; attemptId: AttemptId; taskRevision: number
    start: TeamV2StartDomain; continuation: TeamV2ContinuationDomain; control: TeamV2TaskControlDomain
  }> {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-v2-control-'))
    sandboxes.push(sandbox)
    let clock = 100
    stack = await openV2StorageStack(join(sandbox, 'storage'), BINDING, () => clock++)
    await stack.store.initializeFreshAuthority()
    const start = new TeamV2StartDomain(stack.store, {
      now: () => clock++, newTeamId: () => 'team-control-1', newAttemptId: () => 'attempt-control-1',
    })
    const continuation = new TeamV2ContinuationDomain(stack.store, () => clock++)
    const control = new TeamV2TaskControlDomain(stack.store, { now: () => clock++ })
    const team = await start.createTeam(SCOPE, 'captain-1', 'Control', 'Atomic race fences')
    const member = await start.declareMember(SCOPE, team.id, 'captain-1', {
      name: 'worker', role: 'implementation', sessionId: 'member-1', provider: 'spawn',
      modelSource: 'unresolved', deniedTools: [], assignedSkills: [], maxDepth: 2,
    })
    const task = await start.createTask(SCOPE, team.id, 'captain-1', { subject: 'Work', description: 'Do it' })
    const reserved = await start.reserveInitialAssignment(
      SCOPE, team.id, 'captain-1', task.id, task.revision, member.sessionId, PROMPT_DIGEST,
    )
    const checkpoint = {
      initialPromptDigest: PROMPT_DIGEST, messageSeq: 4, turn: 1, step: 1,
      witnessCapabilityDigest: WITNESS_DIGEST,
      dispatchId: 'dispatch-initial-control', effectId: 'effect-initial-control',
    }
    await start.settleInitialAssignment(SCOPE, team.id, member.sessionId, task.id, reserved.attempt.id, checkpoint)
    await start.enterInitialDispatch(SCOPE, team.id, member.sessionId, task.id, reserved.attempt.id, checkpoint)
    const current = stack.store.read(SCOPE, team.id)!.tasks[0]!
    return {
      teamId: team.id, taskId: task.id, attemptId: reserved.attempt.id, taskRevision: current.revision,
      start, continuation, control,
    }
  }

  async function runningContinuation(withRecovery: boolean): Promise<{
    teamId: TeamId; taskId: TaskId; attemptId: AttemptId; taskRevision: number; control: TeamV2TaskControlDomain
  }> {
    const fixture = await enteredInitial()
    const initial = stack!.store.read(SCOPE, fixture.teamId)!.attempts[0]!.dispatchEpochs[0]!
    await fixture.start.settleInitialAssistantEvidence(
      SCOPE, fixture.teamId, 'member-1', fixture.taskId, fixture.attemptId,
      {
        initialPromptDigest: PROMPT_DIGEST, messageSeq: initial.messageSeq!, turn: initial.turn!, step: initial.step!,
        witnessCapabilityDigest: WITNESS_DIGEST, dispatchId: initial.dispatchId, effectId: initial.effectId,
      },
      { eventSeq: 10, eventType: 'assistant/message' },
    )
    const running = stack!.store.read(SCOPE, fixture.teamId)!.tasks[0]!
    const continuationEffectId = ContinuationEffectId('continuation-control-1')
    await fixture.continuation.requestMemberContinuation(SCOPE, fixture.teamId, {
      taskId: fixture.taskId, expectedTaskRevision: running.revision, attemptId: fixture.attemptId,
      continuationEffectId,
      principal: { kind: 'member', memberId: 'worker', memberSessionId: 'member-1' },
      checkpointDigest: '3'.repeat(64), wakeCondition: 'continue',
    })
    await fixture.continuation.parkAfterTurn(SCOPE, fixture.teamId, {
      taskId: fixture.taskId, attemptId: fixture.attemptId, memberSessionId: 'member-1', settledTurn: 1, turnEndSeq: 11,
    })
    const resumeEffectId = TeamEffectId('effect-continuation-control-1')
    const dispatchId = DispatchId('dispatch-continuation-control-1')
    await fixture.continuation.admitRequested(SCOPE, fixture.teamId, {
      taskId: fixture.taskId, attemptId: fixture.attemptId, memberSessionId: 'member-1',
      continuationEffectId, resumeEffectId, dispatchId, witnessCapabilityDigest: WITNESS_DIGEST,
    })
    await fixture.continuation.recordFrameAccepted(SCOPE, fixture.teamId, {
      taskId: fixture.taskId, attemptId: fixture.attemptId, continuationEffectId,
      dispatchId, frameMessageId: 'message-continuation-control-1',
    })
    const checkpoint: ContinuationDispatchCheckpoint = {
      taskId: fixture.taskId, attemptId: fixture.attemptId, continuationEffectId, dispatchId, resumeEffectId,
      frameMessageId: 'message-continuation-control-1', messageSeq: 13, turn: 2, step: 1,
      witnessCapabilityDigest: WITNESS_DIGEST,
    }
    await fixture.continuation.claimFrame(SCOPE, fixture.teamId, checkpoint)
    if (withRecovery) {
      const recovery = new TeamV2ContinuationRecoveryDomain(stack!.store, () => 999)
      await recovery.reserveProvenNotEntered(SCOPE, fixture.teamId, {
        checkpoint,
        recoveryEffectId: TeamEffectId('effect-recovery-control-1'),
        recoveryDispatchId: DispatchId('dispatch-recovery-control-1'),
        recoveryProofTurnEndSeq: 14,
        recoveryProofDigest: '4'.repeat(64),
      })
    } else {
      await fixture.continuation.enterDispatch(SCOPE, fixture.teamId, checkpoint)
    }
    const current = stack!.store.read(SCOPE, fixture.teamId)!.tasks[0]!
    return { ...fixture, taskRevision: current.revision }
  }

  async function runningInitial() {
    const fixture = await enteredInitial()
    const initial = stack!.store.read(SCOPE, fixture.teamId)!.attempts[0]!.dispatchEpochs[0]!
    await fixture.start.settleInitialAssistantEvidence(
      SCOPE, fixture.teamId, 'member-1', fixture.taskId, fixture.attemptId,
      {
        initialPromptDigest: PROMPT_DIGEST, messageSeq: initial.messageSeq!, turn: initial.turn!, step: initial.step!,
        witnessCapabilityDigest: WITNESS_DIGEST, dispatchId: initial.dispatchId, effectId: initial.effectId,
      },
      { eventSeq: 10, eventType: 'assistant/message' },
    )
    return fixture
  }

  it('rejects submission until official assistant execution evidence makes the Attempt running', async () => {
    const fixture = await enteredInitial()
    await expect(fixture.control.submitTask(SCOPE, fixture.teamId, 'member-1', {
      taskId: fixture.taskId, expectedTaskRevision: fixture.taskRevision, attemptId: fixture.attemptId,
      output: 'premature', evidence: [],
    })).rejects.toMatchObject({ code: 'TEAM_ATTEMPT_PHASE_INVALID' })
    expect(stack!.store.read(SCOPE, fixture.teamId)!.attempts[0]).toMatchObject({ phase: 'reserved' })
  })

  it('lets the exact member submit a running Attempt without completing the task', async () => {
    const fixture = await runningInitial()
    const submitted = await fixture.control.submitTask(SCOPE, fixture.teamId, 'member-1', {
      taskId: fixture.taskId, expectedTaskRevision: fixture.taskRevision, attemptId: fixture.attemptId,
      output: 'finished', evidence: ['test:pass'],
    })
    expect(submitted).toMatchObject({ status: 'submitted', output: 'finished' })
    const state = stack!.store.read(SCOPE, fixture.teamId)!
    expect(state.attempts[0]).toMatchObject({ phase: 'submitted', output: 'finished' })
    expect(state.attempts[0]).not.toHaveProperty('currentContinuationIntent')
    expect(state.attempts[0]!.dispatchEpochs[0]).toMatchObject({ phase: 'settled' })
  })

  it('derives submit and reassign authority from the exact Team actor', async () => {
    const fixture = await enteredInitial()
    await expect(fixture.control.submitTask(SCOPE, fixture.teamId, 'captain-1', {
      taskId: fixture.taskId, expectedTaskRevision: fixture.taskRevision, attemptId: fixture.attemptId,
      output: 'forged', evidence: [],
    })).rejects.toMatchObject({ code: 'TEAM_TASK_OWNER_REQUIRED' })
    await expect(fixture.control.reassignTask(SCOPE, fixture.teamId, 'member-1', {
      taskId: fixture.taskId, expectedTaskRevision: fixture.taskRevision, diagnostic: 'forged',
    })).rejects.toMatchObject({ code: 'TEAM_CAPTAIN_REQUIRED' })
    expect(stack!.store.read(SCOPE, fixture.teamId)!.attempts[0]).toMatchObject({
      phase: 'reserved', dispatchEpochs: [{ phase: 'dispatch-entered' }],
    })
  })

  it('atomically supersedes continuation and staged recovery receipts when captain reassigns', async () => {
    const fixture = await runningContinuation(true)
    const released = await fixture.control.reassignTask(SCOPE, fixture.teamId, 'captain-1', {
      taskId: fixture.taskId, expectedTaskRevision: fixture.taskRevision, diagnostic: 'change owner',
    })
    expect(released.task).toMatchObject({ status: 'pending' })
    const state = stack!.store.read(SCOPE, fixture.teamId)!
    expect(state.attempts[0]).toMatchObject({ phase: 'stale', diagnostic: 'change owner' })
    expect(state.attempts[0]).not.toHaveProperty('currentContinuationIntent')
    expect(state.attempts[0]!.dispatchEpochs.slice(1)).toEqual([
      expect.objectContaining({ kind: 'continuation', phase: 'superseded' }),
      expect.objectContaining({ kind: 'recovery', phase: 'superseded' }),
    ])
    expect(state.interactionEffects).toEqual([
      expect.objectContaining({ kind: 'continuation', status: 'superseded' }),
      expect.objectContaining({ kind: 'continuation-recovery', status: 'superseded' }),
    ])
  })

  it('rejects submission while a continuation has entered but lacks assistant execution evidence', async () => {
    const fixture = await runningContinuation(false)
    await expect(fixture.control.submitTask(SCOPE, fixture.teamId, 'member-1', {
      taskId: fixture.taskId, expectedTaskRevision: fixture.taskRevision, attemptId: fixture.attemptId,
      output: 'candidate', evidence: [],
    })).rejects.toMatchObject({ code: 'TEAM_ATTEMPT_PHASE_INVALID' })
    const state = stack!.store.read(SCOPE, fixture.teamId)!
    expect(state.attempts[0]).toMatchObject({ phase: 'parked' })
    expect(state.attempts[0]!.dispatchEpochs.at(-1)).toMatchObject({ phase: 'dispatch-entered' })
  })
})
