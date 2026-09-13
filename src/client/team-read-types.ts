import type { SwarmReadCapabilitiesV1, SwarmReadTeamsV1, SwarmReadCaptainAnnouncementsV1, SwarmReadCaptainDiagnosticsV1, SwarmReadCaptainMembersV1 } from '../rpc/read-rpc-contract.js'
import type { SwarmHostReadProjectionV1, SwarmHostReadProjectionV2, SwarmTaskRowV2 } from '../host/host-read-types.js'

/** UI accepts recorded v1 and v2 reads; optional fields never imply a default fact. */
export type TeamReadProjection = Omit<SwarmHostReadProjectionV1, 'schemaVersion' | 'tasks'> & {
  readonly schemaVersion: SwarmHostReadProjectionV1['schemaVersion'] | SwarmHostReadProjectionV2['schemaVersion']
  readonly tasks: readonly (SwarmHostReadProjectionV1['tasks'][number] & Partial<Pick<SwarmTaskRowV2, 'assignmentMode' | 'readiness'>>)[]
}

export type TeamDashboardPhase = 'closed' | 'loading' | 'ready' | 'stale' | 'reconnecting' | 'error'

export interface TeamDashboardData {
  readonly capabilities: SwarmReadCapabilitiesV1
  readonly projection: TeamReadProjection
  readonly teams: SwarmReadTeamsV1
  readonly captainAnnouncements: SwarmReadCaptainAnnouncementsV1
  readonly captainDiagnostics: SwarmReadCaptainDiagnosticsV1
  readonly captainMembers: SwarmReadCaptainMembersV1
}

export interface TeamDashboardState {
  readonly open: boolean
  readonly phase: TeamDashboardPhase
  readonly targetSessionId?: string
  /** A requested Team whose binding is not yet verified; cached data still belongs to the prior Team. */
  readonly pendingTeamId?: string
  readonly data?: TeamDashboardData
  /** Complete Main directory awaiting its first explicit choice; no Team is selected. */
  readonly choices?: SwarmReadTeamsV1
  readonly error?: { readonly code: string; readonly message: string }
}
