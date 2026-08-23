/**
 * SW-I1a Captain Liaison: the headless flow between a
 * delegated member's durable question relay and the root captain's official
 * `ctx.userQuestions` presentation seam.
 *
 * The root captain is the sole Human Liaison. A member can only relay an
 * unresolved question through the existing durable Team mailbox; it never
 * calls a user-interaction service directly. This class owns the additive
 * request/receipt overlay and rides `TeamDomainPort` for every mailbox and
 * Team-state transition — it never mutates the Team aggregate itself.
 */

import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { expectDomain, TeamDomainError } from '../domain/error.js'
import type { TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import type { TaskId, TeamId, TeamMessageId } from '../domain/types.js'
import { HumanInteractionOverlayStore } from './human-interaction-store.js'
import {
  sameHumanInteractionRequest,
  type CaptainQuestion,
  type CaptainQuestionPresentation,
  type HumanInteractionPort,
  type HumanInteractionAdmission,
  type HumanInteractionReceipt,
  type HumanInteractionRecord,
  type HumanInteractionRequest,
  type PresentQuestionInput,
  type RelayMemberQuestionInput,
} from './human-interaction-contract.js'
import { quarantineInteractionOutcome } from './human-interaction-store.js'

/** Advisory payload bound (bounded, secret-free, injection-fenced by the existing mailbox frame). */
const MAX_HUMAN_INTERACTION_BODY_BYTES = 4_096

function receiptOf(record: HumanInteractionRecord): HumanInteractionReceipt {
  return structuredClone(record.receipt)
}

function boundedText(value: string, label: string): string {
  const normalized = value.trim()
  expectDomain(normalized !== '', `${label} must not be empty`, 'TEAM_INPUT_INVALID')
  expectDomain(
    Buffer.byteLength(normalized, 'utf8') <= MAX_HUMAN_INTERACTION_BODY_BYTES,
    `${label} is too large`,
    'TEAM_INPUT_LIMIT',
  )
  return normalized
}

export class CaptainLiaison implements HumanInteractionPort {
  constructor(
    private readonly team: TeamDomainPort,
    private readonly overlay: HumanInteractionOverlayStore,
    private readonly presentation?: CaptainQuestionPresentation,
    private readonly now: () => number = Date.now,
    private readonly callerResolver: {
      readonly resolve: (sessionId: string) => Agent | undefined
      readonly isRoot: (agent: Agent) => boolean
    } = { resolve: () => undefined, isRoot: () => false },
  ) {}

  async relayMemberQuestion(
    input: RelayMemberQuestionInput,
    admission: HumanInteractionAdmission,
  ): Promise<HumanInteractionReceipt> {
    this.overlay.assertAvailable()
    const caller = this.requireLiveCaller(input.memberSessionId, admission, false, 'TEAM_INTERACTION_MEMBER_REQUIRED')
    const membership = await this.team.requireMembership(input.scope, caller.id)
    expectDomain(membership.team.id === input.teamId, 'caller is not a participant of this Team', 'TEAM_UNAUTHORIZED')
    expectDomain(membership.role === 'member', 'only a delegated member may relay a question to the captain', 'TEAM_INTERACTION_MEMBER_REQUIRED')
    return await this.overlay.runRequestExclusive(
      input.scope,
      input.requestId ?? '',
      () => this.relayMemberQuestionLocked(input, membership),
    )
  }

  private async relayMemberQuestionLocked(
    input: RelayMemberQuestionInput,
    membership: Awaited<ReturnType<TeamDomainPort['requireMembership']>>,
  ): Promise<HumanInteractionReceipt> {
    const team = membership.team
    const body = boundedText(input.body, 'question')
    const requestId = input.requestId ?? `human-${randomUUID()}`
    expectDomain(/^human-[a-z0-9-]{8,80}$/.test(requestId), 'requestId is malformed', 'TEAM_INTERACTION_REQUEST_ID_INVALID')
    const existing = this.overlay.get(input.scope, requestId)
    const now = this.now()
    const request: HumanInteractionRequest = {
      schemaVersion: 1,
      requestId,
      teamId: input.teamId,
      source: {
        kind: 'captain-mediated',
        captainSessionId: team.captainSessionId,
        hostSurface: 'team-mail',
      },
      target: { kind: 'member', memberName: membership.name },
      intent: 'member-question',
      origin: {
        kind: 'member',
        memberSessionId: input.memberSessionId,
        memberName: membership.name,
      },
      body,
      expectedTeamRevision: input.expectedTeamRevision,
      ...(input.expectedTaskRevision === undefined ? {} : { expectedTaskRevision: input.expectedTaskRevision }),
      ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
      createdAt: existing?.request.createdAt ?? now,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    }
    if (existing !== undefined) {
      if (this.overlay.isOutcomeUnknown(input.scope, requestId)) throw this.outcomeUnknown('question relay outcome is unknown')
      expectDomain(
        sameHumanInteractionRequest(existing.request, request),
        `requestId "${requestId}" already exists with a different payload`,
        'TEAM_INTERACTION_REQUEST_CONFLICT',
      )
      return receiptOf(existing)
    }
    if (input.expiresAt !== undefined && input.expiresAt <= now) {
      throw new TeamDomainError('question request is already expired', 'TEAM_INTERACTION_EXPIRED')
    }
    expectDomain(
      input.expectedTeamRevision === team.revision,
      `expected Team revision ${input.expectedTeamRevision} is stale; current is ${team.revision}`,
      'TEAM_INTERACTION_STALE_REVISION',
    )
    this.assertTaskFences(team, input.taskId, input.expectedTaskRevision, input.attemptId)

    const pending: HumanInteractionRecord = {
      schemaVersion: 1,
      scope: input.scope,
      request,
      receipt: {
        requestId,
        teamId: input.teamId,
        status: 'pending',
        updatedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    }

    const committed = await this.overlay.commitIfAbsent(pending)
    if (committed !== undefined) {
      expectDomain(
        sameHumanInteractionRequest(committed.request, request),
        `requestId "${requestId}" already exists with a different payload`,
        'TEAM_INTERACTION_REQUEST_CONFLICT',
      )
      return receiptOf(committed)
    }

    try {
      const routed = await this.team.queueMessage(
        input.scope,
        input.teamId,
        input.memberSessionId,
        'captain',
        body,
        'wakeup',
      )
      const snapshot = await this.team.snapshot(input.scope, input.teamId, input.memberSessionId)
      const acknowledged: HumanInteractionRecord = {
        ...pending,
        receipt: {
          requestId,
          teamId: input.teamId,
          status: 'acknowledged',
          routedMessageId: routed.id as TeamMessageId,
          resultingTeamRevision: snapshot.team.revision,
          updatedAt: this.now(),
        },
        updatedAt: this.now(),
      }
      await this.overlay.update(acknowledged, pending.receipt.updatedAt)
      return receiptOf(acknowledged)
    } catch (error) {
      await quarantineInteractionOutcome(this.overlay, input.scope, requestId, this.now)
      throw this.outcomeUnknown('question mail may have committed but its receipt outcome is unknown', error)
    }
  }

  async presentQuestion(
    input: PresentQuestionInput,
    admission: HumanInteractionAdmission,
  ): Promise<HumanInteractionReceipt> {
    this.overlay.assertAvailable()
    const caller = this.requireLiveCaller(input.captainSessionId, admission, true, 'TEAM_CAPTAIN_REQUIRED')
    const membership = await this.team.requireMembership(input.scope, caller.id)
    expectDomain(membership.role === 'captain', 'only the root captain may present a human question', 'TEAM_CAPTAIN_REQUIRED')
    return await this.overlay.runRequestExclusive(
      input.scope,
      input.requestId,
      () => this.presentQuestionLocked(input, membership),
    )
  }

  private async presentQuestionLocked(
    input: PresentQuestionInput,
    membership: Awaited<ReturnType<TeamDomainPort['requireMembership']>>,
  ): Promise<HumanInteractionReceipt> {
    const record = this.overlay.get(input.scope, input.requestId)
    if (record === undefined) {
      throw new TeamDomainError(`interaction "${input.requestId}" not found`, 'TEAM_INTERACTION_NOT_FOUND')
    }
    if (this.overlay.isOutcomeUnknown(input.scope, input.requestId)) {
      throw this.outcomeUnknown('question presentation outcome is unknown')
    }
    expectDomain(membership.team.id === record.request.teamId, 'caller is not a participant of this Team', 'TEAM_UNAUTHORIZED')

    const terminal = ['executed', 'failed', 'expired', 'cancelled', 'rejected'] as const
    if (terminal.some(status => status === record.receipt.status)) return receiptOf(record)
    expectDomain(record.receipt.status === 'acknowledged', 'question must be acknowledged before presentation', 'TEAM_INTERACTION_STATE_INVALID')

    const now = this.now()
    if (record.request.expiresAt !== undefined && record.request.expiresAt <= now) {
      const expired: HumanInteractionRecord = {
        ...record,
        receipt: {
          ...record.receipt,
          status: 'expired',
          code: 'TEAM_INTERACTION_EXPIRED',
          diagnostic: 'question expired before it was answered',
          updatedAt: now,
        },
        updatedAt: now,
      }
      await this.overlay.update(expired, record.receipt.updatedAt)
      return receiptOf(expired)
    }

    if (this.presentation === undefined) {
      const failed: HumanInteractionRecord = {
        ...record,
        receipt: {
          ...record.receipt,
          status: 'failed',
          code: 'TEAM_INTERACTION_PROVIDER_MISSING',
          diagnostic: 'no user-questions presentation adapter is composed; no answer was fabricated',
          updatedAt: now,
        },
        updatedAt: now,
      }
      await this.overlay.update(failed, record.receipt.updatedAt)
      return receiptOf(failed)
    }

    const memberName = record.request.target.kind === 'member'
      ? record.request.target.memberName
      : record.request.origin?.memberName
    expectDomain(memberName !== undefined, 'member-question receipt has no answer target', 'TEAM_INTERACTION_STATE_INVALID')
    const question: CaptainQuestion = {
      requestId: record.request.requestId,
      teamId: record.request.teamId,
      captainSessionId: record.request.source.captainSessionId,
      memberName,
      question: record.request.body ?? '',
      ...(record.request.target.kind === 'task' ? { correlatedTaskId: record.request.target.taskId } : {}),
      ...(record.request.attemptId === undefined ? {} : { correlatedAttemptId: record.request.attemptId }),
    }

    let answer: string
    try {
      answer = boundedText(await this.presentation.ask(question), 'answer')
    } catch (error) {
      const failed: HumanInteractionRecord = {
        ...record,
        receipt: {
          ...record.receipt,
          status: 'failed',
          code: 'TEAM_INTERACTION_PRESENTATION_FAILED',
          diagnostic: 'question presentation failed; no answer was accepted',
          updatedAt: this.now(),
        },
        updatedAt: this.now(),
      }
      await this.overlay.update(failed, record.receipt.updatedAt).catch(() => undefined)
      throw error
    }

    try {
      const answered = await this.team.queueMessage(
        input.scope,
        record.request.teamId,
        input.captainSessionId,
        memberName,
        answer,
        'wakeup',
      )
      const snapshot = await this.team.snapshot(input.scope, record.request.teamId, input.captainSessionId)
      const executed: HumanInteractionRecord = {
        ...record,
        receipt: {
          ...record.receipt,
          status: 'executed',
          answerMessageId: answered.id as TeamMessageId,
          resultingTeamRevision: snapshot.team.revision,
          updatedAt: this.now(),
        },
        updatedAt: this.now(),
      }
      await this.overlay.update(executed, record.receipt.updatedAt)
      return receiptOf(executed)
    } catch (error) {
      await quarantineInteractionOutcome(this.overlay, input.scope, input.requestId, this.now)
      throw this.outcomeUnknown('answer mail may have committed but its receipt outcome is unknown', error)
    }
  }

  async listReceipts(
    scope: TeamScope,
    teamId: TeamId,
    admission: HumanInteractionAdmission,
  ): Promise<HumanInteractionReceipt[]> {
    this.overlay.assertAvailable()
    await this.authorizeCaptainForTeam(scope, teamId, admission)
    return this.overlay.list(scope, teamId).map(receiptOf)
  }

  async reconcile(
    scope: TeamScope,
    teamId: TeamId,
    admission: HumanInteractionAdmission,
  ): Promise<HumanInteractionReceipt[]> {
    this.overlay.assertAvailable()
    await this.authorizeCaptainForTeam(scope, teamId, admission)
    const now = this.now()
    for (const record of this.overlay.list(scope, teamId)) {
      await this.overlay.runRequestExclusive(scope, record.request.requestId, async () => {
        const current = this.overlay.get(scope, record.request.requestId)
        if (this.overlay.isOutcomeUnknown(scope, record.request.requestId)) return
        if (current?.request.expiresAt !== undefined && current.request.expiresAt <= now
          && (current.receipt.status === 'pending' || current.receipt.status === 'acknowledged')) {
          await this.overlay.update({
            ...current,
            receipt: {
              ...current.receipt,
              status: 'expired',
              code: 'TEAM_INTERACTION_EXPIRED',
              diagnostic: 'reconciled expired interaction',
              updatedAt: now,
            },
            updatedAt: now,
          }, current.receipt.updatedAt)
        }
      })
    }
    return this.overlay.list(scope, teamId).map(receiptOf)
  }

  private requireLiveCaller(
    claimedSessionId: string,
    admission: HumanInteractionAdmission,
    rootRequired: boolean,
    code: string,
  ): Agent {
    const caller = admission.exec.agent
    const live = this.callerResolver.resolve(claimedSessionId)
    const isRoot = caller === undefined ? false : this.callerResolver.isRoot(caller)
    if (caller === undefined || live === undefined || caller !== live || caller.id !== claimedSessionId
      || (rootRequired ? !isRoot : isRoot)) {
      throw new TeamDomainError('interaction authority must be bound to the exact live caller', code)
    }
    return caller
  }

  private async authorizeCaptainForTeam(
    scope: TeamScope,
    teamId: TeamId,
    admission: HumanInteractionAdmission,
  ): Promise<void> {
    const caller = admission.exec.agent
    if (caller === undefined) throw new TeamDomainError('captain authority is required', 'TEAM_CAPTAIN_REQUIRED')
    this.requireLiveCaller(caller.id, admission, true, 'TEAM_CAPTAIN_REQUIRED')
    const membership = await this.team.requireMembership(scope, caller.id)
    expectDomain(membership.role === 'captain' && membership.team.id === teamId, 'caller is not the captain of this Team', 'TEAM_UNAUTHORIZED')
  }

  private assertTaskFences(
    team: { readonly tasks: ReadonlyArray<{ readonly id: TaskId; readonly revision: number; readonly currentAttemptId?: string }> },
    taskId: TaskId | undefined,
    expectedTaskRevision: number | undefined,
    attemptId: string | undefined,
  ): void {
    if (taskId === undefined && expectedTaskRevision === undefined && attemptId === undefined) return
    expectDomain(taskId !== undefined, 'task correlation requires taskId', 'TEAM_INPUT_INVALID')
    const task = team.tasks.find(candidate => candidate.id === taskId)
    expectDomain(task !== undefined, `task "${taskId}" not found`, 'TEAM_INTERACTION_TASK_NOT_FOUND')
    if (expectedTaskRevision !== undefined) {
      expectDomain(
        expectedTaskRevision === task.revision,
        `expected task revision ${expectedTaskRevision} is stale; current is ${task.revision}`,
        'TEAM_INTERACTION_STALE_TASK_REVISION',
      )
    }
    if (attemptId !== undefined) {
      expectDomain(
        task.currentAttemptId !== undefined && task.currentAttemptId === attemptId,
        `attempt "${attemptId}" is stale for task "${taskId}"`,
        'TEAM_INTERACTION_ATTEMPT_STALE',
      )
    }
  }

  private outcomeUnknown(message: string, cause?: unknown): TeamDomainError {
    return new TeamDomainError(
      `${message}; do not replay before I1b reconciliation`,
      'TEAM_INTERACTION_OUTCOME_UNKNOWN',
      { cause },
    )
  }

}
