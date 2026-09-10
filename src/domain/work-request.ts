import type { CreateTaskInput } from './team-domain-port.js'
import type { TeamMessageId, TaskId } from './types.js'
import type { WorkRequest, WorkRequestOrigin, WorkActivity } from '../shared/work-request.js'
export type { SubmitWorkRequestInput, WorkRequest, WorkRequestOrigin, WorkActivity, WorkActivityPage } from '../shared/work-request.js'

export interface WorkRequestRecord extends WorkRequest {
  readonly contentDigest: string
  readonly notificationMessageId: TeamMessageId
  readonly decisionDigest?: string
}
export interface TeamWorkRequests {
  readonly schemaVersion: 1
  readonly requests: WorkRequestRecord[]
}
export interface TeamWorkActivity {
  readonly schemaVersion: 1
  readonly nextSequence: number
  readonly entries: WorkActivity[]
}
interface WorkRequestTaskItem extends CreateTaskInput {
  readonly itemKey: string
  readonly blockedByItems?: readonly string[]
}
type WorkRequestDecision =
  | { readonly kind: 'accept'; readonly items: readonly WorkRequestTaskItem[] }
  | { readonly kind: 'reject'; readonly publicReason: string }
export interface ResolveWorkRequestInput {
  readonly workRequestId: string
  readonly expectedRequestRevision: number
  readonly decision: WorkRequestDecision
}
/** Synchronous runtime guards at the transaction boundary; never persisted. */
export interface WorkRequestResolutionGuards {
  readonly assertExecution?: () => void
  readonly assertNewTaskAdmission?: () => void
}
export interface WorkRequestResult {
  readonly teamRevision: number
  readonly request: WorkRequest
  readonly replayed: boolean
  readonly notificationMessageId: TeamMessageId
}
export interface WorkRequestAdmission {
  readonly expectedCaptainSessionId: string
  readonly expectedTeamRevision: number
  readonly expectedManagedOrigin: string
}
export interface TaskWorkRequestSource {
  readonly workRequestId: string
  readonly itemKey: string
  readonly origin: WorkRequestOrigin
}
export interface NoticeOpenClaimTaskInput {
  readonly taskId: TaskId
  readonly expectedTaskRevision: number
  readonly recipientSessionIds: readonly string[]
}
export interface NoticeOpenClaimTaskResult {
  readonly messageIds: TeamMessageId[]
  readonly notifiedSessionIds: string[]
}
