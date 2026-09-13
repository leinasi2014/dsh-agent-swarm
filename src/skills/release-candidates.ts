/**
 * S2 candidate chain (docs07 §6 independent approval, docs04:224): the real
 * module-owned Skills manager captures immutable release candidates through a
 * narrow scoped tool, and an INDEPENDENT Captain reviews that exact capture
 * through the review tool. Both acting identities are DERIVED from the exact
 * calling Agent — no parameter can name, rename, omit or forge them — and a
 * release materializes only after an independent approval.
 *
 * The official storage domain has NO cross-table transaction (single-record
 * commits only, README-pinned): the ONE durable approval fact is the approved
 * RELEASE row; the candidate's decided state is a derived view that approval
 * replays back-fill idempotently, and a rejection can never overturn a
 * candidate whose approval fact exists.
 *
 * Separated from `release-authority.ts` by responsibility (candidate capture
 * vs. assignment/assembly), sharing the same StorageDomain tables and guards;
 * no scheduler, no new framework.
 *
 * @module dsh-agent-swarm/skills/release-candidates
 */
import { z } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SkillsManagementStore } from '../storage/skills-management.js'
import { EMPTY_RESOURCES_SHA256, bounded, sha256Text, skillsCandidateHash, skillsReleaseManifestHash, type SkillsReleaseCandidateRecord } from '../storage/skills-release-tables.js'
import { TeamDomainError } from '../domain/error.js'
import type { AuthorityGuards } from './authority-guards.js'
import type { SkillsManagementDeps } from './module.js'
import type { SkillsCallAuthority } from './contracts.js'

/** The canonical EMPTY resources tree digest comes from the release-tables
 * module (shared with the approve face); sha256Text/bounded are shared too. */
const skillNameField = bounded(256).refine(value => /^[a-z0-9][a-z0-9-]*$/.test(value), 'must be kebab-case')

const proposeInputSchema = z.object({
  request_id: bounded(128),
  skill_name: skillNameField,
  version: bounded(64),
  base_version: bounded(64).optional(),
  provider: bounded(256),
  locator: bounded(1_024),
  body: bounded(65_536),
  applicability: bounded(1_024),
  verification: bounded(1_024),
}).strict()

const reviewInputSchema = z.object({
  skill_name: skillNameField,
  version: bounded(64),
  decision: z.enum(['approve', 'reject']),
}).strict()

const listInputSchema = z.object({
  pending_only: z.boolean().optional(),
  limit: z.number().int().min(1).max(64).optional(),
}).strict()

/** Wire view of one captured candidate (author + digests are derived facts;
 * `status` is derived from the durable approval fact when present). */
export interface SkillsCandidateView {
  readonly scope: string
  readonly team_id: string
  readonly skill_name: string
  readonly version: string
  readonly status: 'pending' | 'approved' | 'rejected'
  readonly author_session_id: string
  readonly candidate_hash: string
  readonly request_id: string
  readonly base_version?: string
  readonly provider?: string
  readonly locator?: string
  readonly body?: string
  readonly content_sha256?: string
  readonly applicability?: string
  readonly verification?: string
}

/** Wire view of one review decision (approve materializes the release). */
export interface SkillsReviewView {
  readonly skill_name: string
  readonly version: string
  readonly status: 'approved' | 'rejected'
  readonly scope?: string
  readonly team_id?: string
  readonly provider?: string
  readonly content_sha256?: string
  readonly resources_sha256?: string
  readonly manifest_hash?: string
  readonly author_session_id?: string
}

/** Which Team owns a request id. The module-owned manager's own cwd/scope is
 * NOT assumed to equal the business Team, so — exactly like the investigate
 * face — ownership comes from the durable request among the manifest Teams:
 * one match, or an ambiguity (never a silent pick). */
type CandidateTeamLookup = (requestId: string) => { readonly scope: string; readonly teamId: string } | { readonly ambiguous: true } | undefined

