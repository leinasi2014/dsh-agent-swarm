/**
 * SW-I1a typed Human Control gateway over the durable interaction overlay.
 *
 * This gateway is a headless, host-neutral command surface. It shares the
 * ONE `HumanInteractionRequest/Receipt` contract
 * and the ONE `agent_swarm_human` Storage Domain with `CaptainLiaison`; it
 * keeps no second receipt authority. Every Team mutation still lands through
 * {@link TeamDomainPort}, and every request lifecycle is serialized by
 * request id through the overlay store's process-local lock.
 */
import { Buffer } from 'node:buffer'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expectDomain, TeamDomainError } from '../domain/error.js'
import type { TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import type { TaskId, TeamId, TeamMessage, TeamTask } from '../domain/types.js'
import type { ToolExecutionAuthority } from '../runtime/authority.js'
import {
  HUMAN_INTERACTION_CONTROL_INTENTS,
  HUMAN_INTERACTION_ID_PATTERN,
  sameHumanInteractionRequest,
  type HumanInteractionReceipt,
  type HumanInteractionRecord,
  type HumanInteractionRequest,
} from './human-interaction-contract.js'
import type { HumanInteractionOverlayStore } from './human-interaction-store.js'
import { quarantineInteractionOutcome } from './human-interaction-store.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Assembled SW-I1a typed Control surface. */
    agentSwarmHumanControl: HumanControlGateway
  }
}

/** Bounded sizes enforced at the headless command boundary. */
const MAX_BODY_BYTES = 4_096
const MAX_DIAGNOSTIC_BYTES = 2_048
const MAX_MEMBER_NAME_BYTES = 64
const MAX_TASK_ID_BYTES = 128
const MAX_ATTEMPT_ID_BYTES = 128
const MAX_SESSION_BYTES = 256
const MAX_PRINCIPAL_BYTES = 256

export interface HumanControlGatewayDeps {
  readonly ctx: Context
  readonly domain: () => TeamDomainPort
  readonly overlay: HumanInteractionOverlayStore
  readonly now?: () => number
  readonly sendMessage: (exec: ToolExecutionAuthority, target: string, content: string, delivery: 'quiet' | 'wakeup') => Promise<TeamMessage>
  readonly interruptMember: (exec: ToolExecutionAuthority, name: string) => Promise<{ name: string; previousStatus: 'running' | 'idle' | 'inactive' }>
  readonly reassignTask: (exec: ToolExecutionAuthority, taskId: string, expectedRevision: number, reason: string) => Promise<TeamTask>
  readonly reviewTask: (
    exec: ToolExecutionAuthority,
    input: { taskId: string; expectedRevision: number; attemptId: string; decision: 'accept' | 'reject'; diagnostic?: string },
  ) => Promise<{ task: TeamTask; decision: 'accept' | 'reject' }>
  /** Optional host attestation for `authenticated-human` provenance. */
  readonly verifyHumanPrincipal?: (principalRef: string, request: HumanInteractionRequest) => boolean | Promise<boolean>
}

/**
 * Admission authority is supplied independently of the request payload.
 * Captain mediation is bound to the actual Tool/host execution Agent;
 * authenticated-human is bound to a host-verified opaque principal.
 */
export type HumanControlAdmission =
  | { readonly kind: 'captain'; readonly exec: ToolExecutionAuthority }
  | { readonly kind: 'authenticated-human'; readonly principalRef: string }

function bounded(value: string, maxBytes: number): boolean {
  return value !== '' && Buffer.byteLength(value, 'utf8') <= maxBytes
}

function receiptOf(record: HumanInteractionRecord): HumanInteractionReceipt {
  return structuredClone(record.receipt)
}

/** Truncate a diagnostic to a UTF-8 byte bound without splitting a code point. */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  const parts: string[] = []
  let bytes = 0
  for (const codePoint of value) {
    const size = Buffer.byteLength(codePoint, 'utf8')
    if (bytes + size > maxBytes) break
    parts.push(codePoint)
    bytes += size
  }
  return parts.join('')
}

