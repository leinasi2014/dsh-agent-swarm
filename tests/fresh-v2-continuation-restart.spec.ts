import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createMessage, MessageId, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { TeamV2ContinuationDomain } from '../src/domain/team-domain-v2-continuation.js'
import { TeamV2StartDomain } from '../src/domain/team-domain-v2-start.js'
import { ContinuationEffectId, DispatchId, TeamEffectId } from '../src/domain/team-state-v2.js'
import { continuationFrame } from '../src/runtime/fresh-v2-continuation-fold.js'
import { FRESH_V2_ARTIFACT_CONTRACT, mountFreshV2Composition } from './helpers/fresh-v2-composition.js'
import { openV2StorageStack } from './helpers/storage-stack.js'

class NoopAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const roots: string[] = []

async function seedEnteredContinuation(
  sandbox: string,
  outcome: 'assistant-closed' | 'assistant-open' | 'interrupted',
): Promise<{
  readonly workspace: string
  readonly teamId: string
  readonly attemptId: string
  readonly memberSessionId: string
}> {
  const workspace = resolve(sandbox, 'workspace')
  const binding = { artifactContract: FRESH_V2_ARTIFACT_CONTRACT, legacyManifestCapacity: 0 }
  const stack = await openV2StorageStack(join(sandbox, 'storage'), binding)
  const sessionCtx = new Context()
  const sessionFibers: Fiber[] = []
  try {
    await stack.store.initializeFreshAuthority()
    const start = new TeamV2StartDomain(stack.store, {
      newTeamId: () => 'team-cold-entered', newAttemptId: () => 'attempt-cold-entered',
    })
    const continuation = new TeamV2ContinuationDomain(stack.store)
    const team = await start.createTeam(workspace, 'captain-cold', 'Cold recovery', 'Entered dispatch recovery')
    const member = await start.declareMember(workspace, team.id, 'captain-cold', {
      name: 'worker', role: 'recovery', sessionId: 'member-cold', provider: 'spawn',
      modelSource: 'unresolved', deniedTools: [], assignedSkills: [], maxDepth: 1,
    })
    const task = await start.createTask(workspace, team.id, 'captain-cold', {
      subject: 'Recover entered work', description: 'Fold exact durable outcome after restart.',
    })
    const reserved = await start.reserveInitialAssignment(
      workspace, team.id, 'captain-cold', task.id, task.revision, member.sessionId, '1'.repeat(64),
    )
    const initial = {
      initialPromptDigest: '1'.repeat(64), messageSeq: 2, turn: 1, step: 1,
      witnessCapabilityDigest: '2'.repeat(64), dispatchId: 'dispatch-cold-initial', effectId: 'effect-cold-initial',
    }
    await start.settleInitialAssignment(workspace, team.id, member.sessionId, task.id, reserved.attempt.id, initial)
    await start.enterInitialDispatch(workspace, team.id, member.sessionId, task.id, reserved.attempt.id, initial)
    await start.settleInitialAssistantEvidence(
      workspace, team.id, member.sessionId, task.id, reserved.attempt.id, initial,
      { eventSeq: 3, eventType: 'assistant/message' },
    )
    const currentTask = stack.store.read(workspace, team.id)!.tasks[0]!
    const continuationEffectId = ContinuationEffectId('continuation-cold-entered')
    const resumeEffectId = TeamEffectId('effect-cold-entered')
    const dispatchId = DispatchId('dispatch-cold-entered')
    await continuation.requestMemberContinuation(workspace, team.id, {
      taskId: currentTask.id, expectedTaskRevision: currentTask.revision, attemptId: reserved.attempt.id,
      continuationEffectId,
      principal: { kind: 'member', memberId: member.name, memberSessionId: member.sessionId },
    })
    await continuation.parkAfterTurn(workspace, team.id, {
      taskId: currentTask.id, attemptId: reserved.attempt.id, memberSessionId: member.sessionId,
      settledTurn: 1, turnEndSeq: 5,
    })
    await continuation.admitRequested(workspace, team.id, {
      taskId: currentTask.id, attemptId: reserved.attempt.id, memberSessionId: member.sessionId,
      continuationEffectId, resumeEffectId, dispatchId, witnessCapabilityDigest: '2'.repeat(64),
    })
    const frame = continuationFrame({
      teamId: team.id, taskId: currentTask.id, attemptId: reserved.attempt.id,
      continuationEffectId, resumeEffectId, dispatchId, ordinal: 2,
    })
    await continuation.recordFrameAccepted(workspace, team.id, {
      taskId: currentTask.id, attemptId: reserved.attempt.id, continuationEffectId, dispatchId,
      frameMessageId: 'message-cold-entered',
    })
    const checkpoint = {
      taskId: currentTask.id, attemptId: reserved.attempt.id, continuationEffectId, dispatchId, resumeEffectId,
      frameMessageId: 'message-cold-entered', messageSeq: 2, turn: 2, step: 1,
      witnessCapabilityDigest: '2'.repeat(64),
    }
    await continuation.claimFrame(workspace, team.id, checkpoint)
    await continuation.enterDispatch(workspace, team.id, checkpoint)

    await mountAgentLoopTestDependencies(sessionCtx)
    sessionFibers.push(await sessionCtx.plugin(SqliteSessionPersistence, {
      path: join(sandbox, 'sessions', 'sessions.db'),
    }))
    const childId = SessionId(member.sessionId)
    const session = Session.create(childId, undefined, {
      version: 0,
      id: childId,
      createdAt: Date.now(),
      cwd: workspace,
      parentSession: SessionId('captain-cold'),
      origin: 'subagent',
      delegationDepth: 1,
    })
    session.append('turn/start', { turn: 2 })
    session.append('step/start', { turn: 2, step: 1 })
    session.append('user/message', {
      id: MessageId('message-cold-entered'), role: 'user', content: [{ type: 'text', text: frame }],
      source: { kind: 'plugin', plugin: 'dsh-agent-swarm' },
    }, { surfaceOp: 'append' })
    if (outcome !== 'interrupted') {
      session.append('assistant/message', {
        turn: 2,
        step: 1,
        message: createMessage({
          role: 'assistant', content: [{ type: 'text', text: 'persisted completion' }],
          source: { kind: 'model', provider: 'mock', model: 'mock' },
        }),
      }, { surfaceOp: 'append' })
      if (outcome === 'assistant-closed') {
        session.append('step/end', { turn: 2, step: 1 })
        session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
      }
    }
    await sessionCtx.sessionPersistence.create(session.header)
    await sessionCtx.sessionPersistence.append(session.id, session.events)
    return {
      workspace,
      teamId: team.id,
      attemptId: reserved.attempt.id,
      memberSessionId: member.sessionId,
    }
  } finally {
    for (const fiber of sessionFibers.toReversed()) await fiber.dispose()
    await stack.close()
  }
}

