/**
 * Durable schemas and keys for the S2 release/assignment/candidate tables of
 * the `agent_swarm_skills_management` Storage Domain (split out structurally:
 * the candidate chain added a third interlocking table and the main domain
 * file is capped at 600 lines). Identity discipline is unchanged — the main
 * file re-checks every read re-derives its key.
 *
 * @module dsh-agent-swarm/storage/skills-release-tables
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'

export const timestamp = z.number().int().min(0)
/** UTF-8-bounded text field (shared by the whole Skills domain). */
export const bounded = (maxBytes: number) => z.string().min(1).refine(
  value => Buffer.byteLength(value, 'utf8') <= maxBytes,
  `must not exceed ${maxBytes} UTF-8 bytes`,
)
export const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/)

/**
 * One APPROVED immutable release: the manifest CAPTURES the exact body text
 * it was approved against, so immutability is physical (the assembly serves
 * this text, never a later source state).
 */
export const skillsReleaseRecordSchema = z.object({
  schemaVersion: z.literal(1),
  scope: bounded(4_096),
  teamId: bounded(256),
  name: bounded(256),
  version: bounded(64),
  provider: bounded(256),
  locator: bounded(1_024),
  body: bounded(65_536),
  contentSha256: sha256Hex,
  resourcesSha256: sha256Hex,
  applicability: bounded(1_024),
  verification: bounded(1_024),
  approvedBy: bounded(256),
  approvedAt: timestamp,
  manifestHash: sha256Hex,
  /** Durably derived author (candidate review chain only). */
  authorSessionId: bounded(256).optional(),
  /** The EXACT immutable candidateHash (request/base/author/body digest and
   * all capture fields) this approval fact was decided from. Candidate-chain
   * approvals always carry it; Host-compatibility approvals carry no
   * candidate witness, so a review can never replay or mis-attribute them.
   * NOT part of the manifest hash (frozen first-slice contract). */
  approvedCandidateHash: bounded(80).optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict()
export type SkillsReleaseRecord = z.infer<typeof skillsReleaseRecordSchema>
export type SkillsReleaseManifest = Pick<SkillsReleaseRecord, 'name' | 'version' | 'provider' | 'locator' | 'body' | 'contentSha256' | 'resourcesSha256' | 'applicability' | 'verification' | 'approvedBy'>

/** One Captain authorization fact: this member session may have this exact
 * release manifest assembled. CAS by `revision`; never inferred from the
 * roster's static skill view. */
export const skillsAssignmentRecordSchema = z.object({
  schemaVersion: z.literal(1),
  scope: bounded(4_096),
  teamId: bounded(256),
  memberSessionId: bounded(256),
  name: bounded(256),
  version: bounded(64),
  releaseManifestHash: sha256Hex,
  assignedBy: bounded(256),
  revision: z.number().int().min(1),
  assignedAt: timestamp,
  updatedAt: timestamp,
}).strict()
export type SkillsAssignmentRecord = z.infer<typeof skillsAssignmentRecordSchema>

/**
 * One CAPTURED candidate proposed by the real calling Skills manager Session
 * (the author is the derived `authorSessionId`, never an input label): it
 * binds the request context, the target version, an optional approved base
 * version and the exact captured body digest. The body is immutable in place
 * (a same-slot different body conflicts); only a status transition through an
 * independent Captain review can move it. A release exists only after that
 * approval.
 */
export const skillsReleaseCandidateSchema = z.object({
  schemaVersion: z.literal(1),
  scope: bounded(4_096),
  teamId: bounded(256),
  name: bounded(256),
  version: bounded(64),
  baseVersion: bounded(64).optional(),
  requestId: bounded(128),
  provider: bounded(256),
  locator: bounded(1_024),
  body: bounded(65_536),
  contentSha256: sha256Hex,
  applicability: bounded(1_024),
  verification: bounded(1_024),
  authorSessionId: bounded(256),
  candidateHash: sha256Hex,
  status: z.enum(['pending', 'approved', 'rejected']),
  decidedBy: bounded(256).optional(),
  decidedAt: timestamp.optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict()
export type SkillsReleaseCandidateRecord = z.infer<typeof skillsReleaseCandidateSchema>

/** Contained type-erasures at the durable boundary (team-spec pattern), kept
 * here so the schemas stay module-internal. */
export const storedReleaseSchema = skillsReleaseRecordSchema as unknown as z.ZodType<SkillsReleaseRecord>
export const storedAssignmentSchema = skillsAssignmentRecordSchema as unknown as z.ZodType<SkillsAssignmentRecord>
export const storedCandidateSchema = skillsReleaseCandidateSchema as unknown as z.ZodType<SkillsReleaseCandidateRecord>

/** SHA-256 over raw UTF-8 text (candidate bodies ride as captured). */
export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** SHA-256 over the canonical JSON of a value (internal release-family digest). */
function sha256CanonicalJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

/** The canonical EMPTY resources tree digest this slice approves. */
export const EMPTY_RESOURCES_SHA256 = sha256CanonicalJson([])

/** SHA-256 over the canonical approval fields: the manifest identity an
 * assignment pins and the assembly/adoption equality check consumes. */
export function skillsReleaseManifestHash(manifest: SkillsReleaseManifest): string {
  return createHash('sha256').update(canonicalJson(manifest), 'utf8').digest('hex')
}

/** SHA-256 over the captured candidate fields: the immutability witness a
 * duplicate proposal compares against and a review decision binds to. */
export function skillsCandidateHash(candidate: Omit<SkillsReleaseCandidateRecord, 'candidateHash' | 'status' | 'decidedBy' | 'decidedAt' | 'createdAt' | 'updatedAt'>): string {
  return createHash('sha256').update(canonicalJson(candidate), 'utf8').digest('hex')
}

/** Canonical JSON (key-sorted, stable, undefined dropped): the single
 * canonicalization used for every durable hash in this domain. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
}

/** Stable release key: the isolation tuple plus the immutable version slot. */
export function skillsReleaseKey(scope: string, teamId: string, name: string, version: string): string {
  return JSON.stringify([scope, teamId, name, version])
}

/** Stable assignment key: one live assignment per member + skill name. */
export function skillsAssignmentKey(scope: string, teamId: string, memberSessionId: string, name: string): string {
  return JSON.stringify([scope, teamId, memberSessionId, name])
}

/** Stable candidate key: one captured candidate per isolation tuple + slot. */
export function skillsCandidateKey(scope: string, teamId: string, name: string, version: string): string {
  return JSON.stringify([scope, teamId, name, version])
}