/** Headless typed Control handler backed by the durable interaction overlay. */
export class HumanControlGateway {
  constructor(private readonly deps: HumanControlGatewayDeps) {}

  /** Submit one typed control; the whole lifecycle is serialized by request id. */
  async submit(
    scope: TeamScope,
    request: HumanInteractionRequest,
    admission: HumanControlAdmission,
    signal: AbortSignal,
  ): Promise<HumanInteractionReceipt> {
    this.deps.overlay.assertAvailable()
    this.validateRequest(request)
    if (signal.aborted) {
      throw new TeamDomainError('control request was aborted before admission', 'TEAM_INTERACTION_ABORTED')
    }
    const captain = await this.authorize(scope, request, admission)
    return await this.deps.overlay.runRequestExclusive(
      scope,
      request.requestId,
      () => this.submitLocked(scope, request, signal, captain),
    )
  }

  /** Cancel one pending control or tombstone an unknown id durably. */
  async cancel(
    scope: TeamScope,
    request: HumanInteractionRequest,
    admission: HumanControlAdmission,
    diagnostic = 'cancelled by Human Control',
  ): Promise<HumanInteractionReceipt> {
    this.deps.overlay.assertAvailable()
    this.validateRequest(request)
    await this.authorize(scope, request, admission)
    return await this.deps.overlay.runRequestExclusive(
      scope,
      request.requestId,
      () => this.cancelLocked(scope, request, diagnostic),
    )
  }

  private async submitLocked(
    scope: TeamScope,
    request: HumanInteractionRequest,
    signal: AbortSignal,
    captain: Agent,
  ): Promise<HumanInteractionReceipt> {
    const now = this.now()
    const existing = this.deps.overlay.get(scope, request.requestId)
    if (existing !== undefined) {
      if (this.deps.overlay.isOutcomeUnknown(scope, request.requestId)) throw this.outcomeUnknown()
      this.ensureSameRequest(existing, request)
      this.rejectTerminal(existing, request)
      throw this.duplicateError(request, existing)
    }
    if (request.expiresAt !== undefined && request.expiresAt <= now) {
      const expired = this.record(scope, request, now, 'expired', 'TEAM_INTERACTION_EXPIRED', 'control expired before admission')
      await this.commitOrReject(scope, expired, 'control expired before admission')
      throw this.error('TEAM_INTERACTION_EXPIRED', 'control expired before admission', request)
    }
    const membership = await this.deps.domain().requireMembership(scope, captain.id)
    expectDomain(membership.team.id === request.teamId, 'caller is not a participant of this Team', 'TEAM_UNAUTHORIZED')
    const team = membership.team
    expectDomain(
      request.expectedTeamRevision === team.revision,
      `expected Team revision ${request.expectedTeamRevision} is stale; current is ${team.revision}`,
      'TEAM_INTERACTION_STALE_REVISION',
    )
    this.assertControlFences(team, request)

    const pending = this.record(scope, request, now, 'pending', undefined, undefined)
    const committed = await this.deps.overlay.commitIfAbsent(pending)
    if (committed !== undefined) {
      this.ensureSameRequest(committed, request)
      this.rejectTerminal(committed, request)
      throw this.duplicateError(request, committed)
    }

    let executedReceipt: HumanInteractionReceipt
    try {
      executedReceipt = await this.execute(scope, request, { agent: captain, signal }, team)
    } catch (error) {
      // Dependency calls may commit a Team effect and then fail while reading
      // the resulting revision or returning through an adapter. I1a has no
      // durable effect correlation, so it must not turn that uncertain window
      // into a false `failed` receipt that could invite a second request id.
      await quarantineInteractionOutcome(this.deps.overlay, scope, request.requestId, this.now.bind(this))
      throw this.outcomeUnknown(error)
    }
    const updated: HumanInteractionRecord = {
      ...pending,
      receipt: executedReceipt,
      updatedAt: this.now(),
    }
    try {
      await this.deps.overlay.update(updated, pending.receipt.updatedAt)
      return receiptOf(updated)
    } catch (error) {
      await quarantineInteractionOutcome(this.deps.overlay, scope, request.requestId, this.now.bind(this))
      throw this.outcomeUnknown(error)
    }
  }

