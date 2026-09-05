/**
 * Continuable member provisioning.
 *
 * One admitted operation at a time: the durable provisioning record commits
 * before the child starts, activation settles at official inbox admission,
 * and every failure path retains ownership until its terminal persistence and
 * child cleanup have either completed or left durable recovery evidence.
 *
 * The persisted-child reconciliation recovery (M1B/F3) also lives here: an
 * interrupted `provisioning` record is reconciled against the durable child
 * facts (official experimental `reconcileProvisioning` template) — exact
 * parent Session, continuable descriptor, matching provider and a durably
 * accepted initial user prompt — and the member is activated or the orphan
 * child is explicitly drained.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { isModelInvocable, type SkillRegistry } from '@deepseek-ai/dsh-skill'
import { injectedSkills } from './injected-skills.js'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { foldSubagentDescriptor, SubagentError, type SubagentListEntry } from '@deepseek-ai/dsh-subagent'
import { TeamDomainError } from '../domain/error.js'
import type { TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import type { TeamId, TeamState, TeamMember, TeamMembership } from '../domain/types.js'
import { normalizeMemberAssignedSkills, type MemberIdentityInput } from '../domain/identity-profile.js'
import { requireAgent, type ToolExecutionAuthority } from './authority.js'
import type { RuntimeConfig } from './orchestrator-runtime.js'
import { memberJoinNotice, memberPersona } from './prompts.js'
import { messageAccepted } from './session-acceptance.js'
import { memberToolDeny } from './tool-policy.js'

const MISMATCH = 'persisted child Session does not match the provisioned continuation'
const INTERRUPTED = 'member provisioning did not commit before runtime recovery'
const RECONCILE_TIMEOUT_MS = 30_000
const STARTUP_SETTLEMENT_RETRY_MS = 25

/** Evidence verdict for one interrupted provisioning record's child. */
type ChildVerdict =
  | { readonly kind: 'activate' }
  | { readonly kind: 'failed'; readonly error: string; readonly drain: boolean }

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type InitialTurn = {
  readonly scope: TeamScope
  readonly teamId: TeamId
  readonly captain: Agent
  readonly childId: SessionId
  readonly finish: () => void
  admitted: boolean
  terminalReason?: string
  settling: boolean
  forceFailure: boolean
  retryTimer?: ReturnType<typeof setTimeout> | undefined
}

/** Captain-owned member creation over one admitted operation slot. */
export class MemberProvisioner {
  private readonly operations = new Set<Promise<void>>()
  private readonly initialTurns = new Map<string, InitialTurn>()
  private projectionsAbsenceWarned = false
  private closing = false

  private readonly skillsOf: () => SkillRegistry | undefined

  constructor(
    private readonly ctx: Context,
    private readonly deps: {
      domain: () => TeamDomainPort
      config: RuntimeConfig
      scopeOf: (agent: Agent) => TeamScope
      trackChild: (captain: Agent, childId: string) => void
      afterActivation: (scope: TeamScope, teamId: TeamId, captain: Agent, childId: SessionId) => Promise<void>
    },
  ) {
    this.skillsOf = injectedSkills(ctx)
  }

  /**
   * Validate one Captain-declared member-assigned Skill subset (issue #184).
   * Structure is normalized in the domain; eligibility against the immutable
   * Team allow-list and the current complete scoped Skill catalog is enforced
   * HERE — before any provisioning record commits.
   */
  private async validateAssignedSkills(captain: Agent, team: TeamState, raw: readonly string[] | undefined, signal: AbortSignal): Promise<string[] | undefined> {
    if (raw === undefined) return undefined
    const names = normalizeMemberAssignedSkills(raw) ?? []
    if (team.allowedSkills !== undefined) {
      const allowed = new Set(team.allowedSkills)
      const outside = names.filter(name => !allowed.has(name))
      if (outside.length > 0) {
        throw new TeamDomainError(
          `member assignedSkills must be a subset of the Team allow-list; outside the allow-list: ${outside.join(', ')}`,
          'TEAM_MEMBER_SKILLS_INVALID',
        )
      }
    }
    const skills = this.skillsOf()
    if (skills === undefined) {
      throw new TeamDomainError('the Skill registry is unavailable in this host; member assignedSkills cannot be validated', 'TEAM_MEMBER_SKILLS_INVALID')
    }
    const snapshot = await skills.snapshot({ cwd: captain.session.header.cwd, signal, scope: captain })
    const catalog = new Map(snapshot.skills.map(skill => [skill.name, skill]))
    const missing = names.filter(name => {
      const skill = catalog.get(name)
      return skill === undefined || !isModelInvocable(skill)
    })
    if (missing.length > 0) {
      throw new TeamDomainError(
        `member assignedSkills must exist in the scoped Skill catalog and be model-invocable; missing or unavailable: ${missing.join(', ')}`,
        'TEAM_MEMBER_SKILLS_INVALID',
      )
    }
    return names
  }

