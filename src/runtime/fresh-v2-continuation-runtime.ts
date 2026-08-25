import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent, type UserMessage } from '@deepseek-ai/dsh-session'
import { TeamDomainError } from '../domain/error.js'
import { TeamV2ContinuationRecoveryDomain } from '../domain/team-domain-v2-continuation-recovery.js'
import {
  TeamV2ContinuationDomain,
  type ContinuationDispatchCheckpoint,
} from '../domain/team-domain-v2-continuation.js'
import {
  ContinuationEffectId,
  DispatchId,
  TeamEffectId,
  type ContinuationIntent,
  type TaskAttemptV2,
  type TeamStateV2,
} from '../domain/team-state-v2.js'
import { AttemptId, TaskId } from '../domain/types.js'
import { canonicalV2Digest } from '../protocol/canonical-v2.js'
import type { StorageDomainTeamStoreV2 } from '../storage/storage-domain-team-store-v2.js'
import type { ContinuationRuntime } from '../tools/continuation.js'
import { requireAgent, workspaceOf, type ToolExecutionAuthority } from './authority.js'
import {
  claimedContinuationFrame,
  continuationCheckpointOf,
  continuationFrame,
  continuationFrameDigest,
  currentContinuationAttempt,
  type CurrentContinuationAttempt,
} from './fresh-v2-continuation-fold.js'
import { assistantEvidenceAt } from './fresh-v2-session-fold.js'
import { currentFreshV2TaskAttempt, findFreshV2Membership } from './fresh-v2-initial-support.js'
import type { FreshV2WitnessCapability } from './fresh-v2-witness-capability.js'
import { consumeFreshV2ModelPermit, type FreshV2ModelPermit } from './fresh-v2-model-permit.js'
import { foldEnteredContinuationRecovery } from './fresh-v2-continuation-recovery-fold.js'

const CONTINUATION_DELIVERY_TIMEOUT_MS = 30_000

export class FreshV2ContinuationRuntime implements ContinuationRuntime {
  private readonly domain: TeamV2ContinuationDomain
  private readonly recoveryDomain: TeamV2ContinuationRecoveryDomain
  private readonly modelPermits = new Map<string, FreshV2ModelPermit>()
  private readonly dispatchStreams = new Set<Promise<void>>()
  private readonly delivering = new Set<string>()
  private readonly deliveryUnknown = new Set<string>()
  private closing = false

  constructor(
    private readonly ctx: Context,
    private readonly store: StorageDomainTeamStoreV2,
    private readonly witness: FreshV2WitnessCapability,
  ) {
    this.domain = new TeamV2ContinuationDomain(store)
    this.recoveryDomain = new TeamV2ContinuationRecoveryDomain(store)
  }

