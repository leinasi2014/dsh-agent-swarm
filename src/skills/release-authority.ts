/**
 * S2 first-slice release authority (docs04 §release/assign, docs07 §5):
 * the Host management face that approves IMMUTABLE captured-body releases,
 * the Captain assignment face, and the module-owned assembly provider that
 * makes a COMMITTED ASSIGNMENT the thing both official load paths (skill
 * tool result and /name gesture) actually serve FOR THE ASSIGNED MEMBER.
 *
 * Assembly discipline: `approveRelease` captures the exact body text and the
 * digest it was approved against (a digest over different text is refused at
 * entry; the first slice additionally forces the agreed EMPTY resources-tree
 * digest and refuses to pretend it validated an arbitrary one). A committed
 * assignment then registers the module-owned provider into the ASSIGNED
 * MEMBER'S OWN scoped layer: the optional-`skills` inject provides a Context
 * on which `skills` IS declared, and the exact-Agent scope is minted FROM
 * THAT Context (official `createScope` from @deepseek-ai/dsh-scope; the
 * registration layer is derived from that scoped context), bound to exactly
 * this scope+Team+member. Both official load paths read with `scope: agent`,
 * so
 * ONLY that member's requests resolve the pinned body; teammates and
 * unrelated Sessions keep resolving the raw source. A same-named source that
 * later changes can therefore never enter the assigned member's real
 * requests while the assignment stands. In-flight version swaps are refused
 * (create-first + identical replay only), so an already loaded attempt can
 * never have its body silently replaced; versioned reassignment is an
 * explicit later-slice capability. The live-session scope is the first-slice
 * window; durable re-assembly after a cold member resume belongs to a later
 * slice. Disposer ownership: every member registration's official effect
 * disposer is held here and released exactly once by `closeAssembly()` from
 * the module's close path. The publish/allow-list boundary is unchanged:
 * this file never touches Team allowedSkills (assignment refuses off-list
 * names; the official surface independently enforces the load entry).
 *
 * @module dsh-agent-swarm/skills/release-authority
 */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SkillDefinition, SkillProvider, SkillProviderControl, SkillRegistry } from '@deepseek-ai/dsh-skill'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { TeamDomainError } from '../domain/error.js'
import { canonicalJson, skillsReleaseManifestHash, type SkillsManagementStore, type SkillsReleaseRecord, type SkillsRequestRecord } from '../storage/skills-management.js'
import type { TeamState } from '../domain/types.js'
import type { SkillsManagementDeps } from './module.js'
import type { SkillsCallAuthority } from './contracts.js'
import type { AuthorityGuards } from './authority-guards.js'

/** Frozen contract: the module-owned assembly provider name (the spec asserts
 * it from the public contract header; the governed surface stamps load
 * provenance only for definitions served by this provider). */
export const RELEASE_PROVIDER_NAME = 'agent_swarm_skills_release'

/** The first slice supports exactly the explicit EMPTY resources tree: its
 * digest is computed from the canonical form, never accepted as arbitrary. */
const EMPTY_RESOURCES_SHA256 = sha256Text(canonicalJson([]))

/** Adopted release identity a request may be attributed to: the exact
 * member Session, task/attempt binding and pinned manifest. */
export interface SkillsAdoption {
  readonly owner: string
  readonly skillName: string
  readonly version: string
  readonly manifestHash: string
  readonly taskId: string
  readonly attemptId?: string
}

/** The full-manifest load attribution the governed surface stamps onto the
 * MEMBER's own official Session when the pinned body actually enters one of
 * the member's real requests (tool result or legitimate skill-invocation).
 * `taskId`/`attemptId` ride only when exactly derivable at load time. */
export interface SkillReleaseProvenance {
  readonly teamId: string
  readonly memberSessionId: string
  readonly name: string
  readonly version: string
  readonly provider: string
  readonly locator: string
  readonly manifestHash: string
  readonly contentSha256: string
  readonly resourcesSha256: string
  readonly applicability: string
  readonly verification: string
  readonly approvedBy: string
  readonly approvedAt: number
  readonly taskId?: string
  readonly attemptId?: string
}