  private async cancelLocked(scope: TeamScope, request: HumanInteractionRequest, diagnostic: string): Promise<HumanInteractionReceipt> {
    const now = this.now()
    if (this.deps.overlay.isOutcomeUnknown(scope, request.requestId)) throw this.outcomeUnknown()
    const existing = this.deps.overlay.get(scope, request.requestId)
    if (existing !== undefined) {
      this.ensureSameRequest(existing, request)
      if (existing.receipt.status === 'cancelled') return receiptOf(existing)
      if (existing.receipt.status === 'pending' || existing.receipt.status === 'acknowledged') {
        const cancelled: HumanInteractionRecord = {
          ...existing,
          receipt: {
            ...existing.receipt,
            status: 'cancelled',
            code: 'TEAM_INTERACTION_CANCELLED',
            diagnostic,
            updatedAt: now,
          },
          updatedAt: now,
        }
        await this.deps.overlay.update(cancelled, existing.receipt.updatedAt)
        return receiptOf(cancelled)
      }
      throw this.error('TEAM_INTERACTION_LATE', `request "${request.requestId}" already ${existing.receipt.status}; cannot cancel`, request)
    }
    const tombstone = this.record(scope, request, now, 'cancelled', 'TEAM_INTERACTION_CANCELLED', diagnostic)
    await this.commitOrReject(scope, tombstone, diagnostic)
    return receiptOf(tombstone)
  }

  private async commitOrReject(
    _scope: TeamScope,
    record: HumanInteractionRecord,
    diagnostic: string,
  ): Promise<void> {
    const committed = await this.deps.overlay.commitIfAbsent(record)
    if (committed === undefined) return
    this.ensureSameRequest(committed, record.request)
    if (committed.receipt.status === 'cancelled' || committed.receipt.status === 'expired') {
      throw this.error(committed.receipt.status === 'cancelled' ? 'TEAM_INTERACTION_CANCELLED' : 'TEAM_INTERACTION_EXPIRED', diagnostic, record.request)
    }
    throw this.duplicateError(record.request, committed)
  }

  private validateRequest(request: HumanInteractionRequest): void {
    if (request.schemaVersion !== 1) throw this.error('TEAM_INTERACTION_INVALID', 'schemaVersion must be 1', request)
    if (!HUMAN_INTERACTION_ID_PATTERN.test(request.requestId)) {
      throw this.error('TEAM_INTERACTION_REQUEST_ID_INVALID', 'requestId is malformed', request)
    }
    if (!bounded(request.teamId, MAX_TASK_ID_BYTES)) throw this.error('TEAM_INTERACTION_INVALID', 'teamId is invalid', request)
    if (!bounded(request.source.captainSessionId, MAX_SESSION_BYTES)) throw this.error('TEAM_INTERACTION_INVALID', 'captainSessionId is invalid', request)
    if (request.source.kind === 'authenticated-human' && !bounded(request.source.principalRef ?? '', MAX_PRINCIPAL_BYTES)) {
      throw this.error('TEAM_INTERACTION_INVALID', 'principalRef is invalid', request)
    }
    if (!HUMAN_INTERACTION_CONTROL_INTENTS.includes(request.intent as typeof HUMAN_INTERACTION_CONTROL_INTENTS[number])) {
      throw this.error('TEAM_INTERACTION_INVALID', `intent "${String(request.intent)}" is not a typed Control`, request)
    }
    if (!Number.isSafeInteger(request.createdAt) || request.createdAt < 0) {
      throw this.error('TEAM_INTERACTION_INVALID', 'createdAt is invalid', request)
    }
    if (request.expiresAt !== undefined && (!Number.isSafeInteger(request.expiresAt) || request.expiresAt <= request.createdAt)) {
      throw this.error('TEAM_INTERACTION_INVALID', 'expiresAt is invalid', request)
    }
    if (!Number.isSafeInteger(request.expectedTeamRevision) || request.expectedTeamRevision < 1) {
      throw this.error('TEAM_INTERACTION_INVALID', 'expectedTeamRevision is invalid', request)
    }
    if (request.body !== undefined && !bounded(request.body, MAX_BODY_BYTES)) throw this.error('TEAM_INTERACTION_INVALID', 'body is too large', request)
    if (request.diagnostic !== undefined && !bounded(request.diagnostic, MAX_DIAGNOSTIC_BYTES)) {
      throw this.error('TEAM_INTERACTION_INVALID', 'diagnostic is too large', request)
    }
    if (request.intent === 'review-task' && request.decision !== 'accept' && request.decision !== 'reject') {
      throw this.error('TEAM_INTERACTION_INVALID', 'review-task requires decision accept or reject', request)
    }
    if (request.intent === 'interrupt-member' || request.intent === 'wake-member') {
      expectDomain(request.target.kind === 'member', 'member control requires a member target', 'TEAM_INTERACTION_TARGET_INVALID')
      expectDomain(
        request.target.kind === 'member' && bounded(request.target.memberName, MAX_MEMBER_NAME_BYTES),
        'memberName is invalid',
        'TEAM_INTERACTION_TARGET_INVALID',
      )
    }
    if (request.intent === 'correct-task' || request.intent === 'reassign-task' || request.intent === 'review-task') {
      expectDomain(request.target.kind === 'task', 'task control requires a task target', 'TEAM_INTERACTION_TARGET_INVALID')
      expectDomain(request.attemptId !== undefined && bounded(request.attemptId, MAX_ATTEMPT_ID_BYTES), 'attemptId is invalid', 'TEAM_INTERACTION_TARGET_INVALID')
      expectDomain(
        request.target.kind === 'task' && bounded(request.target.taskId, MAX_TASK_ID_BYTES),
        'taskId is invalid',
        'TEAM_INTERACTION_TARGET_INVALID',
      )
    }
  }

