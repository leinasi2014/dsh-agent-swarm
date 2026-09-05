import type { SwarmProducerCapabilityState } from './producer-contract.js'

/** Strict Host-local request. Identity and workspace are never caller fields. */
export interface SwarmHostReadInput {
  /** Lookup hint only; the Host rebinds it to its current official root. */
  readonly teamId?: string
  /** Last complete projection cursor; a mismatch requests a full resync. */
  readonly afterCursor?: string
  /**
   * Dedicated Captain Session binding hint for a parent-root read of a
   * Captain-rooted Team. Requires teamId; the Host re-proves the descriptor
   * chain (team.captainSessionId → live parent root) before projecting, and
   * binding.rootSessionId still reports the dedicated Captain Session id.
   */
  readonly captainSessionId?: string
}

export interface SwarmHostReadProjectionV1 {
  readonly schemaVersion: 1
  readonly binding: {
    readonly rootSessionId: string
    readonly teamId: string
  }
  readonly team: {
    readonly id: string
    readonly name: string
    readonly phase: 'staged' | 'active' | 'archived'
    readonly revision: number
    readonly createdAt: number
    readonly updatedAt: number
    /** Plan-first summary (member/task declarations); present only while staged. */
    readonly plan?: { readonly members: number; readonly tasks: number }
  }
  readonly roster: readonly {
    readonly name: string
    readonly role: string
    readonly phase: 'provisioning' | 'active' | 'failed' | 'removed'
    readonly createdAt: number
  }[]
  readonly tasks: readonly {
    readonly id: string
    readonly revision: number
    readonly subject: string
    readonly status: 'pending' | 'in_progress' | 'submitted' | 'verifying' | 'completed' | 'failed' | 'cancelled'
    readonly blockedBy: readonly string[]
    readonly priority: number
    readonly ownerName?: string
    readonly targetMemberName?: string
    readonly currentAttemptId?: string
    readonly createdAt: number
    readonly updatedAt: number
  }[]
  readonly attempts: readonly {
    readonly id: string
    readonly taskId: string
    readonly generation: number
    readonly memberName?: string
    readonly phase: 'running' | 'submitted' | 'verifying' | 'accepted' | 'rejected' | 'cancelled' | 'stale'
    readonly assignmentPhase: 'reserved' | 'delivered'
    readonly createdAt: number
    readonly updatedAt: number
  }[]
  readonly budget: {
    readonly usedTokens: number
    readonly usedRequests: number
    readonly usedRetries: number
    readonly tokenLimit?: number
    readonly requestLimit?: number
    readonly retryLimit?: number
    readonly deadlineAt?: number
  }
  readonly pendingInteractions: readonly {
    readonly requestId: string
    readonly intent: string
    readonly targetKind: 'captain' | 'team' | 'member' | 'task'
    readonly targetRef?: string
    readonly status: 'pending' | 'acknowledged'
    readonly createdAt: number
    readonly updatedAt: number
  }[]
  readonly totals: {
    readonly roster: number
    readonly tasks: number
    readonly attempts: number
    readonly pendingInteractions: number
  }
  readonly truncated: {
    readonly roster: boolean
    readonly tasks: boolean
    readonly attempts: boolean
    readonly pendingInteractions: boolean
  }
  readonly capabilities: readonly SwarmProducerCapabilityState[]
  readonly cursor: string
  readonly changed: boolean
  readonly resyncRequired: boolean
  readonly observedAt: number
}

/** Read-only Team enumeration projected straight from the authoritative aggregates. The client never
 *  receives a copied Team aggregate or a second state — only stable selector rows it may use to target
 *  a subsequent snapshot/{binding,teams} read or open the official Captain Session. */
export interface SwarmHostTeamsProjectionV1 {
  readonly schemaVersion: 1
  readonly binding: {
    readonly rootSessionId: string
    readonly rootKind: 'main-brain' | 'captain'
  }
  readonly teams: readonly {
    readonly teamId: string
    readonly name: string
    readonly phase: 'staged' | 'active' | 'archived'
    readonly captainSessionId: string
  }[]
  readonly observedAt: number
  readonly complete: boolean
}


