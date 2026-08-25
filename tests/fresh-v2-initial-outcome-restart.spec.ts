import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createMessage, LlmAdapter, MessageId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import { SUBAGENT_DESCRIPTOR_VERSION } from '@deepseek-ai/dsh-subagent'
import { afterEach, describe, expect, it } from 'vitest'
import { TeamV2StartDomain } from '../src/domain/team-domain-v2-start.js'
import { canonicalV2Digest } from '../src/protocol/canonical-v2.js'
import { initialPromptDigest } from '../src/runtime/fresh-v2-session-fold.js'
import {
  FRESH_V2_ARTIFACT_CONTRACT,
  FRESH_V2_HOST_CONTRACT,
  mountFreshV2Composition,
} from './helpers/fresh-v2-composition.js'
import { openV2StorageStack } from './helpers/storage-stack.js'

type Outcome =
  | 'assistant-closed'
  | 'assistant-open'
  | 'assistant-team-settled-closed'
  | 'assistant-team-settled-open'
  | 'no-output-completed'
  | 'interrupted'
  | 'partial-chunk'
  | 'partial-chunk-completed'

class NoReplayAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const ACTIVE_WITNESS_DIGEST = canonicalV2Digest('dsh-agent-swarm/a1b/model-dispatch-witness/v2', {
  artifactContract: FRESH_V2_ARTIFACT_CONTRACT,
  hostContract: FRESH_V2_HOST_CONTRACT,
  listenerGraph: {
    agentRequest: 'global-prepend',
    llmStream: 'global-prepend',
    sessionEvent: 'global',
    topologyPolicy: 'revoke-until-profile-restart',
  },
  providers: ['mock'],
})

async function seedEnteredInitial(sandbox: string, outcome: Outcome): Promise<{
  readonly workspace: string
  readonly teamId: string
  readonly attemptId: string
  readonly memberSessionId: string
}> {
  const workspace = resolve(sandbox, 'workspace')
  const stack = await openV2StorageStack(join(sandbox, 'storage'), {
    artifactContract: FRESH_V2_ARTIFACT_CONTRACT,
    legacyManifestCapacity: 0,
  })
  const sessionCtx = new Context()
  const fibers: Fiber[] = []
  try {
    await stack.store.initializeFreshAuthority()
    const domain = new TeamV2StartDomain(stack.store, {
      newTeamId: () => `team-initial-${outcome}`,
      newAttemptId: () => `attempt-initial-${outcome}`,
    })
    const captainId = `captain-initial-${outcome}`
    const memberSessionId = `member-initial-${outcome}`
    const prompt = `Initial assignment frame for ${outcome}.`
    const digest = initialPromptDigest(prompt)
    const team = await domain.createTeam(workspace, captainId, 'Initial recovery', outcome)
    const member = await domain.declareMember(workspace, team.id, captainId, {
      name: 'worker', role: 'recover one entered initial outcome', sessionId: memberSessionId,
      provider: 'spawn', modelSource: 'unresolved', deniedTools: [], assignedSkills: [], maxDepth: 1,
    })
    const task = await domain.createTask(workspace, team.id, captainId, {
      subject: 'Recover initial result', description: 'Fold only exact durable Provider outcome evidence.',
    })
    const reserved = await domain.reserveInitialAssignment(
      workspace, team.id, captainId, task.id, task.revision, member.sessionId, digest,
    )

    await mountAgentLoopTestDependencies(sessionCtx)
    fibers.push(await sessionCtx.plugin(SqliteSessionPersistence, {
      path: join(sandbox, 'sessions', 'sessions.db'),
    }))
    const childId = SessionId(memberSessionId)
    const session = Session.create(childId, undefined, {
      version: 0,
      id: childId,
      createdAt: Date.now(),
      cwd: workspace,
      parentSession: SessionId(captainId),
      origin: 'subagent',
      delegationDepth: 1,
    })
    session.append('subagent/descriptor', {
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'continuable',
      provider: 'spawn',
      label: 'worker',
      agentProvider: 'mock',
      agentModel: 'mock',
    })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', {
      id: MessageId(`message-initial-${outcome}`),
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    const frame = session.events.find(event => event.type === 'user/message')!
    const checkpoint = {
      initialPromptDigest: digest,
      messageSeq: frame.seq,
      turn: 1,
      step: 1,
      witnessCapabilityDigest: ACTIVE_WITNESS_DIGEST,
      dispatchId: `dispatch-initial-${outcome}`,
      effectId: `effect-initial-${outcome}`,
    }
    await domain.settleInitialAssignment(
      workspace, team.id, member.sessionId, task.id, reserved.attempt.id, checkpoint,
    )
    await domain.enterInitialDispatch(
      workspace, team.id, member.sessionId, task.id, reserved.attempt.id, checkpoint,
    )
    if (outcome === 'assistant-closed' || outcome === 'assistant-open'
      || outcome === 'assistant-team-settled-closed' || outcome === 'assistant-team-settled-open') {
      session.append('assistant/message', {
        turn: 1,
        step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: 'durable initial result' }],
          source: { kind: 'model', provider: 'mock', model: 'mock' },
        }),
      }, { surfaceOp: 'append' })
    }
    if (outcome === 'partial-chunk' || outcome === 'partial-chunk-completed') {
      session.append('assistant/chunk', {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'partial output is not a result' },
      })
    }
    if (outcome === 'assistant-closed' || outcome === 'assistant-team-settled-closed'
      || outcome === 'no-output-completed' || outcome === 'partial-chunk-completed') {
      session.append('step/end', { turn: 1, step: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    }
    if (outcome === 'assistant-team-settled-closed' || outcome === 'assistant-team-settled-open') {
      const assistant = session.events.find(event => event.type === 'assistant/message')!
      await domain.settleInitialAssistantEvidence(
        workspace,
        team.id,
        member.sessionId,
        task.id,
        reserved.attempt.id,
        checkpoint,
        { eventSeq: assistant.seq, eventType: 'assistant/message' },
      )
    }
    await sessionCtx.sessionPersistence.create(session.header)
    await sessionCtx.sessionPersistence.append(session.id, session.events)
    return { workspace, teamId: team.id, attemptId: reserved.attempt.id, memberSessionId }
  } finally {
    for (const fiber of fibers.toReversed()) await fiber.dispose()
    await stack.close()
  }
}