  private async authorize(
    scope: TeamScope,
    request: HumanInteractionRequest,
    admission: HumanControlAdmission,
  ): Promise<Agent> {
    const captain = this.deps.ctx.agents.get(SessionId(request.source.captainSessionId))
    if (captain === undefined || !this.deps.ctx.agents.roots().includes(captain)) {
      throw this.error('TEAM_INTERACTION_CAPTAIN_REQUIRED', 'Human Control requires the exact live root captain', request)
    }
    if (request.source.kind === 'captain-mediated') {
      const caller = admission.kind === 'captain' ? admission.exec.agent : undefined
      if (caller !== captain) {
        throw this.error(
          'TEAM_INTERACTION_CAPTAIN_REQUIRED',
          'captain-mediated control requires caller-bound authority from the exact live root captain',
          request,
        )
      }
    } else {
      if (admission.kind !== 'authenticated-human'
        || admission.principalRef !== request.source.principalRef) {
        throw this.error('TEAM_INTERACTION_NO_PRINCIPAL', 'authenticated-human admission does not match the request principal', request)
      }
      const attested = this.deps.verifyHumanPrincipal === undefined
        ? false
        : await this.deps.verifyHumanPrincipal(admission.principalRef, request)
      if (attested !== true) {
        throw this.error('TEAM_INTERACTION_NO_PRINCIPAL', 'authenticated-human provenance is unavailable without host attestation', request)
      }
    }
    const membership = await this.deps.domain().requireMembership(scope, captain.id)
    expectDomain(membership.role === 'captain' && membership.team.id === request.teamId, 'caller is not the captain of this Team', 'TEAM_UNAUTHORIZED')
    return captain
  }

