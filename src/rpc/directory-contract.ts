/** Public directory vocabulary shared by Host, UI, tools and prompt assembly. */
import type { PublicChatTarget } from './public-rpc-contract.js'
import type { SwarmReadAssetStatusV1 } from './read-rpc-contract.js'

export interface DirectorySource {
  readonly state: 'available' | 'unknown' | 'unavailable' | 'stale'
  readonly source: string
  readonly version?: string
  readonly observedAt: number
  readonly updatedAt?: number
  readonly reason?: string
}
export interface DirectorySkill { readonly name: string; readonly description?: string; readonly descriptionTruncated?: boolean }
export interface DirectorySkillSet extends DirectorySource { readonly entries: readonly DirectorySkill[] }
export interface DirectoryTool {
  readonly name: string
  readonly state: 'available' | 'approval-required' | 'disabled' | 'unknown'
  /** Our narrowing policy is separate from argument-dependent official execution guards. */
  readonly teamPolicy: 'allow' | 'ask' | 'deny' | 'unknown'
}
export interface DirectoryEntry {
  readonly memberId: string
  readonly role: 'captain' | 'member'
  readonly name: string
  readonly label: string
  readonly responsibility: string
  readonly profession?: string
  readonly personality?: string
  readonly biography?: string
  readonly phase: 'staged' | 'active' | 'archived' | 'provisioning' | 'failed' | 'removed'
  readonly profile: DirectorySource
  readonly avatar: SwarmReadAssetStatusV1
  readonly currentTasks: readonly { readonly id: string; readonly subject: string; readonly status: string }[]
  readonly skills: { readonly assigned: DirectorySkillSet; readonly sessionVisible: DirectorySkillSet; readonly catalog: DirectorySkillSet }
  readonly tools: DirectorySource & { readonly complete: boolean; readonly entries: readonly DirectoryTool[] }
  readonly model: DirectorySource & {
    readonly provider?: string; readonly model?: string
    readonly imageInput: 'supported' | 'unsupported' | 'unknown'
  }
}
export interface DirectoryRequest {
  readonly schemaVersion: 2; readonly target: PublicChatTarget; readonly limit?: number; readonly cursor?: string
}
export interface DirectoryResponse {
  readonly schemaVersion: 2
  readonly binding: PublicChatTarget
  readonly directoryRevision: string
  readonly observedAt: number
  readonly entries: readonly DirectoryEntry[]
  readonly page: {
    readonly offset: number; readonly limit: number; readonly totalCount: number; readonly returnedCount: number
    readonly hasMore: boolean; readonly nextCursor?: string
    readonly unreadRanges: readonly { readonly offset: number; readonly count: number }[]
  }
}