  async continueTask(exec: ToolExecutionAuthority, input: {
    readonly taskId: string
    readonly expectedRevision: number
    readonly attemptId: string
    readonly idempotencyKey: string
    readonly checkpointDigest?: string
    readonly wakeCondition?: string
  }): Promise<ContinuationIntent> {
    this.assertOpen()
    const memberAgent = requireAgent(exec)
    const scope = this.scopeOf(memberAgent)
    const membership = findFreshV2Membership(this.store, scope, memberAgent.id)
    if (membership?.role !== 'member') {
      throw new TeamDomainError('only the exact active member may request same-Attempt continuation', 'TEAM_TASK_OWNER_REQUIRED')
    }
    const key = input.idempotencyKey.trim()
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new TeamDomainError('continuation expected revision must be a non-negative safe integer', 'TEAM_INPUT_INVALID')
    }
    if (key.length === 0 || Buffer.byteLength(key, 'utf8') > 512) {
      throw new TeamDomainError('continuation idempotency key is empty or too large', 'TEAM_INPUT_INVALID')
    }
    const continuationEffectId = ContinuationEffectId(`continuation:${canonicalV2Digest(
      'dsh-agent-swarm/a2a/continuation-identity/v1',
      { teamId: membership.team.id, taskId: input.taskId, attemptId: input.attemptId, idempotencyKey: key },
    )}`)
    return await this.domain.requestMemberContinuation(scope, membership.team.id, {
      taskId: TaskId(input.taskId),
      expectedTaskRevision: input.expectedRevision,
      attemptId: AttemptId(input.attemptId),
      continuationEffectId,
      principal: { kind: 'member', memberId: membership.member.name, memberSessionId: memberAgent.id },
      ...(input.checkpointDigest === undefined ? {} : { checkpointDigest: input.checkpointDigest }),
      ...(input.wakeCondition === undefined ? {} : { wakeCondition: input.wakeCondition }),
    })
  }

  /** Reconcile exact entered continuations once from durable state before normal admission opens. */
  async reconcileColdEnteredDispatches(): Promise<void> {
    this.assertOpen()
    for (const { scope, team } of this.store.listAll()) {
      for (const attempt of team.attempts) {
        const intent = attempt.currentContinuationIntent
        const dispatch = intent?.currentDispatchId === undefined
          ? undefined : attempt.dispatchEpochs.find(candidate => candidate.dispatchId === intent.currentDispatchId)
        if (intent?.phase !== 'dispatch-entered' || dispatch?.phase !== 'dispatch-entered') continue
        const memberSessionId = SessionId(attempt.memberSessionId)
        if (this.ctx.agents.get(memberSessionId) !== undefined || this.ctx.sessions.get(memberSessionId) !== undefined) continue
        const current = currentContinuationAttempt(team, attempt.memberSessionId)
        if (current === undefined) continue
        const checkpoint = continuationCheckpointOf(current)
        let preparation: Awaited<ReturnType<Context['sessionPersistence']['prepare']>>
        try {
          preparation = await this.ctx.sessionPersistence.prepare(
            memberSessionId, AbortSignal.timeout(CONTINUATION_DELIVERY_TIMEOUT_MS),
          )
        } catch (error: unknown) {
          if (this.ctx.agents.get(memberSessionId) !== undefined
            || this.ctx.sessions.get(memberSessionId) !== undefined) continue
          this.ctx.logger.warn(
            `agent-swarm: cold continuation preparation failed for ${attempt.memberSessionId}: ${String(error)}`,
          )
          continue
        }
        try {
          if (this.ctx.agents.get(memberSessionId) !== undefined
            || this.ctx.sessions.get(memberSessionId) !== undefined) continue
          const evidence = foldEnteredContinuationRecovery(
            preparation.session.events, checkpoint, continuationFrameDigest(this.frameOf(current)),
          )
          if (evidence.kind === 'dispatch-unknown') {
            await this.recoveryDomain.markDispatchUnknown(scope, team.id, {
              checkpoint,
              diagnostic: evidence.reason,
            })
            continue
          }
          if (evidence.kind === 'turn-end-evidence') {
            await this.recoveryDomain.settleTurnEndEvidence(scope, team.id, {
              checkpoint,
              eventSeq: evidence.eventSeq,
              reason: evidence.reason,
            })
            continue
          }
          if (evidence.turnEndSeq !== undefined) {
            await this.recoveryDomain.settleAssistantAndPark(scope, team.id, {
              checkpoint,
              assistantEventSeq: evidence.eventSeq,
              turnEndSeq: evidence.turnEndSeq,
            })
            continue
          }
          await this.domain.settleAssistantEvidence(scope, team.id, {
            checkpoint,
            eventSeq: evidence.eventSeq,
            eventType: 'assistant/message',
          })
        } finally {
          preparation[Symbol.dispose]()
        }
      }
    }
  }

  /** Returns true only when this request is the exact continuation dispatch. */
  async beforeAgentRequest(input: {
    readonly agent: Agent
    readonly turn: number
    readonly step: number
    readonly signal: AbortSignal
  }): Promise<boolean> {
    if (this.closing) return false
    const scope = this.scopeOf(input.agent)
    const membership = findFreshV2Membership(this.store, scope, input.agent.id)
    if (membership?.role !== 'member') return false
    await this.witness.assertCurrent()
    const currentTask = currentFreshV2TaskAttempt(membership.team, input.agent.id)
    if (currentTask === undefined) return false
    let current = currentContinuationAttempt(membership.team, input.agent.id)
    if (current === undefined) {
      if (currentTask.attempt.phase === 'reserved') return false
      const last = currentTask.attempt.dispatchEpochs.at(-1)
      if (currentTask.attempt.phase === 'running' && last?.phase === 'settled' && last.turn === input.turn) return false
      throw new TeamDomainError('new Team-owned turn lacks an admitted continuation frame', 'TEAM_ASSIGNMENT_NOT_CLAIMED')
    }
    if (current.dispatch.phase === 'dispatch-entered') {
      throw new TeamDomainError('prior continuation dispatch lacks durable assistant evidence', 'TEAM_ATTEMPT_STALE')
    }
    if (current.dispatch.phase === 'settled' && current.attempt.phase === 'running') return false
    if (current.attempt.phase !== 'parked' || current.intent.phase !== 'admitted'
      || current.dispatch.phase !== 'frame-pending') {
      throw new TeamDomainError('continuation Attempt is not frame-claimable', 'TEAM_ATTEMPT_STALE')
    }
    const text = this.frameOf(current)
    const claimed = claimedContinuationFrame(
      input.agent.session, input.turn, input.step, continuationFrameDigest(text), current.dispatch.frameMessageId,
    )
    input.signal.throwIfAborted()
    if (!await this.ctx.sessions.flush(input.agent.session)) {
      throw new TeamDomainError('continuation frame requires durable Session persistence', 'TEAM_RUNTIME_NOT_STARTED')
    }
    input.signal.throwIfAborted()
    if (current.dispatch.frameMessageId === undefined) {
      await this.domain.recordFrameAccepted(scope, membership.team.id, {
        taskId: current.task.id,
        attemptId: current.attempt.id,
        continuationEffectId: current.intent.continuationEffectId,
        dispatchId: current.dispatch.dispatchId,
        frameMessageId: claimed.messageId,
      })
    }
    const refreshedMembership = findFreshV2Membership(this.store, scope, input.agent.id)
    if (refreshedMembership?.role !== 'member') throw new TeamDomainError('continuation membership changed', 'TEAM_ATTEMPT_STALE')
    current = currentContinuationAttempt(refreshedMembership.team, input.agent.id)
    if (current === undefined || current.dispatch.frameMessageId !== claimed.messageId
      || this.frameOf(current) !== text) {
      throw new TeamDomainError('continuation frame identity changed before dispatch', 'TEAM_ATTEMPT_STALE')
    }
    const checkpoint: ContinuationDispatchCheckpoint = {
      taskId: current.task.id,
      attemptId: current.attempt.id,
      continuationEffectId: current.intent.continuationEffectId,
      dispatchId: current.dispatch.dispatchId,
      resumeEffectId: current.intent.resumeEffectId!,
      frameMessageId: claimed.messageId,
      messageSeq: claimed.messageSeq,
      turn: input.turn,
      step: input.step,
      witnessCapabilityDigest: current.dispatch.witnessCapabilityDigest,
    }
    await this.domain.claimFrame(scope, refreshedMembership.team.id, checkpoint)
    this.modelPermits.set(input.agent.id, { signal: input.signal, turn: input.turn, step: input.step })
    return true
  }

  wrapModelStream(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> | undefined {
    if (!this.ownsModelDispatch(options)) return undefined
    return (async function* (runtime: FreshV2ContinuationRuntime): AsyncIterable<StreamChunk> {
      let complete!: () => void
      const completion = new Promise<void>(resolveCompletion => { complete = resolveCompletion })
      runtime.dispatchStreams.add(completion)
      try {
        runtime.assertOpen()
        await runtime.enterModelDispatch(options)
        runtime.assertOpen()
        yield* next()
      } finally {
        complete()
        runtime.dispatchStreams.delete(completion)
      }
    })(this)
  }

  async foldInboxClaimed(agent: Agent, message: UserMessage): Promise<void> {
    if (this.closing || message.source.kind !== 'plugin' || message.source.plugin !== 'dsh-agent-swarm'
      || message.content.length !== 1 || message.content[0]?.type !== 'text') return
    const scope = this.scopeOf(agent)
    const membership = findFreshV2Membership(this.store, scope, agent.id)
    if (membership?.role !== 'member') return
    const current = currentContinuationAttempt(membership.team, agent.id)
    if (current === undefined || current.intent.phase !== 'admitted' || current.dispatch.phase !== 'frame-pending'
      || message.content[0].text !== this.frameOf(current)) return
    await this.domain.recordFrameAccepted(scope, membership.team.id, {
      taskId: current.task.id,
      attemptId: current.attempt.id,
      continuationEffectId: current.intent.continuationEffectId,
      dispatchId: current.dispatch.dispatchId,
      frameMessageId: message.id,
    })
  }

  async foldAssistantEvidence(session: Session, event: SessionEvent<'assistant/message'>): Promise<boolean> {
    const scope = resolve(session.header.cwd ?? process.cwd())
    const membership = findFreshV2Membership(this.store, scope, session.id)
    if (membership?.role !== 'member') return false
    const current = currentContinuationAttempt(membership.team, session.id)
    if (current === undefined || current.intent.phase !== 'dispatch-entered'
      || current.dispatch.phase !== 'dispatch-entered') return false
    const checkpoint = continuationCheckpointOf(current)
    if (event.data.turn !== checkpoint.turn || event.data.step !== checkpoint.step) return false
    assistantEvidenceAt(session, event.seq, event.type, checkpoint.turn, checkpoint.step)
    await this.domain.settleAssistantEvidence(scope, membership.team.id, {
      checkpoint, eventSeq: event.seq, eventType: event.type,
    })
    return true
  }

  async foldTurnEnd(session: Session, event: SessionEvent<'turn/end'>): Promise<void> {
    const scope = resolve(session.header.cwd ?? process.cwd())
    const membership = findFreshV2Membership(this.store, scope, session.id)
    if (membership?.role !== 'member') return
    const current = currentFreshV2TaskAttempt(membership.team, session.id)
    const last = current?.attempt.dispatchEpochs.at(-1)
    if (current === undefined || current.attempt.phase !== 'running' || last?.phase !== 'settled'
      || last.turn !== event.data.turn) return
    await this.domain.parkAfterTurn(scope, membership.team.id, {
      taskId: current.task.id,
      attemptId: current.attempt.id,
      memberSessionId: session.id,
      settledTurn: event.data.turn,
      turnEndSeq: event.seq,
    })
    const agent = this.ctx.agents.get(SessionId(session.id))
    if (agent?.session === session && agent.status === 'idle') await this.foldAgentIdle(agent)
  }

  async foldAgentIdle(agent: Agent): Promise<void> {
    if (this.closing || agent.status !== 'idle') return
    const scope = this.scopeOf(agent)
    const membership = findFreshV2Membership(this.store, scope, agent.id)
    if (membership?.role !== 'member') return
    const taskAttempt = currentFreshV2TaskAttempt(membership.team, agent.id)
    const intent = taskAttempt?.attempt.currentContinuationIntent
    if (taskAttempt?.attempt.phase !== 'parked' || intent?.phase !== 'requested') return
    const lastSeq = taskAttempt.attempt.parked?.lastSessionSeq
    const end = lastSeq === undefined ? undefined : agent.session.events.find(event => event.seq === lastSeq)
    if (end?.type !== 'turn/end' || (end.data.reason.kind !== 'completed' && end.data.reason.kind !== 'max-tokens')) return
    const witnessDigest = await this.witness.assertCurrent()
    const ordinal = taskAttempt.attempt.dispatchEpochs.length + 1
    const admitted = await this.domain.admitRequested(scope, membership.team.id, {
      taskId: taskAttempt.task.id,
      attemptId: taskAttempt.attempt.id,
      memberSessionId: agent.id,
      continuationEffectId: intent.continuationEffectId,
      resumeEffectId: TeamEffectId(`effect:${intent.continuationEffectId}:resume`),
      dispatchId: DispatchId(`dispatch:${taskAttempt.attempt.id}:continuation:${ordinal}`),
      witnessCapabilityDigest: witnessDigest,
    })
    await this.deliverAdmitted(scope, membership.team.id, admitted.attempt)
  }

  async dispose(): Promise<void> {
    this.closing = true
    this.modelPermits.clear()
    await Promise.allSettled(this.dispatchStreams)
    this.delivering.clear()
  }

  private ownsModelDispatch(options: GenerateOptions): boolean {
    if (options.sessionId === undefined) return false
    const agent = this.ctx.agents.get(SessionId(options.sessionId))
    const session = this.ctx.sessions.get(SessionId(options.sessionId))
    if (agent === undefined || session === undefined || agent.session !== session) return false
    const membership = findFreshV2Membership(this.store, this.scopeOf(agent), agent.id)
    if (membership?.role !== 'member') return false
    const current = currentContinuationAttempt(membership.team, agent.id)
    if (current === undefined) return false
    this.witness.assertDigest(current.dispatch.witnessCapabilityDigest)
    const permit = this.modelPermits.get(agent.id)
    if (permit === undefined || options.signal !== permit.signal) {
      throw new TeamDomainError('continuation model request lacks its exact one-shot Agent Loop permit', 'TEAM_ATTEMPT_STALE')
    }
    if (current.attempt.phase !== 'parked' || current.intent.phase !== 'dispatch-pending'
      || current.dispatch.phase !== 'dispatch-pending'
      || current.dispatch.turn !== permit.turn || current.dispatch.step !== permit.step) {
      throw new TeamDomainError('continuation model request lacks its exact dispatch fence', 'TEAM_ATTEMPT_STALE')
    }
    return true
  }

  private async enterModelDispatch(options: GenerateOptions): Promise<void> {
    const { agent, session } = consumeFreshV2ModelPermit(this.ctx, this.modelPermits, options, 'continuation')
    const scope = this.scopeOf(agent)
    const membership = findFreshV2Membership(this.store, scope, agent.id)
    if (membership?.role !== 'member') throw new TeamDomainError('continuation membership changed', 'TEAM_ATTEMPT_STALE')
    const current = currentContinuationAttempt(membership.team, agent.id)
    if (current === undefined || current.dispatch.phase !== 'dispatch-pending') {
      throw new TeamDomainError('continuation request lost its exact Attempt', 'TEAM_ATTEMPT_STALE')
    }
    const checkpoint = continuationCheckpointOf(current)
    this.witness.assertDigest(checkpoint.witnessCapabilityDigest)
    const digest = continuationFrameDigest(this.frameOf(current))
    const before = claimedContinuationFrame(session, checkpoint.turn, checkpoint.step, digest, checkpoint.frameMessageId)
    if (before.messageSeq !== checkpoint.messageSeq) throw new TeamDomainError('continuation message sequence changed', 'TEAM_ATTEMPT_STALE')
    options.signal?.throwIfAborted()
    if (!await this.ctx.sessions.flush(session)) {
      throw new TeamDomainError('continuation dispatch requires durable Session persistence', 'TEAM_RUNTIME_NOT_STARTED')
    }
    options.signal?.throwIfAborted()
    const after = claimedContinuationFrame(session, checkpoint.turn, checkpoint.step, digest, checkpoint.frameMessageId)
    if (after.messageSeq !== checkpoint.messageSeq) throw new TeamDomainError('continuation message sequence changed', 'TEAM_ATTEMPT_STALE')
    await this.domain.enterDispatch(scope, membership.team.id, checkpoint)
    const readBackMembership = findFreshV2Membership(this.store, scope, agent.id)
    const readBack = readBackMembership?.role === 'member'
      ? currentContinuationAttempt(readBackMembership.team, agent.id) : undefined
    if (readBack?.dispatch.phase !== 'dispatch-entered' || readBack.dispatch.dispatchId !== checkpoint.dispatchId) {
      throw new TeamDomainError('continuation model-dispatch witness read-back failed', 'TEAM_MIGRATION_VERIFY_FAILED')
    }
  }

  private async deliverAdmitted(scope: string, teamId: TeamStateV2['id'], attempt: TaskAttemptV2): Promise<void> {
    const intent = attempt.currentContinuationIntent
    const dispatch = intent?.currentDispatchId === undefined
      ? undefined : attempt.dispatchEpochs.find(epoch => epoch.dispatchId === intent.currentDispatchId)
    if (intent?.phase !== 'admitted' || intent.resumeEffectId === undefined || dispatch?.phase !== 'frame-pending') return
    const key = intent.resumeEffectId
    if (this.delivering.has(key) || this.deliveryUnknown.has(key) || dispatch.frameMessageId !== undefined) return
    this.delivering.add(key)
    try {
      const team = this.store.read(scope, teamId)
      if (team === undefined) return
      const captain = this.ctx.agents.get(SessionId(team.captainSessionId))
      if (captain === undefined || !this.ctx.agents.roots().includes(captain)) return
      const current = currentContinuationAttempt(team, attempt.memberSessionId)
      if (current === undefined || current.intent.resumeEffectId !== intent.resumeEffectId) return
      const messageId = await this.ctx.subagents.followup(
        captain,
        SessionId(attempt.memberSessionId),
        [{ type: 'text', text: this.frameOf(current) }],
        {
          source: { kind: 'plugin', plugin: 'dsh-agent-swarm' },
          signal: AbortSignal.timeout(CONTINUATION_DELIVERY_TIMEOUT_MS),
        },
      )
      await this.domain.recordFrameAccepted(scope, teamId, {
        taskId: current.task.id,
        attemptId: current.attempt.id,
        continuationEffectId: current.intent.continuationEffectId,
        dispatchId: current.dispatch.dispatchId,
        frameMessageId: messageId,
      })
    } catch (error) {
      this.deliveryUnknown.add(key)
      this.ctx.logger.error(`agent-swarm: continuation ${key} delivery outcome is unknown: ${String(error)}`)
    } finally {
      this.delivering.delete(key)
    }
  }

  private frameOf(current: CurrentContinuationAttempt): string {
    return continuationFrame({
      teamId: current.team.id,
      taskId: current.task.id,
      attemptId: current.attempt.id,
      continuationEffectId: current.intent.continuationEffectId,
      resumeEffectId: current.intent.resumeEffectId!,
      dispatchId: current.dispatch.dispatchId,
      ordinal: current.dispatch.ordinal,
    })
  }

  private scopeOf(agent: Agent): string { return resolve(workspaceOf(agent)) }
  private assertOpen(): void {
    if (this.closing) throw new TeamDomainError('fresh-v2 continuation runtime is closing', 'TEAM_RUNTIME_CLOSING')
  }
}
