/**
 * S2 release authority (docs04 §release/assign, docs07 §5/§6): the Host
 * management compatibility face that approves IMMUTABLE captured-body
 * releases, the Captain assignment/version-choice face, and the module-owned
 * assembly provider that makes a COMMITTED ASSIGNMENT the thing both official
 * load paths (skill tool result and /name gesture) actually serve FOR THE
 * ASSIGNED MEMBER. The request-facing independent loop (manager capture +
 * Captain review) lives in `release-candidates.ts`.
 *
 * Assembly discipline: approvals capture the exact body text and digest
 * (digest-mismatch refused at entry; the EMPTY resources-tree digest is the
 * only one this slice accepts). A committed assignment registers the
 * module-owned provider into the ASSIGNED MEMBER'S OWN scoped layer (official
 * `createScope` mint from the optional-`skills` inject Context, bound to
 * exactly this scope+Team+member), so only that member's requests resolve the
 * pinned body; teammates keep the raw source. Each assembly FREEZES the
 * versions actually effective at mint: body and load provenance both read the
 * snapshot, so a Captain re-pin never hot-swaps a loaded body nor
 * mis-attributes it; the snapshot advances only at the next real attempt
 * boundary (`advanceAtAttemptBoundary`) or a cold continuation
 * (`reassembleColdMember`), both awaited by the governed surface. Disposer
 * ownership: every registration's official effect disposer is held here and
 * released exactly once; the assembly also converges from the member's own
 * `ctx.effect`. Team allowedSkills is never touched here (assignment refuses
 * off-list names; the surface independently enforces the load entry).
 *
 * @module dsh-agent-swarm/skills/release-authority
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SkillProviderControl, SkillRegistry } from '@deepseek-ai/dsh-skill'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { TeamDomainError } from '../domain/error.js'
import type { SkillsManagementStore, SkillsReleaseRecord, SkillsRequestRecord } from '../storage/skills-management.js'
import { EMPTY_RESOURCES_SHA256, sha256Text, skillsReleaseManifestHash } from '../storage/skills-release-tables.js'
import type { TeamState } from '../domain/types.js'
import type { SkillsManagementDeps } from './module.js'
import type { SkillsCallAuthority } from './contracts.js'
import type { AuthorityGuards } from './authority-guards.js'
import { assignmentView, buildReleaseProvider, releaseView, type MemberAssembly, type SkillsAssignmentView } from './release-assembly.js'

// Assembly-side pieces live in `release-assembly.ts` (cohesive split for the
// 600-line source gate); re-exported so existing importers keep their path.
export { RELEASE_PROVIDER_NAME, type SkillsAssignmentView } from './release-assembly.js'

/** Adopted release identity a request may be attributed to: the exact
 * member Session, task/attempt binding and pinned manifest. */
export interface SkillsAdoption {
  readonly owner: string
  readonly skillName: string
  readonly version: string
  readonly manifestHash: string
  readonly taskId: string
  readonly attemptId?: string
  /** The adoption was read from the member's EFFECTIVE assembly snapshot (a
   * held load), not from the current durable pin — commit-boundary
   * re-validation then checks the assembly, not the (possibly re-pinned)
   * assignment row. */
  readonly fromAssembly?: true
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

export class ReleaseAuthority {
  /** One live assembly registration per assigned member; the disposer owns
   * the exact official effect returned by the member-scoped registration. */
  private readonly memberAssemblies = new Map<string, MemberAssembly>()
  /** Members whose cold re-assembly is currently being (re-)authorized. */
  private readonly reassembling = new Set<string>()
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

  /** Host management face (NOT a model tool): approve one immutable release
   * from a Host-SUPPLIED body — the trusted external management boundary
   * (compatibility entry). The captured body and its digest are bound at
   * entry (digest-mismatch is refused); the same key with the same manifest
   * replays, a differing manifest conflicts loudly. This is NOT the
   * request-facing closed loop: for that, the real Skills manager PROPOSES
   * through `proposeCandidate` (author = the derived calling Agent) and an
   * INDEPENDENT Captain approves through `reviewCandidate`. */
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

