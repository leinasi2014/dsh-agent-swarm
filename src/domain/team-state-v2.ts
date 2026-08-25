import type {
  AttemptId,
  TeamBudget,
  TeamId,
  TeamMemoryEntry,
  TeamMessage,
  TeamTask,
} from './types.js'

declare const dispatchIdBrand: unique symbol
declare const continuationEffectIdBrand: unique symbol
declare const teamEffectIdBrand: unique symbol

export type DispatchId = string & { readonly [dispatchIdBrand]: true }
export type ContinuationEffectId = string & { readonly [continuationEffectIdBrand]: true }
export type TeamEffectId = string & { readonly [teamEffectIdBrand]: true }

export const DispatchId = (value: string): DispatchId => value as DispatchId
export const ContinuationEffectId = (value: string): ContinuationEffectId => value as ContinuationEffectId
export const TeamEffectId = (value: string): TeamEffectId => value as TeamEffectId

export type TeamMemberPhaseV2 = 'declared' | 'starting' | 'active' | 'failed' | 'removed'

export interface TeamMemberV2 {
  readonly name: string
  readonly role: string
  readonly sessionId: string
  readonly provider: string
  readonly llmProvider?: string
  readonly model?: string
  readonly modelSource: 'explicit' | 'member-default' | 'captain-inherited' | 'unresolved'
  readonly deniedTools: string[]
  readonly assignedSkills: string[]
  readonly maxDepth: number
  readonly phase: TeamMemberPhaseV2
  readonly startingAttemptId?: AttemptId
  readonly initialPromptDigest?: string
  readonly initialMessageSeq?: number
  readonly activatedAt?: number
  readonly createdAt: number
  readonly error?: string
}

type ContinuationPolicy = 'team-autonomous' | 'captain' | 'human'

export interface ParkedAttemptState {
  readonly parkedAt: number
  readonly parkedReason: 'turn-settled' | 'owner-not-live' | 'migration-unknown'
  readonly lastSessionSeq?: number
  readonly continuationPolicy: ContinuationPolicy
  readonly currentContinuationIntentId?: ContinuationEffectId
}

export type ContinuationPrincipal =
  | { readonly kind: 'member'; readonly memberId: string; readonly memberSessionId: string }
  | { readonly kind: 'team-leader'; readonly captainSessionId: string }
  | { readonly kind: 'authenticated-human'; readonly subjectId: string; readonly attestationDigest: string }

type ContinuationIntentPhase =
  | 'requested'
  | 'admitted'
  | 'claimed'
  | 'dispatch-pending'
  | 'dispatch-entered'
  | 'dispatch-unknown'
  | 'settled'
  | 'superseded'
  | 'cancelled'

export interface ContinuationIntent {
  readonly continuationEffectId: ContinuationEffectId
  readonly taskId: string
  readonly attemptId: AttemptId
  readonly expectedTaskRevision: number
  readonly requestedBy: ContinuationPrincipal
  readonly requestedAt: number
  readonly checkpointDigest?: string
  readonly wakeCondition?: string
  readonly resumeEffectId?: TeamEffectId
  readonly currentDispatchId?: DispatchId
  readonly phase: ContinuationIntentPhase
}

type ModelDispatchPhase =
  | 'frame-pending'
  | 'frame-claimed'
  | 'dispatch-pending'
  | 'dispatch-entered'
  | 'dispatch-unknown'
  | 'settled'
  | 'superseded'
  | 'cancelled'

export interface ModelDispatchEpoch {
  readonly dispatchId: DispatchId
  readonly kind: 'initial' | 'continuation' | 'recovery'
  readonly ordinal: number
  readonly effectId: TeamEffectId
  readonly recoveryOf?: DispatchId
  readonly targetSessionId: string
  /** Exact official inbox identity returned by continuable-child admission. */
  readonly frameMessageId?: string
  readonly turn?: number
  readonly step?: number
  readonly messageSeq?: number
  readonly witnessCapabilityDigest: string
  readonly assistantEvidenceSeq?: number
  readonly assistantEvidenceType?: 'assistant/message'
  readonly turnEndEvidenceSeq?: number
  readonly turnEndEvidenceReason?: 'completed' | 'aborted' | 'blocked' | 'error' | 'max-tokens'
  readonly phase: ModelDispatchPhase
  readonly createdAt: number
  readonly updatedAt: number
}

export type TaskAttemptPhaseV2 =
  | 'reserved'
  | 'running'
  | 'parked'
  | 'submitted'
  | 'verifying'
  | 'accepted'
  | 'rejected'
  | 'cancelled'
  | 'stale'

export interface TaskAttemptV2 {
  readonly id: AttemptId
  readonly taskId: string
  readonly generation: number
  readonly memberSessionId: string
  readonly phase: TaskAttemptPhaseV2
  readonly assignmentPhase: 'reserved' | 'delivered'
  readonly assignmentDeliveredAt?: number
  readonly replacesAttemptId?: AttemptId
  readonly parked?: ParkedAttemptState
  readonly currentContinuationIntent?: ContinuationIntent
  readonly dispatchEpochs: ModelDispatchEpoch[]
  readonly output?: string
  readonly evidence: string[]
  readonly diagnostic?: string
  readonly createdAt: number
  readonly updatedAt: number
}

interface TeamEffectReceiptV2 {
  readonly effectId: TeamEffectId
  readonly kind: 'interaction' | 'model-dispatch' | 'continuation'
  readonly status: 'applied' | 'settled' | 'superseded' | 'cancelled'
  readonly appliedAt: number
  readonly resultingTeamRevision: number
  readonly requestId?: string
  readonly step?: 'relay-mail' | 'answer-mail' | 'wake-mail' | 'correct-mail' | 'task-reassign' | 'task-review'
  readonly taskId?: string
  readonly attemptId?: AttemptId
  readonly dispatchId?: DispatchId
  readonly decision?: 'accept' | 'reject'
  readonly continuationEffectId?: ContinuationEffectId
  readonly continuationRequestedBy?: ContinuationPrincipal
  readonly continuationRequestedAt?: number
  readonly continuationExpectedTaskRevision?: number
  readonly continuationCheckpointDigest?: string
  readonly continuationWakeCondition?: string
}

export interface TeamStateV2 {
  readonly schemaVersion: 2
  readonly id: TeamId
  readonly revision: number
  readonly name: string
  readonly description: string
  readonly captainSessionId: string
  readonly phase: 'active' | 'archived'
  readonly members: TeamMemberV2[]
  readonly tasks: TeamTask[]
  readonly attempts: TaskAttemptV2[]
  readonly messages: TeamMessage[]
  readonly interactionEffects: TeamEffectReceiptV2[]
  readonly budget: TeamBudget
  readonly usageCursors: Readonly<Record<string, number>>
  readonly memory: TeamMemoryEntry[]
  readonly nextTaskNumber: number
  readonly nextMemoryNumber: number
  readonly createdAt: number
  readonly updatedAt: number
}

export interface FreshV2AuthorityRecord {
  readonly schemaVersion: 1
  readonly authorityEpoch: 2
  readonly origin: 'fresh'
  readonly teamSchemaVersion: 2
  readonly artifactContract: string
  readonly legacyManifest: {
    readonly capacity: number
    readonly count: 0
    readonly digests: readonly []
    readonly setDigest: string
  }
  readonly createdAt: number
}

export const MAX_V2_EFFECT_RECEIPTS = 1_024
export const MAX_V2_DISPATCH_EPOCHS_PER_ATTEMPT = 64
