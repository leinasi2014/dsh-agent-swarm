/** Goal control shares the Team aggregate; runtime effects never become stored state. */
import type { GoalLifecycle } from '../shared/goal-lifecycle.js'
import type { TeamState, TeamTask, TaskAttempt, TaskId } from './types.js'

export type { GoalSnapshot, SaveGoalInput, ControlGoalInput } from '../shared/goal-lifecycle.js'
export type GoalOrigin = { readonly kind: 'local-operator' }
  | { readonly kind: 'main' | 'captain'; readonly sessionId: string }
export interface GoalOperationReceipt {
  readonly origin: GoalOrigin
  readonly requestId: string
  readonly expectedLifecycleRevision: number
  readonly contentDigest: string
  readonly operationRevision: number
  readonly at: number
}
export interface TeamGoalLifecycle extends GoalLifecycle {
  readonly operations: GoalOperationReceipt[]
  readonly operationFloorRevision: number
  readonly lastCoordinationDigest?: string
}
export interface GoalAdmissionGuards {
  readonly assertExecution?: () => void
  readonly assertTeam?: (team: TeamState) => void
  /** Reject a new explicit start when no adaptive capability is configured. */
  readonly assertCanStart?: () => void
  /** Re-read the current synchronous owner at the actual transaction boundary. */
  readonly autonomousAllowed?: () => boolean
  readonly expectedCaptainSessionId?: string
  readonly expectedManagedOrigin?: string
}
export interface GoalOperationResult {
  readonly team: TeamState
  readonly operationRevision: number
  readonly replayed: boolean
}
export interface GoalResultQuery {
  readonly requestId: string
  readonly expectedLifecycleRevision: number
}
export type GoalResultLookup = { readonly team: TeamState } & (
  { readonly state: 'committed'; readonly operationRevision: number }
  | { readonly state: 'not-found' | 'expired' }
)
export interface GoalCoordinationInput {
  readonly triggerId: string
  readonly goalRevision: number
  /** The exact result watermark in the notice actually being acknowledged. */
  readonly resultSequence: number
  readonly summary: string
  readonly taskIds: readonly string[]
  readonly outcome: 'coordinated' | 'achieved' | 'round-finished'
  readonly nextAction?: string
}
export interface CancelTaskInput {
  readonly requestId: string
  readonly taskId: TaskId
  readonly expectedTaskRevision: number
  readonly reason: string
}
export interface TaskCancellation {
  readonly requestId: string
  readonly expectedTaskRevision: number
  readonly taskRevision: number
  readonly reason: string
  readonly actorSessionId: string
  readonly at: number
  readonly attemptId?: string
}
export interface CancelTaskGuards {
  readonly assertExecution?: () => void
  /** Capture under the original Team lock; invoke synchronously after durable put and before unlock. */
  readonly captureInterruption?: (team: TeamState, task: TeamTask, attempt?: TaskAttempt) => (() => void) | undefined
}
export interface CancelTaskResult {
  readonly task: TeamTask
  readonly replayed: boolean
}
