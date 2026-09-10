import type { SwarmHostReadProjectionV1, SwarmHostReadProjectionV2, SwarmTaskRowV2 } from '../host/host-read-types.js'

/** UI accepts recorded v1 and v2 reads; optional fields never imply a default fact. */
export type TeamReadProjection = Omit<SwarmHostReadProjectionV1, 'schemaVersion' | 'tasks'> & {
  readonly schemaVersion: SwarmHostReadProjectionV1['schemaVersion'] | SwarmHostReadProjectionV2['schemaVersion']
  readonly tasks: readonly (SwarmHostReadProjectionV1['tasks'][number] & Partial<Pick<SwarmTaskRowV2, 'assignmentMode' | 'readiness'>>)[]
}
