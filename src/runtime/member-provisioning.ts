/**
 * Continuable member provisioning.
 *
 * One admitted operation at a time: the durable provisioning record commits
 * before the child starts, activation settles only after `startContinuable`
 * accepted, and every failure path settles the record failed and drains the
 * uncommitted child.
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
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { foldSubagentDescriptor, SubagentError, type SubagentListEntry } from '@deepseek-ai/dsh-subagent'
import { TeamDomainError } from '../domain/error.js'
import type { TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import type { TeamId, TeamMember, TeamMembership } from '../domain/types.js'
import { requireAgent, type ToolExecutionAuthority } from './authority.js'
import type { RuntimeConfig } from './orchestrator-runtime.js'
import { memberJoinNotice, memberPersona } from './prompts.js'
import { messageAccepted } from './session-acceptance.js'
import { memberToolDeny } from './tool-policy.js'

const MISMATCH = 'persisted child Session does not match the provisioned continuation'
const INTERRUPTED = 'member provisioning did not commit before runtime recovery'
const RECONCILE_TIMEOUT_MS = 30_000

/** Evidence verdict for one interrupted provisioning record's child. */
type ChildVerdict =
  | { readonly kind: 'activate' }
  | { readonly kind: 'failed'; readonly error: string; readonly drain: boolean }

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Captain-owned member creation over one admitted operation slot. */
export class MemberProvisioner {
  private readonly operations = new Set<Promise<void>>()
  private projectionsAbsenceWarned = false

  constructor(
    private readonly ctx: Context,
    private readonly deps: {
      domain: () => TeamDomainPort
      config: RuntimeConfig
      scopeOf: (agent: Agent) => TeamScope
      trackChild: (captain: Agent, childId: string) => void
      afterActivation: (scope: TeamScope, teamId: TeamId, captain: Agent, childId: SessionId) => Promise<void>
    },
  ) {}