describe('fresh-v2 initial entered-outcome cold reconciliation', () => {
  const roots: string[] = []
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it.each([
    ['assistant-closed', 'parked', 'settled', 'turn-settled'],
    ['assistant-open', 'parked', 'settled', 'turn-settled'],
    ['assistant-team-settled-closed', 'parked', 'settled', 'turn-settled'],
    ['assistant-team-settled-open', 'parked', 'settled', 'turn-settled'],
    ['no-output-completed', 'parked', 'settled', 'turn-settled'],
    ['interrupted', 'reserved', 'dispatch-unknown', undefined],
    ['partial-chunk', 'reserved', 'dispatch-unknown', undefined],
    ['partial-chunk-completed', 'reserved', 'dispatch-unknown', undefined],
  ] as const)('folds %s without replay and stays idempotent after a second restart', async (
    outcome, attemptPhase, dispatchPhase, parkedReason,
  ) => {
    const sandbox = await mkdtemp(join(tmpdir(), `dsh-swarm-initial-outcome-${outcome}-`))
    roots.push(sandbox)
    const seeded = await seedEnteredInitial(sandbox, outcome)
    const first = await mountFreshV2Composition(sandbox, () => new NoReplayAdapter())
    try {
      const attempt = first.ctx.agentSwarmV2Initial.snapshot(seeded.workspace, seeded.teamId)!
        .attempts.find(candidate => candidate.id === seeded.attemptId)!
      expect(attempt.phase).toBe(attemptPhase)
      expect(attempt.dispatchEpochs[0]!.phase).toBe(dispatchPhase)
      expect(attempt.parked?.parkedReason).toBe(parkedReason)
      expect(first.adapter.requests.filter(request => request.sessionId === seeded.memberSessionId)).toHaveLength(0)
      if (outcome === 'no-output-completed') {
        expect(attempt.dispatchEpochs[0]).toMatchObject({ turnEndEvidenceReason: 'completed' })
        expect(attempt.dispatchEpochs[0]).not.toHaveProperty('assistantEvidenceSeq')
      } else if (outcome === 'interrupted' || outcome === 'partial-chunk' || outcome === 'partial-chunk-completed') {
        expect(attempt.diagnostic).toMatch(/no exact assistant result is durable|partial assistant output/)
      } else {
        expect(attempt.dispatchEpochs[0]).toMatchObject({ assistantEvidenceType: 'assistant/message' })
      }
    } finally {
      for (const fiber of first.fibers.toReversed()) await fiber.dispose().catch(() => undefined)
    }

    const second = await mountFreshV2Composition(sandbox, () => new NoReplayAdapter())
    try {
      const attempt = second.ctx.agentSwarmV2Initial.snapshot(seeded.workspace, seeded.teamId)!
        .attempts.find(candidate => candidate.id === seeded.attemptId)!
      expect(attempt.phase).toBe(attemptPhase)
      expect(attempt.dispatchEpochs[0]!.phase).toBe(dispatchPhase)
      expect(second.adapter.requests.filter(request => request.sessionId === seeded.memberSessionId)).toHaveLength(0)
    } finally {
      for (const fiber of second.fibers.toReversed()) await fiber.dispose().catch(() => undefined)
    }
  }, 30_000)
})