export interface ReleaseAuthorityDeps {
  readonly ctx: Context
  readonly store: SkillsManagementStore
  readonly guards: AuthorityGuards
  readonly domain: SkillsManagementDeps
  readonly lane: <T>(scope: string, teamId: string, fn: () => Promise<T>) => Promise<T>
}

/** The wire view of one live assignment (the assign tool's compact receipt). */
export interface SkillsAssignmentView {
  readonly scope: string
  readonly team_id: string
  readonly member_session_id: string
  readonly skill_name: string
  readonly version: string
  readonly release_manifest_hash: string
  readonly revision: number
}

const boundedText = (maxBytes: number) => z.string().min(1).refine(
  value => Buffer.byteLength(value, 'utf8') <= maxBytes,
  `must not exceed ${maxBytes} UTF-8 bytes`,
)
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/)
const skillNameField = boundedText(256).refine(value => /^[a-z0-9][a-z0-9-]*$/.test(value), 'must be kebab-case')

const approveInputSchema = z.object({
  scope: boundedText(4_096),
  teamId: boundedText(256),
  skillName: skillNameField,
  version: boundedText(64),
  provider: boundedText(256),
  locator: boundedText(1_024),
  body: boundedText(65_536),
  contentSha256: sha256Hex,
  resourcesSha256: sha256Hex,
  applicability: boundedText(1_024),
  verification: boundedText(1_024),
  approvedBy: boundedText(256),
}).strict()

const assignInputSchema = z.object({
  skill_name: skillNameField,
  version: boundedText(64),
  member: boundedText(256),
  expected_revision: z.number().int().min(0).optional(),
}).strict()