  async addMember(
    exec: ToolExecutionAuthority,
    input: {
      name: string; role: string; provider?: string; llmProvider?: string; model?: string
      denyTools?: readonly string[]; skills?: readonly string[]
    },
  ): Promise<TeamMember> {
    let completeOperation!: () => void
    const operation = new Promise<void>(settle => { completeOperation = settle })
    this.operations.add(operation)
    try {
      const captain = requireAgent(exec)
      const scope = this.deps.scopeOf(captain)
      const membership = await this.deps.domain().requireMembership(scope, captain.id)
      if (membership.role !== 'captain') throw new TeamDomainError('only the captain can add members', 'TEAM_CAPTAIN_REQUIRED')

      const live = this.deps.config.currentSettings()
      const providerName = input.provider ?? live.memberProvider ?? this.deps.config.memberProvider
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
        ...(input.denyTools ?? live.memberDenyTools ?? []),
        ...(this.deps.config.memberToolPolicyDeny ?? []),
      ])])
      const assignedSkills = [...new Set(input.skills ?? live.memberSkills ?? [])]
      for (const name of assignedSkills) {
        if (name.length > 128 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) {
          throw new TeamDomainError(`invalid Skill name "${name}"`, 'TEAM_INPUT_INVALID')
        }
      }
      if (assignedSkills.length > 32) throw new TeamDomainError('at most 32 Skills may be assigned to one member', 'TEAM_INPUT_INVALID')
      if (assignedSkills.length > 0) {
        const skills = this.ctx.get('skills')
        if (skills === undefined) throw new TeamDomainError('official DSH Skill Registry is unavailable', 'TEAM_INPUT_INVALID')
        const available = new Set((await skills.list({
          cwd: captain.session.header.cwd,
          scope: captain,
          signal: exec.signal,
        })).map(skill => skill.name))
        const missing = assignedSkills.filter(name => !available.has(name))
        if (missing.length > 0) throw new TeamDomainError(`assigned Skills are unavailable: ${missing.join(', ')}`, 'TEAM_INPUT_INVALID')
      }

      const llmProvider = input.llmProvider ?? live.memberLlmProvider ?? captain.options.provider
      const model = input.model ?? live.memberModel ?? this.deps.config.memberModel ?? captain.options.model
      const modelSource = input.llmProvider !== undefined || input.model !== undefined
        ? 'explicit' as const
        : live.memberLlmProvider !== undefined || live.memberModel !== undefined || this.deps.config.memberModel !== undefined
          ? 'member-default' as const
          : captain.options.provider !== undefined || captain.options.model !== undefined
            ? 'captain-inherited' as const
            : 'unresolved' as const

      if ((llmProvider === undefined) !== (model === undefined)) {
        throw new TeamDomainError(
          'member LLM selection must resolve both a Provider and model before provisioning',
          'TEAM_MEMBER_MODEL_INVALID',
        )
      }
      if (llmProvider !== undefined && model !== undefined) {
        const llm = this.ctx.get('llm')
        if (llm === undefined) {
          throw new TeamDomainError('official DSH LLM registry is unavailable', 'TEAM_MEMBER_MODEL_INVALID')
        }
        try {
          await llm.resolveModelInfo(llmProvider, model, exec.signal)
        } catch (cause) {
          throw new TeamDomainError(
            `member LLM route ${JSON.stringify(llmProvider)}/${JSON.stringify(model)} is unavailable`,
            'TEAM_MEMBER_MODEL_INVALID',
            { cause },
          )
        }
      }

      const childId = SessionId(randomUUID())
      const provisioning = await this.deps.domain().provisionMember(scope, membership.team.id, captain.id, {
        name: input.name,
        role: input.role,
        sessionId: childId,
        provider: providerName,
        ...(llmProvider === undefined ? {} : { llmProvider }),
        ...(model === undefined ? {} : { model }),
        modelSource,
        deniedTools: deny,
        assignedSkills,
      })
      try {
        await this.ctx.subagents.startContinuable({
          provider: providerName,
          label: `agent-swarm:${membership.team.id}:${provisioning.name}`,
          childId,
          request: {
            prompt: [{ type: 'text', text: memberJoinNotice(membership.team) }],
            parent: captain,
            persona: memberPersona(membership.team, provisioning.name, provisioning.role, assignedSkills),
            // M1A static baseline plus the F17 deny-only narrowing declaration
            // (`deny_tools`); the union is monotone — captain-only tools stay
            // mandatorily denied and no allow surface exists.
            toolFilter: { deny },
            agentOptions: {
              ...(llmProvider === undefined ? {} : { provider: llmProvider }),
              ...(model === undefined ? {} : { model }),
            },
            maxDepth: this.deps.config.memberMaxDepth,
          },
          signal: exec.signal,
        })
      } catch (error) {
        await this.deps.domain().settleMember(scope, membership.team.id, childId, {
          active: false,
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }

      try {
        const active = await this.deps.domain().settleMember(scope, membership.team.id, childId, { active: true })
        this.deps.trackChild(captain, childId)
        try {
          await this.deps.afterActivation(scope, membership.team.id, captain, childId)
        } catch (activationError) {
          // Post-activation accounting is cursor-based and refolds through
          // the recovery path, so a failure AFTER the durable active
          // settlement must not roll the member back (issue #47: the
          // compensating settle would only fail with TEAM_MEMBER_PHASE_INVALID,
          // drain a live member and poison the name for retries under the
          // lifetime-occupation rule). Degrade to a warning: the roster's
          // active settlement is authoritative.
          this.ctx.logger.warn(
            `agent-swarm: post-activation accounting failed for ${childId} (member stays active; usage refolds on recovery): ${String(activationError)}`,
          )
        }
        return active
      } catch (error) {
        await this.deps.domain().settleMember(scope, membership.team.id, childId, {
          active: false,
          error: `member activation did not commit: ${error instanceof Error ? error.message : String(error)}`,
        }).catch(settleError => {
          this.ctx.logger.warn(`agent-swarm: failed to settle uncommitted child ${childId}: ${String(settleError)}`)
        })
        let drained = false
        await this.ctx.subagents.drainContinuableChildren(captain, [childId]).then(() => {
          drained = true
        }).catch(drainError => {
          this.ctx.logger.warn(`agent-swarm: failed to drain uncommitted child ${childId}: ${String(drainError)}`)
        })
        if (!drained) this.deps.trackChild(captain, childId)
        throw error
      }
    } finally {
      completeOperation()
      this.operations.delete(operation)
    }
  }

  /** Wait for every admitted provisioning operation (disposal path). */
  wait(): Promise<Array<PromiseSettledResult<void>>> {
    return Promise.allSettled(this.operations)
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
    const interrupted = membership.team.members.filter(member => member.phase === 'provisioning')
    if (interrupted.length === 0) return 0
    let settled = 0
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