  private assertControlFences(
    team: Awaited<ReturnType<TeamDomainPort['requireMembership']>>['team'],
    request: HumanInteractionRequest,
  ): void {
    if (request.target.kind === 'member') {
      const name = request.target.memberName
      expectDomain(
        team.members.some(member => member.name === name && member.phase === 'active'),
        `active member "${name}" not found`,
        'TEAM_INTERACTION_TARGET_NOT_FOUND',
      )
      return
    }
    expectDomain(request.target.kind === 'task', 'task control requires a task target', 'TEAM_INTERACTION_TARGET_INVALID')
    const taskId = this.taskTargetId(request)
    const task = team.tasks.find(candidate => candidate.id === taskId)
    expectDomain(task !== undefined, `task "${taskId}" not found`, 'TEAM_INTERACTION_TARGET_NOT_FOUND')
    if (request.expectedTaskRevision === undefined) {
      throw this.error('TEAM_INTERACTION_INVALID', 'expectedTaskRevision is required for task controls', request)
    }
    if (request.attemptId === undefined) {
      throw this.error('TEAM_INTERACTION_INVALID', 'attemptId is required for task controls', request)
    }
    expectDomain(
      task.revision === request.expectedTaskRevision,
      `expected task revision ${request.expectedTaskRevision} is stale; current is ${task.revision}`,
      'TEAM_INTERACTION_STALE_TASK_REVISION',
    )
    if (task.currentAttemptId !== request.attemptId) {
      const referenced = team.attempts.find(attempt => attempt.id === request.attemptId)
      if (referenced !== undefined && referenced.phase !== 'running') {
        throw this.error('TEAM_INTERACTION_LATE', 'referenced attempt already settled; it cannot revive a newer attempt', request)
      }
      throw this.error('TEAM_INTERACTION_ATTEMPT_STALE', `attempt "${request.attemptId}" is stale`, request)
    }
  }

  private async execute(
    scope: TeamScope,
    request: HumanInteractionRequest,
    exec: ToolExecutionAuthority,
    team: Awaited<ReturnType<TeamDomainPort['requireMembership']>>['team'],
  ): Promise<HumanInteractionReceipt> {
    const now = this.now()
    switch (request.intent) {
      case 'interrupt-member': {
        const name = this.memberTargetName(request)
        const interrupted = await this.deps.interruptMember(exec, name)
        return this.executedReceipt(request, now, {
          resultingTeamRevision: team.revision,
          diagnostic: `Interrupted ${name}; previous=${interrupted.previousStatus}`,
        })
      }
      case 'wake-member': {
        const name = this.memberTargetName(request)
        const content = request.body?.trim() || 'Team control requested a wakeup.'
        const message = await this.deps.sendMessage(exec, name, content, 'wakeup')
        return this.executedReceipt(request, now, {
          resultingTeamRevision: await this.latestTeamRevision(scope, request.teamId, exec),
          routedMessageId: message.id,
        })
      }
      case 'correct-task': {
        const taskId = this.taskTargetId(request)
        const task = team.tasks.find(candidate => candidate.id === taskId)
        const owner = team.members.find(member => member.sessionId === task?.ownerSessionId)
        expectDomain(task !== undefined && task.ownerSessionId !== undefined && owner !== undefined, 'correct-task owner is not on the roster', 'TEAM_INTERACTION_TARGET_NOT_FOUND')
        const content = request.body?.trim() || 'Team control requested a correction.'
        const message = await this.deps.sendMessage(exec, owner!.name, content, 'wakeup')
        return this.executedReceipt(request, now, {
          resultingTeamRevision: await this.latestTeamRevision(scope, request.teamId, exec),
          routedMessageId: message.id,
          resultingTaskId: task!.id,
        })
      }
      case 'reassign-task': {
        const taskId = this.taskTargetId(request)
        const reason = request.diagnostic?.trim() || request.body?.trim() || 'Human control reassign'
        const task = await this.deps.reassignTask(exec, taskId, request.expectedTaskRevision!, reason)
        return this.executedReceipt(request, now, {
          resultingTeamRevision: await this.latestTeamRevision(scope, request.teamId, exec),
          resultingTaskId: task.id,
        })
      }
      case 'review-task': {
        const outcome = await this.deps.reviewTask(exec, {
          taskId: this.taskTargetId(request),
          expectedRevision: request.expectedTaskRevision!,
          attemptId: request.attemptId!,
          decision: request.decision!,
          ...(request.diagnostic === undefined ? {} : { diagnostic: request.diagnostic }),
        })
        return this.executedReceipt(request, now, {
          resultingTeamRevision: await this.latestTeamRevision(scope, request.teamId, exec),
          resultingTaskId: outcome.task.id,
        })
      }
      default:
        throw this.error('TEAM_INTERACTION_INVALID', `intent "${String(request.intent)}" is not executable by Human Control`, request)
    }
  }