  async addMember(
    exec: ToolExecutionAuthority,
    input: { name: string; role: string; provider?: string; llmProvider?: string; model?: string; denyTools?: readonly string[]; skills?: readonly string[] } & MemberIdentityInput,
  ): Promise<TeamMember> {
    const captain = requireAgent(exec)
    const scope = this.deps.scopeOf(captain)
    const membership = await this.deps.domain().requireMembership(scope, captain.id)
    if (membership.role !== 'captain') throw new TeamDomainError('only the captain can add members', 'TEAM_CAPTAIN_REQUIRED')

      const providerName = input.provider ?? this.deps.config.memberProvider
      const provider = this.ctx.subagents.getProvider(providerName)
      if (provider === undefined) {
        throw new TeamDomainError(
          `subagent provider "${providerName}" is unavailable; registered providers: ${this.ctx.subagents.list().join(', ') || 'none'}`,
          'TEAM_MEMBER_PROVIDER_MISSING',
        )
      }
      if (provider.prepareContinuable === undefined) {
        throw new TeamDomainError(`subagent provider "${providerName}" is not continuable`, 'TEAM_MEMBER_PROVIDER_INCOMPATIBLE')
      }
      // Every member carries the configured delegation-depth cap, so the
      // provider must advertise `depthLimit` (F15): the preflight rejects
      // here — before any provisioning record commits — instead of surfacing
      // late (or silently ignored) at child start.
      if (!provider.capabilities.depthLimit || !provider.capabilities.persona || !provider.capabilities.toolFilter) {
        throw new TeamDomainError(
          `subagent provider "${providerName}" must support depthLimit, persona and toolFilter`,
          'TEAM_MEMBER_PROVIDER_INCOMPATIBLE',
        )
      }
      // The F17 tool-policy declaration is validated and composed BEFORE any
      // provisioning record commits (same preflight discipline as F15): a
      // structurally invalid deny list rejects with no roster side effects.
      // Tool-name EXISTENCE stays with the official creation-window
      // `tools.restrict()` validation, whose failure settles this record
      // failed below — loud either way, never a silently unfiltered member.
      const deny = memberToolDeny([...new Set([
        ...(input.denyTools ?? []),
        ...(this.deps.config.memberToolPolicyDeny ?? []),
      ])])

      const childId = SessionId(randomUUID())
      // Issue #184: a member-assigned Skill subset is validated BEFORE any
      // roster mutation — against the immutable Team allow-list and the
      // current complete scoped Skill catalog (model-invocable). Zero-side-effect
      // rejection, so a bad subset can never leave a provisioning row behind.
      const assignedSkills = await this.validateAssignedSkills(captain, membership.team, input.skills, exec.signal)
      const provisioning = await this.deps.domain().provisionMember(scope, membership.team.id, captain.id, {
        name: input.name,
        role: input.role,
        sessionId: childId,
        provider: providerName,
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        ...(input.profession === undefined ? {} : { profession: input.profession }),
        ...(input.personality === undefined ? {} : { personality: input.personality }),
        ...(input.pixelAvatarSvg === undefined ? {} : { pixelAvatarSvg: input.pixelAvatarSvg }),
        ...(assignedSkills === undefined ? {} : { assignedSkills }),
      })
      this.deps.config.teamSkills.rememberChild(membership.team, childId, assignedSkills)
      let finish!: () => void
      const operation = new Promise<void>(settle => { finish = settle })
      this.operations.add(operation)
      const initial: InitialTurn = {
        scope, teamId: membership.team.id, captain, childId, admitted: false, settling: false, forceFailure: false,
        finish: () => { finish(); this.operations.delete(operation) },
      }
      // Register before the official start call: a fast child can terminally
      // end while `startContinuable` is still resolving.  The observation is
      // held until active admission commits below, never lost or applied to a
      // merely provisioned row.
      this.initialTurns.set(childId, initial)
      try {
        await this.ctx.subagents.startContinuable({
          provider: providerName,
          // Issue #148: the label is the readable identity shown in the official
          // DSH session list. Use the human-readable Captain-declared display
          // name, falling back to the internal immutable member name when the
          // recruiter supplied no displayName. Only affects newly created
          // sessions; stored historical labels are never rewritten.
          label: `${membership.team.name} · ${provisioning.displayName ?? provisioning.name}`,
          childId,
          request: {
            prompt: [{ type: 'text', text: memberJoinNotice(membership.team) }],
            parent: captain,
            persona: memberPersona(membership.team, provisioning.name, provisioning.role, provisioning.assignedSkills, {
              ...(provisioning.displayName === undefined ? {} : { displayName: provisioning.displayName }),
              ...(provisioning.profession === undefined ? {} : { profession: provisioning.profession }),
              ...(provisioning.personality === undefined ? {} : { personality: provisioning.personality }),
            }),
            // M1A static baseline plus the F17 deny-only narrowing declaration
            // (`deny_tools`); the union is monotone — captain-only tools stay
            // mandatorily denied and no allow surface exists.
            toolFilter: { deny },
            // `agentOptions.provider` is the member's LLM provider (recorded
            // in the durable subagent descriptor as `agentProvider`), distinct
            // from the continuable runtime `provider` passed to
            // `startContinuable` above. An explicit per-member `llm_provider`
            // wins; otherwise the member inherits the captain's LLM provider
            // (existing behavior).
            agentOptions: {
              ...((input.llmProvider ?? this.deps.config.memberLlmProvider) !== undefined
                ? { provider: input.llmProvider ?? this.deps.config.memberLlmProvider }
                : (captain.options.provider === undefined ? {} : { provider: captain.options.provider })),
              ...(input.model ?? this.deps.config.memberModel ?? captain.options.model) === undefined
                ? {}
                : { model: input.model ?? this.deps.config.memberModel ?? captain.options.model },
            },
            // Official maxDepth is absolute. A dedicated Captain is one
            // level below the main Chat, while a legacy Captain is the root.
            maxDepth: this.deps.config.memberMaxDepth + (captain.session.header.parentSession === undefined ? 0 : 1),
          },
          signal: exec.signal,
        })
      } catch (error) {
        this.initialTurns.delete(childId)
        await this.deps.domain().settleMember(scope, membership.team.id, childId, {
          active: false,
          error: error instanceof Error ? error.message : String(error),
        })
        initial.finish()
        throw error
      }

      // Inbox admission means the child is real and may receive Team work, so
      // retain the long-standing active admission contract.  The initial
      // terminal edge remains independently tracked: an actual error
      // atomically demotes this same row to failed instead of leaving the
      // descriptor/runtime/Team projections falsely active.
      let active: TeamMember
      try {
        active = await this.deps.domain().settleMember(scope, membership.team.id, childId, { active: true })
      } catch (activationError) {
        this.initialTurns.delete(childId)
        try {
          await this.deps.domain().settleMember(scope, membership.team.id, childId, {
            active: false,
            error: `member activation did not commit: ${describe(activationError)}`,
          })
        } catch (settleError) {
          // Keep this operation open: the durable provisioning row plus the
          // original activation error are recovery evidence. The runtime's
          // bounded disposer owns the remaining child drain; releasing now
          // would make a failed terminal commit indistinguishable from a
          // cleanly settled child.
          this.deps.trackChild(captain, childId)
          this.ctx.logger.warn(`agent-swarm: failed to settle uncommitted child ${childId}: ${String(settleError)}`)
          throw activationError
        }
        try {
          let drained = false
          await this.ctx.subagents.drainContinuableChildren(captain, [childId]).then(() => { drained = true }).catch(drainError => {
            this.ctx.logger.warn(`agent-swarm: failed to drain uncommitted child ${childId}: ${String(drainError)}`)
          })
          if (!drained) this.deps.trackChild(captain, childId)
        } finally {
          // The fallback failed commit succeeded and the child drain was
          // awaited (or transferred to the runtime owner) before this
          // operation can let disposal finish.
          initial.finish()
        }
        throw activationError
      }
      this.deps.trackChild(captain, childId)
      try {
        await this.deps.afterActivation(scope, membership.team.id, captain, childId)
      } catch (activationError) {
        this.ctx.logger.warn(`agent-swarm: post-activation accounting failed for ${childId} (member stays active; usage refolds on recovery): ${String(activationError)}`)
      }
      initial.admitted = true
      this.settleObservedInitialTurn(initial)
      return active
  }