export interface CandidateAuthorityDeps {
  readonly store: SkillsManagementStore
  readonly guards: AuthorityGuards
  readonly domain: SkillsManagementDeps
  readonly lane: <T>(scope: string, teamId: string, fn: () => Promise<T>) => Promise<T>
  readonly lookupCandidateTeam: CandidateTeamLookup
  /** Exact live-handle identity of the module-owned manager (object identity
   * through the registry — never a bare SessionId string comparison). */
  readonly isManagerAgent: (agent: Agent) => boolean
}

export class CandidateAuthority {
  constructor(private readonly deps: CandidateAuthorityDeps) {}

  /** Manager model face (registered ONLY into the manager's scoped tool
   * surface; this guard is defense-in-depth with exact object identity): the
   * REAL Skills manager Session captures a release candidate bound to a known
   * request. The author is the DERIVED calling Agent id — no input can name,
   * rename or hide it — and the same version slot with a different captured
   * body conflicts (captures never change in place). Proposing is NOT
   * publishing: the body is not assignable and enters no assembly until an
   * INDEPENDENT Captain approves the exact captured hash. */
  async proposeCandidate(raw: unknown, exec: SkillsCallAuthority): Promise<SkillsCandidateView> {
    const author = exec.agent
    if (author === undefined || !this.deps.isManagerAgent(author)) {
      throw new TeamDomainError('only the module-owned Skills manager Session may capture release candidates', 'SKILLS_UNAUTHORIZED')
    }
    const input = proposeInputSchema.parse(raw)
    const lookup = this.deps.lookupCandidateTeam(input.request_id)
    if (lookup === undefined) {
      throw new TeamDomainError(`skill request ${input.request_id} is not a known request of any Team this module manages`, 'SKILLS_REQUEST_NOT_FOUND')
    }
    if ('ambiguous' in lookup) {
      throw new TeamDomainError(`request id ${input.request_id} matches multiple Teams; the candidate owner is ambiguous`, 'SKILLS_REQUEST_AMBIGUOUS')
    }
    const { scope, teamId } = lookup
    this.deps.guards.assertAdmission()
    this.deps.guards.assertManifest(scope, teamId)
    return await this.deps.lane(scope, teamId, async () => {
      this.deps.guards.assertAdmission()
      exec.signal?.throwIfAborted()
      if (input.base_version !== undefined && this.deps.store.getRelease(scope, teamId, input.skill_name, input.base_version) === undefined) {
        throw new TeamDomainError(`base version ${input.base_version} is not an approved release this candidate revises`, 'SKILLS_BASE_VERSION_NOT_FOUND')
      }
      const capture = {
        schemaVersion: 1 as const, scope, teamId, name: input.skill_name, version: input.version,
        ...(input.base_version === undefined ? {} : { baseVersion: input.base_version }),
        requestId: input.request_id, provider: input.provider, locator: input.locator,
        body: input.body, contentSha256: sha256Text(input.body),
        applicability: input.applicability, verification: input.verification,
        authorSessionId: String(author.id),
      }
      const hash = skillsCandidateHash(capture)
      const put = await this.deps.store.putCandidateIfAbsent(scope, teamId, { ...capture, candidateHash: hash })
      if (!put.created && put.record.candidateHash !== hash) {
        throw new TeamDomainError(`candidate ${input.skill_name}@${input.version} already captured a different body (captures are immutable in place)`, 'SKILLS_CANDIDATE_CONFLICT')
      }
      return candidateView(put.record, this.deps.store.getRelease(scope, teamId, put.record.name, put.record.version)?.approvedCandidateHash === put.record.candidateHash)
    })
  }

