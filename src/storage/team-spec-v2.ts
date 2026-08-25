import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { teamStateV2Schema } from '../domain/state-validation-v2.js'
import type { FreshV2AuthorityRecord, TeamStateV2 } from '../domain/team-state-v2.js'
import type { TeamId } from '../domain/types.js'
import type { TeamScope } from '../domain/team-domain-port.js'

const TEAM_V2_DOMAIN_NAME = 'agent_swarm_v2'
const TEAM_V2_DOMAIN_VERSION = 1
export const TEAM_V2_AUTHORITY_KEY = 'active'

const digest = z.string().regex(/^[0-9a-f]{64}$/)

const freshV2AuthorityRecordSchema: z.ZodType<FreshV2AuthorityRecord> = z.object({
  schemaVersion: z.literal(1),
  authorityEpoch: z.literal(2),
  origin: z.literal('fresh'),
  teamSchemaVersion: z.literal(2),
  artifactContract: z.string().min(1),
  legacyManifest: z.object({
    capacity: z.number().int().min(0),
    count: z.literal(0),
    digests: z.tuple([]),
    setDigest: digest,
  }).strict(),
  createdAt: z.number().int().min(0),
}).strict()

export interface TeamRecordV2 {
  readonly workspace: TeamScope
  readonly team: TeamStateV2
}

const teamRecordV2Schema: z.ZodType<TeamRecordV2> = z.object({
  workspace: z.string().min(1),
  team: teamStateV2Schema,
}).strict() as unknown as z.ZodType<TeamRecordV2>

export const teamDomainSpecV2 = defineDomain({
  name: TEAM_V2_DOMAIN_NAME,
  version: TEAM_V2_DOMAIN_VERSION,
  tables: {
    authority: domainTable<string, FreshV2AuthorityRecord>(freshV2AuthorityRecordSchema),
    teams: domainTable<TeamId, TeamRecordV2>(teamRecordV2Schema),
  },
})

export function teamRecordV2Of(scope: TeamScope, team: TeamStateV2): TeamRecordV2 {
  return { workspace: scope, team: structuredClone(team) }
}
