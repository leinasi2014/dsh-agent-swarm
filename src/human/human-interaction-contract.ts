/**
 * SW-I1a HumanInteraction contract.
 *
 * Project-owned `HumanInteractionPort`/`HumanControlGateway` own only
 * correlation and audit for human interaction: stable request ids, Team
 * linkage, provenance, targets, typed intent, expected fences, expiry and
 * durable receipts. It never copies roster/task/mailbox truth and never
 * mutates the Team aggregate itself — all authority transitions flow through
 * {@link TeamDomainPort}. The official `ctx.userQuestions` seam stays the
 * captain's presentation surface; this module consumes it through a
 * replaceable presentation adapter so a headless host without that package
 * still fails closed.
 */

import type { AttemptId, TaskId, TeamId } from '../domain/types.js'
import type { ToolExecutionAuthority } from '../runtime/authority.js'

/** Request id pattern: opaque idempotency keys, not user-controlled paths. */
export const HUMAN_INTERACTION_ID_PATTERN = /^human-[a-z0-9-]{8,80}$/

/**
 * The single typed intent vocabulary: advisory relay plus typed
 * Controls. A free-form Message can never be promoted to one of these.
 */
export type HumanInteractionIntent =
  | 'message'
  | 'member-question'
  | 'correct-task'
  | 'interrupt-member'
  | 'wake-member'
  | 'reassign-task'
  | 'review-task'

/** Typed controls admitted by the headless command gateway. */
export const HUMAN_INTERACTION_CONTROL_INTENTS = [
  'correct-task',
  'interrupt-member',
  'wake-member',
  'reassign-task',
  'review-task',
] as const

export type HumanInteractionStatus =
  | 'pending'
  | 'acknowledged'
  | 'executed'
  | 'rejected'
  | 'failed'
  | 'expired'
  | 'cancelled'

/**
 * Provenance of one interaction request. `captain-mediated` means the root
 * captain is relaying user intent from its session; `authenticated-human` is
 * admitted only from a host capability that supplies a verified opaque
 * principal reference. An Agent can never mint `authenticated-human`.
 */
export interface HumanInteractionSource {
  readonly kind: 'captain-mediated' | 'authenticated-human'
  readonly captainSessionId: string
  readonly principalRef?: string
  readonly hostSurface?: string
}

export type HumanInteractionTarget =
  | { readonly kind: 'captain' }
  | { readonly kind: 'team' }
  | { readonly kind: 'member'; readonly memberName: string }
  | { readonly kind: 'task'; readonly taskId: TaskId }

/** Additive routing fact for member-question relay (answer return target). */
export interface HumanInteractionOrigin {
  readonly kind: 'member'
  readonly memberSessionId: string
  readonly memberName: string
}

export interface HumanInteractionRequest {
  readonly schemaVersion: 1
  readonly requestId: string
  readonly teamId: TeamId
  readonly source: HumanInteractionSource
  readonly target: HumanInteractionTarget
  readonly intent: HumanInteractionIntent
  /** The relaying member, required for `member-question`. */
  readonly origin?: HumanInteractionOrigin
  /** Bounded advisory payload; never a permission or state transition by itself. */
  readonly body?: string
  readonly expectedTeamRevision: number
  readonly expectedTaskRevision?: number
  readonly attemptId?: AttemptId
  /** Review decision for `review-task` controls. */
  readonly decision?: 'accept' | 'reject'
  /** Bounded diagnostic/reason carried by typed Controls. */
  readonly diagnostic?: string
  readonly createdAt: number
  readonly expiresAt?: number
}

export interface HumanInteractionReceipt {
  readonly requestId: string
  readonly teamId: TeamId
  readonly status: HumanInteractionStatus
  /** Durable Team mail id that carried the member->captain question. */
  readonly routedMessageId?: string
  /** Durable Team mail id that carried the captain->member answer. */
  readonly answerMessageId?: string
  /** Task id named by a successful task-scoped control receipt. */
  readonly resultingTaskId?: TaskId
  readonly resultingTeamRevision?: number
  readonly code?: string
  readonly diagnostic?: string
  readonly updatedAt: number
}