  observeSessionEvent(session: Session, event: SessionEvent): void {
    const pending = this.initialTurns.get(session.id)
    if (pending === undefined || event.type !== 'turn/end') return
    pending.terminalReason = event.data.reason.kind
    this.settleObservedInitialTurn(pending)
  }

  private settleObservedInitialTurn(pending: InitialTurn): void {
    if (!pending.admitted || pending.terminalReason === undefined || pending.settling) return
    if (this.initialTurns.get(pending.childId) !== pending) return
    pending.settling = true
    void this.settleInitialTurn(pending, pending.terminalReason, pending.forceFailure)
  }

  private async settleInitialTurn(
    pending: InitialTurn,
    reason: string,
    forceFailure = false,
  ): Promise<void> {
    try {
      // A child can be deliberately interrupted/drained and later
      // cold-resumed; that lifecycle outcome is not evidence that startup
      // failed.  Only an actual initial-turn error demotes an admitted member.
      // Runtime disposal is the exception: it force-settles its own admitted
      // operation so a reload cannot revive a row it was closing.
      if (reason !== 'error' && !forceFailure) {
        this.completeInitialTurn(pending)
        return
      }
      await this.deps.domain().settleMember(pending.scope, pending.teamId, pending.childId, {
        active: false,
        error: `member initial turn ended ${reason} before it finished`,
      })
      this.completeInitialTurn(pending)
    } catch (error) {
      if (error instanceof TeamDomainError && ['TEAM_MEMBER_PHASE_INVALID', 'TEAM_MEMBER_NOT_FOUND'].includes(error.code)) this.completeInitialTurn(pending)
      else {
        this.ctx.logger.warn(`agent-swarm: failed to settle initial member turn ${pending.childId}: ${String(error)}`)
        this.retryInitialTurnSettlement(pending)
      }
    } finally {
      pending.settling = false
    }
  }