  /** Captain face: choose the approved release VERSION one live member of
   * this Team carries, CAS by `expected_revision` (0 = create-first; identical
   * content replays; with the live revision matched, a different APPROVED
   * version re-pins atomically — the controlled version choice and rollback of
   * docs07 §6). A body already LOADED in the member's current assembly is
   * held, never hot-swapped (`loaded_held: true`; the next cold continuation
   * picks the new pin); an unloaded live assembly switches immediately, and a
   * COLD member's pin simply moves (re-assembly follows the durable pin at
   * official cold continuation). Refuses off-list names, non-members,
   * unapproved versions and stale revisions durably writing nothing; creation
   * additionally requires a live member to bind the assembly (exact-Agent
   * `createScope` mint) to this exact scope+Team+member. */
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
      const release = this.deps.store.getRelease(scope, teamId, input.skill_name, input.version)
      if (release === undefined) throw new TeamDomainError(`no approved release ${input.skill_name}@${input.version}`, 'SKILLS_RELEASE_NOT_FOUND')
      const expected = input.expected_revision ?? 0
      const existing = this.deps.store.getAssignment(scope, teamId, input.member, input.skill_name)
      if (existing !== undefined) {
        if (existing.revision !== expected) {
          throw new TeamDomainError(`assignment moved to revision ${existing.revision}; this writer expected ${expected}`, 'SKILLS_ASSIGNMENT_STALE')
        }
        if (existing.version === input.version && existing.releaseManifestHash === release.manifestHash) {
          if (memberAgent !== undefined) await this.assemble(scope, teamId, input.member, memberAgent)
          return this.assignmentView(existing)
        }
        // Controlled version choice / rollback across APPROVED versions: one
        // atomic CAS re-pin under the exact live revision, durable-then-visible.
        const moved = await this.deps.store.updateAssignmentPin(scope, teamId, input.member, input.skill_name, expected, {
          version: input.version, releaseManifestHash: release.manifestHash, assignedBy: agent.id,
        })
        if (moved === undefined) throw new TeamDomainError('the assignment moved under this writer; retry against the live revision', 'SKILLS_ASSIGNMENT_STALE')
        const assembly = this.memberAssemblies.get(input.member)
        const loadedHeld = assembly !== undefined && assembly.loads.count > 0
        // An UNLOADED live assembly switches now by REBUILDING from the new
        // pin (the old registration is fully disposed first); a LOADED one is
        // held — body and provenance stay on its frozen snapshot until the
        // next cold continuation mints a new assembly.
        if (memberAgent !== undefined && !loadedHeld) await this.assemble(scope, teamId, input.member, memberAgent, { rebuild: true })
        return this.assignmentView(moved, loadedHeld)
      }
      if (expected !== 0) throw new TeamDomainError(`assignment ${input.skill_name} does not exist; expected_revision ${expected} cannot create`, 'SKILLS_ASSIGNMENT_STALE')
      if (memberAgent === undefined) {
        throw new TeamDomainError(`member ${input.member} is not live; a first assembly cannot be bound to a cold Session`, 'SKILLS_MEMBER_NOT_LIVE')
      }
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