  private memberTargetName(request: HumanInteractionRequest): string {
    if (request.target.kind !== 'member') throw this.error('TEAM_INTERACTION_TARGET_INVALID', 'member control requires member target', request)
    return request.target.memberName
  }

  private taskTargetId(request: HumanInteractionRequest): TaskId {
    if (request.target.kind !== 'task') throw this.error('TEAM_INTERACTION_TARGET_INVALID', 'task control requires task target', request)
    return request.target.taskId
  }

  private async latestTeamRevision(scope: TeamScope, teamId: TeamId, exec: ToolExecutionAuthority): Promise<number> {
    if (exec.agent === undefined) {
      throw new TeamDomainError('Human Control requires a captain agent', 'TEAM_INTERACTION_CAPTAIN_REQUIRED')
    }
    const snapshot = await this.deps.domain().snapshot(scope, teamId, exec.agent.id)
    return snapshot.team.revision
  }

  private outcomeUnknown(cause?: unknown): TeamDomainError {
    return new TeamDomainError(
      'control effect may have committed but its receipt outcome is unknown; do not replay before I1b reconciliation',
      'TEAM_INTERACTION_OUTCOME_UNKNOWN',
      { cause },
    )
  }

  private record(
    scope: TeamScope,
    request: HumanInteractionRequest,
    now: number,
    status: 'pending' | 'expired' | 'cancelled',
    code: string | undefined,
    diagnostic: string | undefined,
  ): HumanInteractionRecord {
    return {
      schemaVersion: 1,
      scope,
      request,
      receipt: {
        requestId: request.requestId,
        teamId: request.teamId,
        status,
        ...(code === undefined ? {} : { code }),
        ...(diagnostic === undefined ? {} : { diagnostic }),
        updatedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    }
  }

  private executedReceipt(
    request: HumanInteractionRequest,
    now: number,
    extra: { readonly resultingTeamRevision?: number; readonly routedMessageId?: string; readonly resultingTaskId?: TaskId; readonly diagnostic?: string },
  ): HumanInteractionReceipt {
    return {
      requestId: request.requestId,
      teamId: request.teamId,
      status: 'executed',
      ...(extra.resultingTeamRevision === undefined ? {} : { resultingTeamRevision: extra.resultingTeamRevision }),
      ...(extra.routedMessageId === undefined ? {} : { routedMessageId: extra.routedMessageId }),
      ...(extra.resultingTaskId === undefined ? {} : { resultingTaskId: extra.resultingTaskId }),
      ...(extra.diagnostic === undefined ? {} : { diagnostic: extra.diagnostic }),
      updatedAt: now,
    }
  }

  private rejectTerminal(existing: HumanInteractionRecord, request: HumanInteractionRequest): void {
    if (existing.receipt.status === 'cancelled') throw this.error('TEAM_INTERACTION_CANCELLED', `request "${request.requestId}" was cancelled`, request)
    if (existing.receipt.status === 'expired') throw this.error('TEAM_INTERACTION_EXPIRED', `request "${request.requestId}" expired`, request)
  }

  private ensureSameRequest(existing: HumanInteractionRecord, request: HumanInteractionRequest): void {
    if (!sameHumanInteractionRequest(existing.request, request)) {
      throw this.error(
        'TEAM_INTERACTION_REQUEST_CONFLICT',
        `requestId "${request.requestId}" is reused with a different semantic payload`,
        request,
      )
    }
  }

  private duplicateError(request: HumanInteractionRequest, existing: HumanInteractionRecord): TeamDomainError {
    return this.error(
      'TEAM_INTERACTION_REQUEST_CONFLICT',
      `duplicate request "${request.requestId}" already ${existing.receipt.status}`,
      request,
    )
  }

  private error(code: string, diagnostic: string, request?: HumanInteractionRequest): TeamDomainError {
    return new TeamDomainError(request === undefined ? diagnostic : `interaction "${request.requestId}": ${diagnostic}`, code)
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}