  private completeInitialTurn(pending: InitialTurn): void {
    if (this.initialTurns.get(pending.childId) === pending) this.initialTurns.delete(pending.childId)
    if (pending.retryTimer !== undefined) clearTimeout(pending.retryTimer)
    pending.finish()
  }

  private retryInitialTurnSettlement(pending: InitialTurn): void {
    if (this.closing || pending.retryTimer !== undefined || this.initialTurns.get(pending.childId) !== pending) return
    pending.retryTimer = setTimeout(() => {
      pending.retryTimer = undefined
      this.settleObservedInitialTurn(pending)
    }, STARTUP_SETTLEMENT_RETRY_MS)
  }

  /** Wait for every admitted provisioning operation (disposal path). */
  wait(): Promise<Array<PromiseSettledResult<void>>> {
    return Promise.allSettled(this.operations)
  }

  dispose(): void {
    this.closing = true
    for (const pending of this.initialTurns.values()) {
      // Runtime shutdown is a terminal edge for an admitted operation.  Route
      // it through the same durable failure settlement before `wait()` lets the
      // orchestrator close the aggregate, so an in-flight child can never be
      // revived as an apparently active member after reload.
      // A provider still blocked in `startContinuable` has no admitted child
      // to settle. Keep its operation pending so the runtime's bounded
      // disposal reports the configured timeout and leaves durable recovery
      // evidence, rather than claiming a clean shutdown.
      if (!pending.admitted) continue
      if (pending.retryTimer !== undefined) clearTimeout(pending.retryTimer)
      pending.forceFailure = true
      pending.terminalReason ??= 'aborted'
      this.settleObservedInitialTurn(pending)
    }
  }