describe('A2a fresh-composition cold entered-dispatch reconciliation', () => {
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it.each([
    ['assistant-closed', 'settled', 'turn-settled'],
    ['assistant-open', 'settled', 'turn-settled'],
    ['interrupted', 'dispatch-unknown', 'migration-unknown'],
  ] as const)('folds %s evidence on a fresh runtime', async (outcome, dispatchPhase, parkedReason) => {
    const sandbox = await mkdtemp(join(tmpdir(), `dsh-swarm-a2a-restart-${outcome}-`))
    roots.push(sandbox)
    const seeded = await seedEnteredContinuation(sandbox, outcome)
    const mounted = await mountFreshV2Composition(sandbox, () => new NoopAdapter())
    try {
      const snapshot = mounted.ctx.agentSwarmV2Initial.snapshot(seeded.workspace, seeded.teamId)!
      const attempt = snapshot.attempts.find(candidate => candidate.id === seeded.attemptId)!
      expect(attempt).toMatchObject({ phase: 'parked', parked: { parkedReason } })
      expect(attempt.dispatchEpochs.at(-1)).toMatchObject({ phase: dispatchPhase })
      expect(mounted.adapter.requests).toHaveLength(0)
      if (outcome !== 'interrupted') {
        expect(attempt).not.toHaveProperty('currentContinuationIntent')
        expect(snapshot.interactionEffects).toContainEqual(expect.objectContaining({ status: 'settled' }))
        if (outcome === 'assistant-open') {
          const physical = await mounted.ctx.sessionPersistence.readFrom(SessionId(seeded.memberSessionId), 0)
          expect(physical.events.at(-1)).toMatchObject({
            type: 'turn/end',
            data: { turn: 2, reason: { kind: 'interrupted' } },
          })
          expect(attempt.parked?.lastSessionSeq).toBe(physical.events.at(-1)?.seq)
        }
      } else {
        expect(attempt).toMatchObject({ currentContinuationIntent: { phase: 'dispatch-unknown' } })
        expect(snapshot.interactionEffects).toContainEqual(expect.objectContaining({ status: 'applied' }))
      }
    } finally {
      for (const fiber of mounted.fibers.toReversed()) await fiber.dispose().catch(() => undefined)
    }
  }, 30_000)

  it('holds the official unpublished Session reservation through the atomic Team mutation', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-a2a-restart-reservation-'))
    roots.push(sandbox)
    const seeded = await seedEnteredContinuation(sandbox, 'assistant-open')
    let testContext!: Context
    let releaseFirst!: () => void
    let acquiredFirst!: () => void
    const firstAcquired = new Promise<void>(resolveAcquired => { acquiredFirst = resolveAcquired })
    const firstRelease = new Promise<void>(resolveRelease => { releaseFirst = resolveRelease })
    let originalPrepare!: Context['sessionPersistence']['prepare']
    const mounting = mountFreshV2Composition(sandbox, () => new NoopAdapter(), {}, async ctx => {
      testContext = ctx
      originalPrepare = ctx.sessionPersistence.prepare.bind(ctx.sessionPersistence)
      let first = true
      ctx.sessionPersistence.prepare = async (id, signal) => {
        const preparation = await originalPrepare(id, signal)
        if (!first) return preparation
        first = false
        acquiredFirst()
        await firstRelease
        return preparation
      }
    })
    await firstAcquired
    let competingSettled = false
    const competing = originalPrepare(SessionId(seeded.memberSessionId)).then(preparation => {
      competingSettled = true
      return preparation
    })
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
    expect(competingSettled).toBe(false)
    expect(testContext.sessions.get(SessionId(seeded.memberSessionId))).toBeUndefined()
    releaseFirst()
    const mounted = await mounting
    const competingPreparation = await competing
    competingPreparation[Symbol.dispose]()
    try {
      const attempt = mounted.ctx.agentSwarmV2Initial.snapshot(seeded.workspace, seeded.teamId)!
        .attempts.find(candidate => candidate.id === seeded.attemptId)!
      expect(attempt).toMatchObject({ phase: 'parked', parked: { parkedReason: 'turn-settled' } })
      expect(attempt.dispatchEpochs.at(-1)).toMatchObject({ phase: 'settled' })
    } finally {
      for (const fiber of mounted.fibers.toReversed()) await fiber.dispose().catch(() => undefined)
    }
  }, 30_000)
})