function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** One live member assembly: the officially minted exact-Agent scope (whose
 * scoped context registers the provider INTO that Agent's own layer) plus the
 * exact provider disposer and the minted scope's idempotent disposal. */
interface MemberAssembly {
  disposeScope: () => Promise<void>
  providerDisposer: () => void
  control: SkillProviderControl | undefined
}

export class ReleaseAuthority {
  /** One live assembly registration per assigned member; the disposer owns
   * the exact official effect returned by the member-scoped registration. */
  private readonly memberAssemblies = new Map<string, MemberAssembly>()
  /** The Context provided by the optional `skills` inject — a Context on
   * which `skills` IS a declared dependency (the module itself keeps the
   * service OPTIONAL, so no-registry compositions still mount). Cleared when
   * the inject fiber's own effect unwinds. */
  private skillsCtx: Context | undefined

  constructor(private readonly deps: ReleaseAuthorityDeps) {
    deps.ctx.inject(['skills'], skillsCtx => {
      skillsCtx.effect(() => {
        this.skillsCtx = skillsCtx
        return () => { this.skillsCtx = undefined }
      })
    })
  }

  /** Inject-safe optional read of the official registry (never a required
   * property access the composition may not provide). */
  private readonly skillsOf = (): SkillRegistry | undefined => this.skillsCtx?.get('skills')

  /** Host management face (NOT a model tool): approve one immutable release.
   * The captured body and its digest are bound at entry (digest-mismatch is
   * refused); the same key with the same manifest replays, a differing
   * manifest conflicts loudly. */
  async approveRelease(raw: unknown): Promise<Record<string, unknown>> {
    const input = approveInputSchema.parse(raw)
    this.deps.guards.assertAdmission()
    this.deps.guards.assertManifest(input.scope, input.teamId)
    if (sha256Text(input.body) !== input.contentSha256) {
      throw new TeamDomainError('the release digest-mismatches: contentSha256 is not the SHA-256 of the captured body', 'SKILLS_RELEASE_DIGEST_MISMATCH')
    }
    if (input.resourcesSha256 !== EMPTY_RESOURCES_SHA256) {
      throw new TeamDomainError('the first slice approves only the explicit empty resources tree (its canonical digest); a resources payload would not be assembled and cannot be claimed as verified', 'SKILLS_RELEASE_RESOURCES_UNSUPPORTED')
    }
    const manifest = {
      name: input.skillName,
      version: input.version,
      provider: input.provider,
      locator: input.locator,
      body: input.body,
      contentSha256: input.contentSha256,
      resourcesSha256: input.resourcesSha256,
      applicability: input.applicability,
      verification: input.verification,
      approvedBy: input.approvedBy,
    }
    const put = await this.deps.store.putReleaseIfAbsent(input.scope, input.teamId, {
      ...manifest,
      approvedAt: Date.now(),
      manifestHash: skillsReleaseManifestHash(manifest),
    })
    if (!put.created && put.record.manifestHash !== skillsReleaseManifestHash(manifest)) {
      throw new TeamDomainError(`release ${input.skillName}@${input.version} already exists with a different immutable manifest`, 'SKILLS_RELEASE_CONFLICT')
    }
    return this.releaseView(put.record)
  }

  /** Captain face: assign an approved release version to ONE live member of
   * this Team, CAS by `expected_revision` (0 = create-first; identical
   * content replays; a version swap is refused in-flight). Refuses off-list
   * names, non-members and non-live member Sessions durably writing nothing;
   * the durable commit is followed by the member-scoped assembly registration (exact-Agent `createScope` mint)
   * bound to this exact scope+Team+member. */
  async assign(raw: unknown, exec: SkillsCallAuthority): Promise<SkillsAssignmentView> {
    if (exec.agent === undefined) throw new TeamDomainError('assignment requires the exact calling Captain Agent', 'SKILLS_UNAUTHORIZED')
    const agent = exec.agent
    const input = assignInputSchema.parse(raw)
    const scope = this.deps.domain.scopeOf(agent)
    const membership = await this.deps.guards.assertCaptain(agent, scope)
    const teamId = membership.team.id
    this.deps.guards.assertManifest(scope, teamId)
    return await this.deps.lane(scope, teamId, async () => {
      this.deps.guards.assertAdmission()
      exec.signal?.throwIfAborted()
      const team = (await this.deps.domain.listTeamAggregates(scope)).find(candidate => candidate.id === teamId)
      if (team === undefined) throw new TeamDomainError('the Captain Team vanished', 'SKILLS_TEAM_MISSING')
      if (team.allowedSkills !== undefined && !team.allowedSkills.includes(input.skill_name)) {
        throw new TeamDomainError(`skill ${input.skill_name} is not-team-allowed: it is outside this Team's allow-list`, 'SKILLS_NOT_TEAM_ALLOWED')
      }
      if (team.members?.find(member => member.sessionId === input.member) === undefined) {
        throw new TeamDomainError(`member ${input.member} is not in this Team`, 'SKILLS_MEMBER_NOT_FOUND')
      }
      const memberAgent = this.deps.ctx.agents.get(SessionId(input.member))
      if (memberAgent === undefined) {
        throw new TeamDomainError(`member ${input.member} is not live; assembly cannot be bound to a cold Session in this slice`, 'SKILLS_MEMBER_NOT_LIVE')
      }
      const release = this.deps.store.getRelease(scope, teamId, input.skill_name, input.version)
      if (release === undefined) throw new TeamDomainError(`no approved release ${input.skill_name}@${input.version}`, 'SKILLS_RELEASE_NOT_FOUND')
      const expected = input.expected_revision ?? 0
      const existing = this.deps.store.getAssignment(scope, teamId, input.member, input.skill_name)
      if (existing !== undefined) {
        if (existing.revision !== expected) {
          throw new TeamDomainError(`assignment moved to revision ${existing.revision}; this writer expected ${expected}`, 'SKILLS_ASSIGNMENT_STALE')
        }
        if (existing.version !== input.version || existing.releaseManifestHash !== release.manifestHash) {
          throw new TeamDomainError(`reassigning ${input.skill_name} while an assignment stands is not supported in this slice (in-flight loads keep their pinned body)`, 'SKILLS_ASSIGNMENT_REASSIGN_UNSUPPORTED')
        }
        await this.assemble(scope, teamId, input.member, memberAgent)
        return this.assignmentView(existing)
      }
      if (expected !== 0) throw new TeamDomainError(`assignment ${input.skill_name} does not exist; expected_revision ${expected} cannot create`, 'SKILLS_ASSIGNMENT_STALE')
      const put = await this.deps.store.putAssignmentIfAbsent(scope, teamId, input.member, {
        name: input.skill_name, version: input.version, releaseManifestHash: release.manifestHash, assignedBy: agent.id,
      })
      // Durable-then-visible: the assembly effect starts only after the
      // official durable commit resolved, behind the final fence.
      this.deps.guards.assertAdmission()
      exec.signal?.throwIfAborted()
      await this.assemble(scope, teamId, input.member, memberAgent)
      return this.assignmentView(put.record)
    })
  }

  /**
   * The available-version ANSWER decision for one investigated request (never
   * the effective claim — real member requests prove assembly): requires the
   * named skill, the task's durable owner, an assignment pinning an existing
   * release, an explicit allow-list inclusion, and — read through the OWNER'S
   * own scope — the registry winner digest equaling the release digest (fail
   * closed when the owner is not live or the registry is absent).
   */
  async adoptionForRequest(scope: string, teamId: string, record: SkillsRequestRecord): Promise<SkillsAdoption | undefined> {
    const skillName = record.payload.skillName
    const taskId = record.payload.taskId
    if (skillName === undefined || taskId === undefined) return undefined
    const team: TeamState | undefined = (await this.deps.domain.listTeamAggregates(scope)).find(candidate => candidate.id === teamId)
    const task = team?.tasks.find(candidate => candidate.id === taskId)
    const owner = task?.ownerSessionId
    if (team === undefined || task === undefined || owner === undefined) return undefined
    if (team.allowedSkills !== undefined && !team.allowedSkills.includes(skillName)) return undefined
    const adoption = this.pendingFromDurable(scope, teamId, owner, skillName, taskId, task.currentAttemptId === undefined ? undefined : String(task.currentAttemptId))
    if (adoption === undefined) return undefined
    return await this.assembledDigestMatches(scope, teamId, adoption) ? adoption : undefined
  }

  /** The durable result extension for one adopted answer: attribution bound
   * to the exact member Session, task/attempt and pinned manifest. */
  adoptionResult(adoption: SkillsAdoption): Record<string, unknown> {
    return {
      availableVersion: { name: adoption.skillName, version: adoption.version },
      attribution: {
        memberSessionId: adoption.owner,
        taskId: adoption.taskId,
        ...(adoption.attemptId === undefined ? {} : { attemptId: adoption.attemptId }),
        name: adoption.skillName,
        version: adoption.version,
        manifestHash: adoption.manifestHash,
      },
    }
  }

  /** FINAL synchronous re-validation at the durable commit boundary. */
  stillPinned(scope: string, teamId: string, adoption: SkillsAdoption): boolean {
    const assignment = this.deps.store.getAssignment(scope, teamId, adoption.owner, adoption.skillName)
    if (assignment === undefined || assignment.version !== adoption.version) return false
    const release = this.deps.store.getRelease(scope, teamId, assignment.name, assignment.version)
    return release !== undefined && release.manifestHash === assignment.releaseManifestHash
  }

  /** Release every held member assembly exactly once (module close): the
   * exact provider effect first, then the minted scope's own disposal. */
  async closeAssembly(): Promise<void> {
    const held = [...this.memberAssemblies.values()]
    this.memberAssemblies.clear()
    for (const assembly of held) {
      assembly.providerDisposer()
      await assembly.disposeScope()
    }
  }

  private pendingFromDurable(scope: string, teamId: string, owner: string, skillName: string, taskId: string, attemptId: string | undefined): SkillsAdoption | undefined {
    const assignment = this.deps.store.getAssignment(scope, teamId, owner, skillName)
    if (assignment === undefined) return undefined
    const release = this.deps.store.getRelease(scope, teamId, assignment.name, assignment.version)
    if (release === undefined || release.manifestHash !== assignment.releaseManifestHash) return undefined
    return { owner, skillName, version: assignment.version, manifestHash: release.manifestHash, taskId, ...(attemptId === undefined ? {} : { attemptId }) }
  }

  /** The full-manifest attribution record for one REAL load: the governed
   * surface calls this at the exact moment a pinned body enters the member's
   * request. Valid only while exactly one pinned assignment+release stands
   * for that member+name (never a guess, never from a stale pin).
   * `taskId`/`attemptId` ride only when the member owns exactly one
   * in-progress task. */
  async loadProvenanceForMember(memberSessionId: string, name: string): Promise<SkillReleaseProvenance | undefined> {
    const pinned = this.deps.store.assignmentEntries().filter(assignment => assignment.memberSessionId === memberSessionId && assignment.name === name)
    const assignment = pinned.length === 1 ? pinned[0] : undefined
    if (assignment === undefined) return undefined
    const release = this.deps.store.getRelease(assignment.scope, assignment.teamId, name, assignment.version)
    if (release === undefined || release.manifestHash !== assignment.releaseManifestHash) return undefined
    const team = (await this.deps.domain.listTeamAggregates(assignment.scope)).find(candidate => candidate.id === assignment.teamId)
    const owned = (team?.tasks ?? []).filter(task => task.ownerSessionId === memberSessionId && task.status === 'in_progress')
    const sole = owned.length === 1 ? owned[0] : undefined
    return {
      teamId: assignment.teamId,
      memberSessionId,
      name,
      version: assignment.version,
      provider: release.provider,
      locator: release.locator,
      manifestHash: release.manifestHash,
      contentSha256: release.contentSha256,
      resourcesSha256: release.resourcesSha256,
      applicability: release.applicability,
      verification: release.verification,
      approvedBy: release.approvedBy,
      approvedAt: release.approvedAt,
      ...(sole === undefined ? {} : { taskId: sole.id, ...(sole.currentAttemptId === undefined ? {} : { attemptId: String(sole.currentAttemptId) }) }),
    }
  }

  /** The member-scoped registry winner must BE the pinned body (digest). A
   * cold owner cannot be verified, so the answer fails closed. */
  private async assembledDigestMatches(scope: string, teamId: string, adoption: SkillsAdoption): Promise<boolean> {
    const release = this.deps.store.getRelease(scope, teamId, adoption.skillName, adoption.version)
    const memberAgent = this.deps.ctx.agents.get(SessionId(adoption.owner))
    const skills = this.skillsOf()
    if (release === undefined || memberAgent === undefined || skills === undefined) return false
    try {
      const winner = await skills.get(adoption.skillName, { scope: memberAgent })
      return winner !== undefined && sha256Text(winner.content) === release.contentSha256
    } catch {
      return false
    }
  }

  /** Ensure this member's scoped layer carries the bound assembly provider.
   * Wiring (per Captain instruction): `ctx.inject(['skills'], …)` provides a
   * Context on which `skills` IS a declared dependency (the module itself
   * keeps the service optional); the exact-Agent scope is minted FROM THAT
   * Context via `createScope`, so the minted scoped context can resolve
   * `skills` and `ScopedLayers.effect` derives the registration layer from
   * its scope key (the exact Agent). The governed load paths read
   * `get(name, { scope: agent })` with the same key, so only this Agent's
   * scope sees the pinned body. Lifecycle converges from BOTH sides: the
   * member Agent's own `ctx.effect` and the module close path each fully
   * dispose the minted scope and provider registration. */
  private async assemble(scope: string, teamId: string, memberSessionId: string, memberAgent: Agent): Promise<void> {
    const existing = this.memberAssemblies.get(memberSessionId)
    if (existing !== undefined) {
      if (existing.control !== undefined && !existing.control.signal.aborted) {
        existing.control.invalidate()
        return
      }
      // The previous registration died with its Session's effect scope;
      // FULLY converge it (awaited) before minting a replacement, so two
      // live registrations never coexist.
      existing.providerDisposer()
      await existing.disposeScope()
      this.memberAssemblies.delete(memberSessionId)
    }
    const skillsCtx = this.skillsCtx
    if (skillsCtx === undefined) {
      throw new TeamDomainError(`the Skill registry is not provided in this composition; the approved assembly for member ${memberSessionId} cannot be served`, 'SKILLS_REGISTRY_UNAVAILABLE')
    }
    const minted = createScope(skillsCtx, memberAgent)
    let providerDisposer: (() => void) | undefined
    let control: SkillProviderControl | undefined
    try {
      const skills = minted.ctx.get('skills')
      if (skills === undefined) {
        throw new TeamDomainError(`the Skill registry is not provided in this composition; the approved assembly for member ${memberSessionId} cannot be served`, 'SKILLS_REGISTRY_UNAVAILABLE')
      }
      // `create` runs synchronously inside registerProvider, so `control` is
      // already captured when the assembly is recorded below.
      providerDisposer = skills.registerProvider((received: SkillProviderControl) => {
        control = received
        return this.buildProvider(scope, teamId, memberSessionId)
      })
    } catch (error) {
      await minted.dispose()
      throw error
    }
    const assembly: MemberAssembly = { disposeScope: minted.dispose, providerDisposer, control }
    this.memberAssemblies.set(memberSessionId, assembly)
    // Member-side lifecycle: when this Agent's own effect scope unwinds, the
    // assembly converges with it (module-side close stays idempotent).
    memberAgent.ctx.effect(() => async () => {
      if (this.memberAssemblies.get(memberSessionId) === assembly) this.memberAssemblies.delete(memberSessionId)
      assembly.providerDisposer()
      await assembly.disposeScope()
    })
  }

  /** The provider serves EXACTLY this scope+Team+member's assigned manifests. */
  private buildProvider(scope: string, teamId: string, memberSessionId: string): SkillProvider {
    const store = this.deps.store
    return {
      name: RELEASE_PROVIDER_NAME,
      async list() {
        return store.assignmentEntries().flatMap(assignment => {
          if (assignment.scope !== scope || assignment.teamId !== teamId || assignment.memberSessionId !== memberSessionId) return []
          const release = store.getRelease(scope, teamId, assignment.name, assignment.version)
          if (release === undefined || release.manifestHash !== assignment.releaseManifestHash) return []
          return [{
            name: assignment.name,
            description: `Approved release ${assignment.name}@${assignment.version} pinned by manifest ${assignment.releaseManifestHash.slice(0, 12)}`,
            invocation: { modelInvocable: true, userInvocable: true },
            source: 'runtime' as const,
            provider: RELEASE_PROVIDER_NAME,
            rank: 0,
            locator: JSON.stringify([scope, teamId, assignment.name, assignment.version]),
          }]
        })
      },
      async get(candidate: { locator?: unknown; description?: string }): Promise<SkillDefinition | undefined> {
        if (typeof candidate.locator !== 'string') return undefined
        try {
          const [locatorScope, locatorTeam, name, version] = JSON.parse(candidate.locator) as string[]
          if (locatorScope !== scope || locatorTeam !== teamId) return undefined
          const release = store.getRelease(scope, teamId, name!, version!)
          if (release === undefined) return undefined
          return {
            name: release.name,
            description: candidate.description ?? `Approved release ${release.name}@${release.version}`,
            content: release.body,
            provider: RELEASE_PROVIDER_NAME,
            invocation: { modelInvocable: true, userInvocable: true },
            source: 'runtime' as const,
          }
        } catch {
          return undefined
        }
      },
    }
  }

  private releaseView(record: SkillsReleaseRecord): Record<string, unknown> {
    return {
      scope: record.scope, teamId: record.teamId, name: record.name, version: record.version,
      provider: record.provider, content_sha256: record.contentSha256, resources_sha256: record.resourcesSha256,
      manifest_hash: record.manifestHash,
    }
  }

  private assignmentView(record: { scope: string; teamId: string; memberSessionId: string; name: string; version: string; releaseManifestHash: string; revision: number }): SkillsAssignmentView {
    return {
      scope: record.scope, team_id: record.teamId, member_session_id: record.memberSessionId,
      skill_name: record.name, version: record.version, release_manifest_hash: record.releaseManifestHash,
      revision: record.revision,
    }
  }
}