  /**
   * Reconcile every interrupted `provisioning` record of one recovering
   * captain against the durable child facts (M1B/F3, official
   * `reconcileProvisioning` template): a child whose persisted Session proves
   * the exact parent, a continuable descriptor, the provisioned provider and
   * a durably accepted initial user prompt is activated back into the roster
   * (orphan eliminated); a provable mismatch settles the record failed and
   * explicitly drains the orphan child; evidence that cannot be verified
   * keeps the pre-F3 failed settlement. A live child is left to its creator —
   * the in-process operation still owns its terminal member edge.
   *
   * The domain stays the settlement authority (`settleMember`'s guarded
   * transaction); this collaborator only collects evidence and performs the
   * child lifecycle actions. If the pass itself fails unexpectedly, the
   * remaining records fall back to the pre-F3 bulk settlement.
   *
   * @returns how many records were settled (activated or failed).
   */
  async recoverInterrupted(captain: Agent, scope: TeamScope, membership: TeamMembership): Promise<number> {
    let settled = await this.recoverObservedStartupFailures(scope, membership)
    const interrupted = membership.team.members.filter(member => member.phase === 'provisioning')
    if (interrupted.length === 0) return settled
    let activated = 0
    try {
      for (const member of interrupted) {
        if (this.ctx.agents.get(SessionId(member.sessionId)) !== undefined) continue
        const verdict = await this.childVerdict(captain, member)
        const outcome = verdict.kind === 'activate' ? { active: true } as const : { active: false, error: verdict.error } as const
        try {
          await this.deps.domain().settleMember(scope, membership.team.id, member.sessionId, outcome)
        } catch (error) {
          if (error instanceof TeamDomainError && ['TEAM_MEMBER_PHASE_INVALID', 'TEAM_MEMBER_NOT_FOUND'].includes(error.code)) {
            continue
          }
          throw error
        }
        settled += 1
        if (verdict.kind === 'activate') {
          activated += 1
          this.deps.trackChild(captain, member.sessionId)
        } else if (verdict.drain) {
          await this.ctx.subagents.drainContinuableChildren(captain, [SessionId(member.sessionId)]).catch(error => {
            this.ctx.logger.warn(`agent-swarm: failed to drain mismatched provisioning child ${member.sessionId}: ${String(error)}`)
          })
        }
      }
    } catch (error) {
      const recovered = await this.deps.domain().recoverProvisioningMembers(
        scope,
        membership.team.id,
        captain.id,
        `${INTERRUPTED} (reconciliation failed: ${describe(error)})`,
      )
      settled += recovered.length
    }
    if (settled > 0) {
      this.ctx.logger.warn(
        `agent-swarm: reconciled ${settled} interrupted member provisioning record(s) for ${membership.team.id} (${activated} activated)`,
      )
    }
    return settled
  }

  private async recoverObservedStartupFailures(scope: TeamScope, membership: TeamMembership): Promise<number> {
    let settled = 0
    for (const member of membership.team.members) {
      if (member.phase !== 'active') continue
      try {
        const stored = await this.ctx.sessionPersistence.inspect(SessionId(member.sessionId), AbortSignal.timeout(RECONCILE_TIMEOUT_MS))
        const firstEnd = stored.events.find(event => event.type === 'turn/end')
        if (firstEnd?.data.reason.kind !== 'error') continue
        // A restart owns no live child turn here. The existing Session log is
        // the durable error evidence, so retrying this guarded transition is
        // idempotent and performs no LLM/resume action before the projection
        // can track the member as active. A transient first write failure gets
        // one immediate recovery retry; later reloads repeat the same safe
        // reconciliation rather than inventing another state authority.
        let committed = false
        for (let attempt = 0; attempt < 2 && !committed; attempt += 1) {
          try {
            await this.deps.domain().settleMember(scope, membership.team.id, member.sessionId, {
              active: false,
              error: 'member initial turn ended error before it finished',
            })
            committed = true
            settled += 1
          } catch (error) {
            if (error instanceof TeamDomainError && ['TEAM_MEMBER_PHASE_INVALID', 'TEAM_MEMBER_NOT_FOUND'].includes(error.code)) break
            if (attempt === 1) throw error
          }
        }
      } catch (error) {
        if (!(error instanceof TeamDomainError && ['TEAM_MEMBER_PHASE_INVALID', 'TEAM_MEMBER_NOT_FOUND'].includes(error.code))) {
          this.ctx.logger.warn(`agent-swarm: startup failure recovery deferred for ${member.sessionId}: ${String(error)}`)
        }
      }
    }
    return settled
  }