  /** The shared Captain entry fence for the review/read faces: the acting
   * identity is the DERIVED calling Agent, verified as this Team's Captain. */
  private async captainFace<T>(exec: SkillsCallAuthority, parse: (raw: unknown) => T, raw: unknown): Promise<{ readonly agent: Agent; readonly input: T; readonly scope: string; readonly teamId: string }> {
    const agent = exec.agent
    if (agent === undefined) throw new TeamDomainError('this face requires the exact calling Captain Agent', 'SKILLS_UNAUTHORIZED')
    const input = parse(raw)
    const scope = this.deps.domain.scopeOf(agent)
    const membership = await this.deps.guards.assertCaptain(agent, scope)
    const teamId = membership.team.id
    this.deps.guards.assertAdmission()
    this.deps.guards.assertManifest(scope, teamId)
    return { agent, input, scope, teamId }
  }

  /** Captain review face (model tool): approve or reject one captured
   * candidate of this Team. The reviewing identity is the DERIVED calling
   * Captain Agent id — there is no approver parameter to forge or omit — and
   * the exact captured candidate is the decision target. The capturing author
   * Session can never decide its own candidate.
   *
   * The ONE durable approval fact is the approved RELEASE row BOUND to the
   * exact immutable candidateHash (request/base/author/body and all capture
   * fields; no cross-table transaction exists): a same-slot release decided
   * from a DIFFERENT capture (including a Host-compatibility approval, which
   * carries no candidate witness) is never this candidate's fact — approve
   * refuses it loudly (SKILLS_RELEASE_CONFLICT) and reject closes only the
   * unapproved candidate without touching the foreign release. `candidate
   * .status` is a derived view this method back-fills idempotently, and a
   * rejection can never overturn a candidate whose OWN approval fact exists.
   * Replaying an approval keeps the originally committed
   * approver/time/manifest and never double-writes. */
  async reviewCandidate(raw: unknown, exec: SkillsCallAuthority): Promise<SkillsReviewView> {
    const { agent, input, scope, teamId } = await this.captainFace(exec, value => reviewInputSchema.parse(value), raw)
    return await this.deps.lane(scope, teamId, async () => {
      this.deps.guards.assertAdmission()
      exec.signal?.throwIfAborted()
      const candidate = this.deps.store.getCandidate(scope, teamId, input.skill_name, input.version)
      if (candidate === undefined) throw new TeamDomainError(`no captured candidate ${input.skill_name}@${input.version}`, 'SKILLS_CANDIDATE_NOT_FOUND')
      if (candidate.authorSessionId === String(agent.id)) {
        throw new TeamDomainError('the capturing author Session can never decide its own candidate (independent review is required)', 'SKILLS_RELEASE_SELF_APPROVAL')
      }
      const existing = this.deps.store.getRelease(scope, teamId, input.skill_name, input.version)
      // The approval fact is THIS candidate's only when it was decided from
      // this exact immutable capture — a name/version row alone proves nothing.
      const ownFact = existing !== undefined && existing.approvedCandidateHash === candidate.candidateHash
      if (input.decision === 'reject') {
        if (ownFact) {
          throw new TeamDomainError(`candidate ${input.skill_name}@${input.version} already has a durable approval fact; a rejection can never overturn an approved release`, 'SKILLS_CANDIDATE_STALE')
        }
        if (candidate.status !== 'pending') throw new TeamDomainError(`candidate ${input.skill_name}@${input.version} is already ${candidate.status}`, 'SKILLS_CANDIDATE_STALE')
        const rejected = await this.deps.store.decideCandidate(scope, teamId, input.skill_name, input.version, { status: 'rejected', decidedBy: String(agent.id) })
        if (rejected === undefined) throw new TeamDomainError(`candidate ${input.skill_name}@${input.version} is already decided`, 'SKILLS_CANDIDATE_STALE')
        return { skill_name: input.skill_name, version: input.version, status: 'rejected' as const }
      }
      if (candidate.status === 'rejected' && !ownFact) {
        throw new TeamDomainError(`candidate ${input.skill_name}@${input.version} was rejected; reopening is not a review outcome`, 'SKILLS_CANDIDATE_STALE')
      }
      if (existing !== undefined) {
        if (!ownFact) {
          throw new TeamDomainError(`release ${input.skill_name}@${input.version} is a durable approval fact for a DIFFERENT capture; this candidate has no approval fact of its own`, 'SKILLS_RELEASE_CONFLICT')
        }
      }
      // The ONE durable approval fact: the release row BOUND to this exact
      // immutable candidateHash. Replay of this candidate's committed fact
      // keeps its approver/time/manifest; a fresh approval writes the row.
      const manifest = {
        name: candidate.name, version: candidate.version, provider: candidate.provider, locator: candidate.locator,
        body: candidate.body, contentSha256: candidate.contentSha256, resourcesSha256: EMPTY_RESOURCES_SHA256,
        applicability: candidate.applicability, verification: candidate.verification,
        approvedBy: String(agent.id),
      }
      const put = existing !== undefined
        ? { created: false as const, record: existing }
        : await this.deps.store.putReleaseIfAbsent(scope, teamId, {
            ...manifest, approvedAt: Date.now(), manifestHash: skillsReleaseManifestHash(manifest), authorSessionId: candidate.authorSessionId, approvedCandidateHash: candidate.candidateHash,
          })
      if (!put.created && put.record.approvedCandidateHash !== candidate.candidateHash) {
        throw new TeamDomainError(`release ${input.skill_name}@${input.version} already exists with a different immutable manifest`, 'SKILLS_RELEASE_CONFLICT')
      }
      // Derived view: close the capture idempotently (the approval already
      // holds without it; a replay re-derives the state from the release row).
      if (candidate.status !== 'approved') {
        await this.deps.store.decideCandidate(scope, teamId, input.skill_name, input.version, { status: 'approved', decidedBy: put.record.approvedBy })
      }
      return {
        skill_name: put.record.name, version: put.record.version, status: 'approved' as const,
        scope: put.record.scope, team_id: teamId, provider: put.record.provider,
        content_sha256: put.record.contentSha256, resources_sha256: put.record.resourcesSha256,
        manifest_hash: put.record.manifestHash, author_session_id: candidate.authorSessionId,
      }
    })
  }