  /** The adopted ANSWER for one investigated request (never the effective
   * claim — real member requests prove assembly): requires the named skill,
   * the task's durable owner, an explicit allow-list inclusion, and — read
   * through the OWNER'S own scope — the registry winner digest equaling the
   * adopted body digest (fail closed when the owner is not live or the
   * registry is absent). */
  async adoptionForRequest(scope: string, teamId: string, record: SkillsRequestRecord): Promise<SkillsAdoption | undefined> {
    const skillName = record.payload.skillName
    const taskId = record.payload.taskId
    if (skillName === undefined || taskId === undefined) return undefined
    const team: TeamState | undefined = (await this.deps.domain.listTeamAggregates(scope)).find(candidate => candidate.id === teamId)
    const task = team?.tasks.find(candidate => candidate.id === taskId)
    const owner = task?.ownerSessionId
    if (team === undefined || task === undefined || owner === undefined) return undefined
    if (team.allowedSkills !== undefined && !team.allowedSkills.includes(skillName)) return undefined
    const attemptId = task.currentAttemptId === undefined ? undefined : String(task.currentAttemptId)
    // The EFFECTIVE assembly wins over the current durable pin: after a
    // Captain re-pin that a loaded member is still holding, a request about
    // the proven attempt answers with the version that attempt REALLY loads
    // (the frozen snapshot), never a newer pin reverse-derived from the
    // current assignment. Only without a live assembly does the durable pin
    // answer (no cold load can be proven; fail-closed digest check follows).
    const snapshot = this.memberAssemblies.get(owner)?.pinned.get(skillName)
    const adoption = snapshot !== undefined
      ? { owner, skillName, version: snapshot.version, manifestHash: snapshot.manifestHash, taskId, ...(attemptId === undefined ? {} : { attemptId }), fromAssembly: true as const }
      : this.pendingFromDurable(scope, teamId, owner, skillName, taskId, attemptId)
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

  /** FINAL synchronous re-validation at the durable commit boundary: an
   * assembly-sourced adoption stays valid while that same frozen snapshot
   * still stands; a durable-sourced one while the pin still verifies. */
  stillPinned(scope: string, teamId: string, adoption: SkillsAdoption): boolean {
    if (adoption.fromAssembly === true) {
      return this.memberAssemblies.get(adoption.owner)?.pinned.get(adoption.skillName)?.manifestHash === adoption.manifestHash
    }
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

  /** Cold-continuation re-assembly (awaited by the governed surface):
   * assignments are durable while assemblies follow the member Session, so a
   * resumed member Agent re-mints its member-scoped provider from the CURRENT
   * durable pin. Every pin is re-authorized against the live Team aggregate
   * (roster membership + allow-list + intact release row); no pin, no
   * registration. */
  async reassembleColdMember(memberSessionId: string): Promise<void> {
    if (this.memberAssemblies.has(memberSessionId) || this.reassembling.has(memberSessionId)) return
    const agent = this.deps.ctx.agents.get(SessionId(memberSessionId))
    if (agent === undefined || this.skillsCtx === undefined) return
    this.reassembling.add(memberSessionId)
    try {
      for (const assignment of this.deps.store.assignmentEntries()) {
        if (assignment.memberSessionId !== memberSessionId) continue
        const team = (await this.deps.domain.listTeamAggregates(assignment.scope)).find(candidate => candidate.id === assignment.teamId)
        if (team === undefined) continue
        if (team.members?.find(member => member.sessionId === memberSessionId) === undefined) continue
        if (team.allowedSkills !== undefined && !team.allowedSkills.includes(assignment.name)) continue
        const release = this.deps.store.getRelease(assignment.scope, assignment.teamId, assignment.name, assignment.version)
        if (release === undefined || release.manifestHash !== assignment.releaseManifestHash) continue
        await this.assemble(assignment.scope, assignment.teamId, memberSessionId, agent)
      }
    } finally {
      this.reassembling.delete(memberSessionId)
    }
  }

  /** Every current durable pin of one member whose release row still verifies
   * (the candidate snapshot at mint; also the diff target for attempt-boundary
   * advancement). */
  private collectPinned(scope: string, teamId: string, memberSessionId: string): Map<string, SkillsReleaseRecord> {
    const pinned = new Map<string, SkillsReleaseRecord>()
    for (const assignment of this.deps.store.assignmentEntries()) {
      if (assignment.scope !== scope || assignment.teamId !== teamId || assignment.memberSessionId !== memberSessionId) continue
      const release = this.deps.store.getRelease(scope, teamId, assignment.name, assignment.version)
      if (release === undefined || release.manifestHash !== assignment.releaseManifestHash) continue
      pinned.set(assignment.name, release)
    }
    return pinned
  }

  /** LIVE-BOUNDARY version advance (the awaited counterpart of cold
   * re-assembly): a loaded body is held only inside the attempt that loaded
   * it. Once the member's sole in-progress task/attempt moved past that load
   * (official accept/new-task inside the SAME Activation), a fresh frozen
   * assembly is re-minted from the durable pin — a re-pin or rollback — so
   * the new attempt really carries the chosen version. An unloaded assembly
   * switches whenever the pins moved. Never touches an assembly mid-attempt,
   * never hot-swaps a body. */
  async advanceAtAttemptBoundary(memberSessionId: string): Promise<void> {
    const assembly = this.memberAssemblies.get(memberSessionId)
    if (assembly === undefined || assembly.control === undefined || assembly.control.signal.aborted) return
    if (this.reassembling.has(memberSessionId)) return
    const current = this.collectPinned(assembly.scope, assembly.teamId, memberSessionId)
    const moved = [...current.entries()].some(([name, release]) => {
      const frozen = assembly.pinned.get(name)
      return frozen === undefined || frozen.manifestHash !== release.manifestHash
    }) || current.size !== assembly.pinned.size
    if (!moved) return
    if (assembly.loads.count > 0) {
      const team = (await this.deps.domain.listTeamAggregates(assembly.scope)).find(candidate => candidate.id === assembly.teamId)
      const owned = (team?.tasks ?? []).filter(task => task.ownerSessionId === memberSessionId && task.status === 'in_progress')
      const sole = owned.length === 1 ? owned[0] : undefined
      if (sole === undefined) return
      if (assembly.lastLoad !== undefined
        && assembly.lastLoad.taskId === sole.id
        && assembly.lastLoad.attemptId === (sole.currentAttemptId === undefined ? undefined : String(sole.currentAttemptId))) return
    }
    const agent = this.deps.ctx.agents.get(SessionId(memberSessionId))
    if (agent === undefined) return
    this.reassembling.add(memberSessionId)
    try {
      await this.assemble(assembly.scope, assembly.teamId, memberSessionId, agent, { rebuild: true })
    } finally {
      this.reassembling.delete(memberSessionId)
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
   * surface calls this the moment a pinned body enters the member's request.
   * It reads the member's CURRENT assembly SNAPSHOT — the same immutable
   * record the provider served — so provenance can never name a newer pin
   * than the body actually loaded (no assembly/snapshot fails closed; there
   * is no durable-pin fallback). `taskId`/`attemptId` ride only when the
   * member owns exactly one in-progress task. */
  async loadProvenanceForMember(memberSessionId: string, name: string): Promise<SkillReleaseProvenance | undefined> {
    const assembly = this.memberAssemblies.get(memberSessionId)
    const release = assembly?.pinned.get(name)
    if (assembly === undefined || release === undefined) return undefined
    const team = (await this.deps.domain.listTeamAggregates(release.scope)).find(candidate => candidate.id === release.teamId)
    const owned = (team?.tasks ?? []).filter(task => task.ownerSessionId === memberSessionId && task.status === 'in_progress')
    const sole = owned.length === 1 ? owned[0] : undefined
    // Record the attempt this real load rode: the attempt-boundary probe
    // holds the body inside THIS attempt and advances at the next one.
    assembly.lastLoad = { taskId: sole?.id, attemptId: sole?.currentAttemptId === undefined ? undefined : String(sole.currentAttemptId) }
    return {
      teamId: release.teamId,
      memberSessionId,
      name,
      version: release.version,
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

  /** The member-scoped registry winner must BE the adopted body (digest): the
   * expected digest is the assembly snapshot when the adoption came from it,
   * else the durable release row. A cold owner cannot be verified, so the
   * answer fails closed. */
  private async assembledDigestMatches(scope: string, teamId: string, adoption: SkillsAdoption): Promise<boolean> {
    const release = adoption.fromAssembly === true
      ? this.memberAssemblies.get(adoption.owner)?.pinned.get(adoption.skillName)
      : this.deps.store.getRelease(scope, teamId, adoption.skillName, adoption.version)
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

  /** Ensure this member's scoped layer carries the bound assembly provider:
   * the exact-Agent scope is minted from the optional-`skills` inject Context
   * (official `createScope`), so both official load paths (`scope: agent`)
   * resolve ONLY this member's pinned body. Lifecycle converges from BOTH the
   * member Agent's own `ctx.effect` and the module close path (each fully
   * disposes the minted scope + provider registration, once). */
  private async assemble(scope: string, teamId: string, memberSessionId: string, memberAgent: Agent, opts: { readonly rebuild?: boolean } = {}): Promise<void> {
    const existing = this.memberAssemblies.get(memberSessionId)
    if (existing !== undefined) {
      const live = existing.control !== undefined && !existing.control.signal.aborted
      if (live && opts.rebuild !== true) {
        // Replay of the SAME pin: refresh the registry view only; the frozen
        // body/attributions of this assembly never move.
        existing.control?.invalidate()
        return
      }
      // Rebuild (a version CHOICE on an unloaded assembly) or a dead effect
      // scope: FULLY converge first (awaited) so two live registrations never
      // coexist, then re-mint from the CURRENT durable pins.
      existing.providerDisposer()
      await existing.disposeScope()
      this.memberAssemblies.delete(memberSessionId)
    }
    const skillsCtx = this.skillsCtx
    if (skillsCtx === undefined) {
      throw new TeamDomainError(`the Skill registry is not provided in this composition; the approved assembly for member ${memberSessionId} cannot be served`, 'SKILLS_REGISTRY_UNAVAILABLE')
    }
    // Freeze the versions ACTUALLY EFFECTIVE for this assembly.
    const pinned = this.collectPinned(scope, teamId, memberSessionId)
    const minted = createScope(skillsCtx, memberAgent)
    let providerDisposer: (() => void) | undefined
    let control: SkillProviderControl | undefined
    const loads = { count: 0 }
    try {
      const skills = minted.ctx.get('skills')
      if (skills === undefined) {
        throw new TeamDomainError(`the Skill registry is not provided in this composition; the approved assembly for member ${memberSessionId} cannot be served`, 'SKILLS_REGISTRY_UNAVAILABLE')
      }
      // `create` runs synchronously inside registerProvider, so `control` is
      // already captured when the assembly is recorded below.
      providerDisposer = skills.registerProvider((received: SkillProviderControl) => {
        control = received
        return buildReleaseProvider(scope, teamId, pinned, loads)
      })
    } catch (error) {
      await minted.dispose()
      throw error
    }
    const assembly: MemberAssembly = { scope, teamId, disposeScope: minted.dispose, providerDisposer, control, loads, lastLoad: undefined, pinned }
    this.memberAssemblies.set(memberSessionId, assembly)
    // Member-side lifecycle: when this Agent's own effect scope unwinds, the
    // assembly converges with it (module-side close stays idempotent).
    memberAgent.ctx.effect(() => async () => {
      if (this.memberAssemblies.get(memberSessionId) === assembly) this.memberAssemblies.delete(memberSessionId)
      assembly.providerDisposer()
      await assembly.disposeScope()
    })
  }

  /** Compact approval receipt (see `releaseView`). */
  private releaseView(record: SkillsReleaseRecord): Record<string, unknown> {
    return releaseView(record)
  }

  /** Compact assignment receipt (see `assignmentView`). */
  private assignmentView(record: { scope: string; teamId: string; memberSessionId: string; name: string; version: string; releaseManifestHash: string; revision: number }, loadedHeld = false): SkillsAssignmentView {
    return assignmentView(record, loadedHeld)
  }
}