  /**
   * Collect one provisioning record's child evidence: the live-preferred
   * child enumeration proves durable existence and mode, then one persisted
   * inspection proves the exact parent Session, the descriptor provider and
   * the durably accepted initial user prompt (the official four factors).
   *
   * The enumeration is the enrichment rung, not the official baseline: the
   * official template reconciles from the persisted inspection alone, so a
   * composition without the optional `sessionProjections` registry (loading
   * `@deepseek-ai/dsh-session-projection`) keeps full reconciliation over
   * the inspect-only path, with one logged warning.
   */
  private async childVerdict(captain: Agent, member: TeamMember): Promise<ChildVerdict> {
    let entry: SubagentListEntry | undefined
    let enumerationAbsent = false
    try {
      const children = await this.ctx.subagents.listChildren(SessionId(captain.id), AbortSignal.timeout(RECONCILE_TIMEOUT_MS))
      entry = children.find(candidate => candidate.id === SessionId(member.sessionId))
    } catch (error) {
      if (!(error instanceof SubagentError && error.code === 'SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE')) {
        return { kind: 'failed', error: `${INTERRUPTED}: reconciliation could not verify the persisted child (child enumeration failed: ${describe(error)})`, drain: false }
      }
      enumerationAbsent = true
      if (!this.projectionsAbsenceWarned) {
        this.projectionsAbsenceWarned = true
        this.ctx.logger.warn('agent-swarm: provisioning reconciliation falls back to persisted inspection only (sessionProjections registry absent)')
      }
    }
    if (entry === undefined && !enumerationAbsent) {
      return { kind: 'failed', error: `${INTERRUPTED}: provisioning did not leave a resumable child Session`, drain: false }
    }
    if (entry?.kind === 'diagnostic') {
      return entry.reason === 'corrupt'
        ? { kind: 'failed', error: `${INTERRUPTED}: ${MISMATCH} (subagent descriptor fold was corrupt)`, drain: true }
        : { kind: 'failed', error: `${INTERRUPTED}: reconciliation could not verify the persisted child (child enumeration reported "${entry.reason}")`, drain: false }
    }
    if (entry?.mode !== undefined && entry.mode !== 'continuable') {
      return { kind: 'failed', error: `${INTERRUPTED}: ${MISMATCH} (durable mode "${entry.mode}" is not continuable)`, drain: true }
    }
    let stored: Awaited<ReturnType<Context['sessionPersistence']['inspect']>>
    try {
      stored = await this.ctx.sessionPersistence.inspect(SessionId(member.sessionId), AbortSignal.timeout(RECONCILE_TIMEOUT_MS))
    } catch (error) {
      return { kind: 'failed', error: `${INTERRUPTED}: reconciliation could not verify the persisted child (child Session recovery failed: ${describe(error)})`, drain: false }
    }
    const suffix = stored.events.slice(stored.meta.seedLength ?? 0)
    if (stored.meta.parentSession !== captain.id) {
      return { kind: 'failed', error: `${INTERRUPTED}: ${MISMATCH} (parent session does not match the recovering captain)`, drain: true }
    }
    let descriptor: ReturnType<typeof foldSubagentDescriptor>
    try {
      descriptor = foldSubagentDescriptor(suffix)
    } catch (error) {
      return { kind: 'failed', error: `${INTERRUPTED}: ${MISMATCH} (persisted subagent descriptor is damaged: ${describe(error)})`, drain: true }
    }
    if (descriptor?.mode !== 'continuable') {
      return { kind: 'failed', error: `${INTERRUPTED}: ${MISMATCH} (no supported continuable subagent descriptor)`, drain: true }
    }
    if (descriptor.provider !== member.provider) {
      return { kind: 'failed', error: `${INTERRUPTED}: ${MISMATCH} (child provider "${descriptor.provider}" is not the provisioned provider "${member.provider}")`, drain: true }
    }
    if (!messageAccepted(suffix, message => message.source.kind === 'user')) {
      return { kind: 'failed', error: `${INTERRUPTED}: ${MISMATCH} (no initial user prompt was durably accepted)`, drain: true }
    }
    return { kind: 'activate' }
  }
}