  /** Captain narrow read face: the ACTUAL bodies, digests, base versions,
   * authors and request bindings of this Team's captured candidates — a
   * review is never a blind approve on a name/version pair. Status reads the
   * durable approval fact ONLY when that fact was decided from THIS exact
   * immutable capture; a same-slot release of a different capture (or a
   * Host-compatibility approval with no candidate witness) never reports this
   * candidate approved and never fills it with the other release's digests. */
  async listCandidates(raw: unknown, exec: SkillsCallAuthority): Promise<{ candidates: SkillsCandidateView[] }> {
    const { input, scope, teamId } = await this.captainFace(exec, value => listInputSchema.parse(value), raw)
    const limit = input.limit ?? 20
    const found: SkillsCandidateView[] = []
    for (const record of this.deps.store.candidateEntries(teamId, false, 256)) {
      if (record.scope !== scope) continue
      const approval = this.deps.store.getRelease(scope, teamId, record.name, record.version)
      const view = candidateView(record, approval?.approvedCandidateHash === record.candidateHash)
      if (input.pending_only === true && view.status !== 'pending') continue
      found.push(view)
      if (found.length >= limit) break
    }
    return { candidates: found }
  }
}

/** Candidate wire view. `ownApprovalFact` means the durable release row was
 * decided from THIS exact capture (candidateHash bound); no other same-slot
 * release can mark this candidate approved. */
function candidateView(record: SkillsReleaseCandidateRecord, ownApprovalFact: boolean): SkillsCandidateView {
  const status = record.status === 'pending' && ownApprovalFact ? 'approved' : record.status
  return {
    scope: record.scope, team_id: record.teamId, skill_name: record.name, version: record.version,
    status, author_session_id: record.authorSessionId, candidate_hash: record.candidateHash,
    request_id: record.requestId,
    ...(record.baseVersion === undefined ? {} : { base_version: record.baseVersion }),
    provider: record.provider, locator: record.locator, body: record.body,
    content_sha256: record.contentSha256, applicability: record.applicability, verification: record.verification,
  }
}
