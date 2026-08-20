/** Durable AgentTeams state types from upstream 0.1.8. */

export type TaskStatus =
  | 'pending'
  | 'claimed'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled'

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['completed', 'failed', 'cancelled']

export interface TeamTask {
  id: string
  subject: string
  description?: string
  status: TaskStatus
  assignee?: string
  dependencies: string[]
  output?: string
  attempt?: number
  attemptId?: string
  handoffId?: string
  reassigning?: boolean
  createdAt: number
  updatedAt: number
}

export type MemberStatus = 'idle' | 'working' | 'removed'

export interface TeamMember {
  id: string
  name: string
  role?: string
  provider?: string
  model?: string
  reasoningEffort?: string
  joinedAt: number
  status: MemberStatus
}

export interface TeamMessage {
  id: string
  from: string
  to: string
  content: string
  ts: number
  deliveryClaimedAt?: number
  deliveredAt?: number
  readAt?: number
}

export interface TeamState {
  name: string
  id: string
  description?: string
  captainSessionId: string
  createdAt: number
  members: TeamMember[]
  tasks: TeamTask[]
  taskSeq: number
}