/** One durable request + receipt pair in the additive overlay. */
export interface HumanInteractionRecord {
  readonly schemaVersion: 1
  readonly scope: string
  readonly request: HumanInteractionRequest
  readonly receipt: HumanInteractionReceipt
  readonly createdAt: number
  readonly updatedAt: number
}

/** Semantic equality of one interaction request (replay comparison). */
export function sameHumanInteractionRequest(left: HumanInteractionRequest, right: HumanInteractionRequest): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.createdAt === right.createdAt
    && left.requestId === right.requestId
    && left.teamId === right.teamId
    && left.intent === right.intent
    && left.body === right.body
    && left.decision === right.decision
    && left.diagnostic === right.diagnostic
    && left.expectedTeamRevision === right.expectedTeamRevision
    && left.expectedTaskRevision === right.expectedTaskRevision
    && left.attemptId === right.attemptId
    && left.expiresAt === right.expiresAt
    && left.source.kind === right.source.kind
    && left.source.captainSessionId === right.source.captainSessionId
    && left.source.principalRef === right.source.principalRef
    && left.source.hostSurface === right.source.hostSurface
    && sameTarget(left.target, right.target)
    && sameOrigin(left.origin, right.origin)
}

function sameTarget(left: HumanInteractionTarget, right: HumanInteractionTarget): boolean {
  if (left.kind !== right.kind) return false
  switch (left.kind) {
    case 'captain':
    case 'team':
      return true
    case 'member':
      return right.kind === 'member' && left.memberName === right.memberName
    case 'task':
      return right.kind === 'task' && left.taskId === right.taskId
  }
}

function sameOrigin(left: HumanInteractionOrigin | undefined, right: HumanInteractionOrigin | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.kind === right.kind
    && left.memberSessionId === right.memberSessionId
    && left.memberName === right.memberName
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Assembled SW-I1a captain liaison surface. */
    agentSwarmHumanInteraction: HumanInteractionPort
  }
}

/** The question handed to the captain presentation adapter. */
export interface CaptainQuestion {
  readonly requestId: string
  readonly teamId: TeamId
  /** Durable-record captain session id used to resolve the exact live root Agent. */
  readonly captainSessionId: string
  readonly memberName: string
  readonly question: string
  readonly correlatedTaskId?: TaskId
  readonly correlatedAttemptId?: AttemptId
}

/**
 * Replaceable presentation adapter standing in front of the official
 * `ctx.userQuestions` seam. The real adapter must call that service with the
 * exact live root captain; delegated-caller rejection therefore happens at
 * the official seam and is never fabricated here.
 */
export interface CaptainQuestionPresentation {
  ask(question: CaptainQuestion): Promise<string> | string
}

export interface RelayMemberQuestionInput {
  readonly scope: string
  readonly teamId: TeamId
  readonly memberSessionId: string
  readonly body: string
  readonly requestId?: string
  readonly expectedTeamRevision: number
  readonly taskId?: TaskId
  readonly expectedTaskRevision?: number
  readonly attemptId?: AttemptId
  readonly expiresAt?: number
}

export interface PresentQuestionInput {
  readonly scope: string
  readonly teamId: TeamId
  readonly requestId: string
  readonly captainSessionId: string
}

/** Caller-bound authority supplied independently of any interaction payload. */
export interface HumanInteractionAdmission {
  readonly exec: ToolExecutionAuthority
}

/** The host-neutral surface consumed by headless captain flows. */
export interface HumanInteractionPort {
  relayMemberQuestion(input: RelayMemberQuestionInput, admission: HumanInteractionAdmission): Promise<HumanInteractionReceipt>
  presentQuestion(input: PresentQuestionInput, admission: HumanInteractionAdmission): Promise<HumanInteractionReceipt>
  listReceipts(scope: string, teamId: TeamId, admission: HumanInteractionAdmission): Promise<HumanInteractionReceipt[]>
  reconcile(scope: string, teamId: TeamId, admission: HumanInteractionAdmission): Promise<HumanInteractionReceipt[]>
}
