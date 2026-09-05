/**
 * SW-I1a permission surface.
 *
 * The tiered allow/ask/deny decision model is mounted on the OFFICIAL
 * `tools/pre-execute` waterfall, not on a private approval store. The
 * listener first resolves the caller as an exact live root captain or an
 * active delegated member of one of this plugin's Teams; unrelated agents
 * simply pass through `next()` untouched. For Team participants the
 * project-owned decision (deny > ask > allow; unlisted tools inherit the
 * official downstream decision) is
 * merged monotonically with whatever downstream `next()` and the official
 * monotonic guard stage decide, so a later guard can still deny but nothing
 * can widen an `ask`/`deny` back to allow.
 *
 * This surface also owns two optional host capabilities:
 *  - `HumanPrincipalVerifier` (host-only; no Agent-mintable attestation
 *    marker; missing/false/throwing verifier all fail closed through the
 *    SW-I1a `HumanControlGateway.verifyHumanPrincipal` wiring);
 *  - `ReviewerAgentProvider` (evidence-only; the `reviewer-agent` review
 *    Provider consumes it and only the existing review transaction may
 *    commit a Team mutation).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { TeamDomainError } from '../domain/error.js'
import type { HumanInteractionRequest } from '../human/human-interaction-contract.js'
import type { HumanPrincipalVerifier } from './human-provenance.js'
import type { AgentSwarmRuntime } from './orchestrator-runtime.js'
import {
  decideToolPermission,
  DEFAULT_TOOL_POLICY,
  mergeToolPolicy,
  toPreToolDecision,
  validateToolPolicyDeclaration,
  type ToolPolicyDeclaration,
} from './permission-policy.js'
import { reviewerAgentReviewProvider, type ReviewerAgentProvider } from './reviewer-boundary.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** SW-I1a host verifier/reviewer-agent registration + policy pipeline. */
    agentSwarmPermission: TeamPermissionSurface
  }
}

const PRE_TOOL_RANK: Record<PreToolDecision['kind'], number> = { allow: 0, ask: 1, deny: 2 }

/** Monotone merge of two official `PreToolDecision`s: deny > ask > allow. */
export function mergePreToolDecision(left: PreToolDecision, right: PreToolDecision): PreToolDecision {
  return PRE_TOOL_RANK[left.kind] >= PRE_TOOL_RANK[right.kind] ? left : right
}

export interface TeamPermissionSurfaceDeps {
  readonly ctx: Context
  readonly runtime: AgentSwarmRuntime
  /** The EFFECTIVE policy: default plugin-tool allow merged with operator tiers. */
  readonly policy: ToolPolicyDeclaration
}

export class TeamPermissionSurface {
  private humanPrincipalVerifier: HumanPrincipalVerifier | undefined
  private reviewerAgentProvider: ReviewerAgentProvider | undefined
  private unregisterReviewer: (() => void) | undefined

  constructor(private readonly deps: TeamPermissionSurfaceDeps) {
    validateToolPolicyDeclaration(deps.policy)
  }

  /** Optional host-only principal verifier; only one may be mounted. */
  registerHumanPrincipalVerifier(verifier: HumanPrincipalVerifier): () => void {
    if (verifier.kind !== 'human-principal-verifier' || verifier.name.trim() === '') {
      throw new TeamDomainError('human principal verifier must be a named human-principal-verifier', 'TEAM_INVALID_CONFIG')
    }
    if (this.humanPrincipalVerifier !== undefined) {
      throw new TeamDomainError('a human principal verifier is already registered', 'TEAM_PROVIDER_DUPLICATE')
    }
    this.humanPrincipalVerifier = verifier
    return () => { if (this.humanPrincipalVerifier === verifier) this.humanPrincipalVerifier = undefined }
  }

  /** Optional evidence-only Reviewer Agent Provider; only one may be mounted. */
  registerReviewerAgentProvider(provider: ReviewerAgentProvider): () => void {
    if (provider.kind !== 'reviewer-agent' || provider.name.trim() === '') {
      throw new TeamDomainError('reviewer agent provider must be a named reviewer-agent', 'TEAM_INVALID_CONFIG')
    }
    if (this.reviewerAgentProvider !== undefined) {
      throw new TeamDomainError('a reviewer agent provider is already registered', 'TEAM_PROVIDER_DUPLICATE')
    }
    const unregister = this.deps.runtime.registerReviewProvider('reviewer-agent', reviewerAgentReviewProvider(() => this.reviewerAgentProvider))
    this.reviewerAgentProvider = provider
    const dispose = () => {
      if (this.unregisterReviewer !== dispose) return
      unregister()
      this.reviewerAgentProvider = undefined
      this.unregisterReviewer = undefined
    }
    this.unregisterReviewer = dispose
    return dispose
  }

  get reviewerAgent(): ReviewerAgentProvider | undefined {
    return this.reviewerAgentProvider
  }

  /** Clear host registrations; idempotent and awaits no async work today. */
  async dispose(): Promise<void> {
    this.humanPrincipalVerifier = undefined
    this.unregisterReviewer?.()
  }

  /** Effective member provisioning deny overlay: policy `ask` + `deny` names. */
  memberPolicyDenyNames(): readonly string[] {
    return [...(this.deps.policy.ask ?? []), ...(this.deps.policy.deny ?? [])]
  }

  /**
   * Resolve the exact live caller role inside this plugin's Teams.
   * Truly unrelated agents (no membership) pass through untouched. A
   * domain/storage failure is NOT treated as unrelated: it fails loud so an
   * authority-resolution problem can never widen an unrelated call path.
   */
  async resolveTeamRole(agent: Agent | undefined): Promise<{ role: 'captain' | 'member' } | undefined> {
    if (agent === undefined) return undefined
    const live = this.deps.ctx.agents.get(agent.id)
    if (live !== agent) return undefined
    const scope = this.deps.runtime.scopeOf(agent)
    try {
      const membership = await this.deps.runtime.domain.findMembership(scope, agent.id)
      if (membership === undefined) return undefined
      return { role: membership.role }
    } catch (error) {
      if (error instanceof TeamDomainError) throw error
      throw new TeamDomainError(
        'Team permission identity resolution failed; failing closed instead of treating the caller as unrelated',
        'TEAM_PERMISSION_RESOLUTION_FAILED',
      )
    }
  }

  /**
   * The official report tool is child-scoped Host transport, not a Team
   * mutation. Detect it before membership lookup: a continuable child may be
   * both a parent-Team member and the captain of a sub-Team, which deliberately
   * makes the Team lookup ambiguous. The identity and scope checks keep a
   * global/root `report` under the normal deny policy; `next()` preserves all
   * official guards for the verified child capability.
   */
  private isScopedChildReport(exec: ToolExecution): boolean {
    if (exec.name !== 'report' || exec.agent === undefined) return false
    if (this.deps.ctx.agents.get(exec.agent.id) !== exec.agent) return false
    if (exec.agent.session.header.parentSession === undefined) return false
    const scoped = this.deps.ctx.tools.get('report', exec.agent)
    return scoped !== undefined && scoped !== this.deps.ctx.tools.get('report')
  }

  /**
   * The SW-I1a gateway's verifier seam: missing verifier, false result and
   * throwing verifier all resolve to `false`, which the gateway reports as
   * `TEAM_INTERACTION_NO_PRINCIPAL`. Only a real `true` admits
   * `authenticated-human`.
   */
  async verifyHumanPrincipal(principalRef: string, request: HumanInteractionRequest): Promise<boolean> {
    const verifier = this.humanPrincipalVerifier
    if (verifier === undefined) return false
    try {
      return (await verifier.verify(principalRef, request)) === true
    } catch {
      return false
    }
  }

  /**
   * Mount the official pre-execute consumer. Returns the exact Cordis
   * disposer; the caller wraps it in `ctx.effect`.
   */
  attachPreExecute(ctx: Context): () => void {
    return ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>) => {
      if (this.isScopedChildReport(exec)) return await next()
      const role = await this.resolveTeamRole(exec.agent)
      if (role === undefined) return await next()
      const context = {
        callerRole: role.role === 'captain' ? ('captain' as const) : ('delegated-member' as const),
        // pre-execute only runs for a concrete tool call inside the current
        // turn; the official ApprovalService additionally enforces the open
        // turn and audit pair before any grant.
        sameTurnConcreteToolCall: true,
        openTurn: true,
        approvalSeamAvailable: this.deps.ctx.get('approval') !== undefined,
      }
      const ours = toPreToolDecision(decideToolPermission(this.deps.policy, exec.name, context), exec.name)
      const downstream = await next()
      return mergePreToolDecision(ours, downstream)
    })
  }
}

/** Build the effective policy: default plugin-tool allow merged with operator tiers. */
export function effectiveToolPolicy(operator?: ToolPolicyDeclaration): ToolPolicyDeclaration {
  return mergeToolPolicy(DEFAULT_TOOL_POLICY, operator ?? {})
}

/** Re-export the declaration type for Config consumers. */
export type { ToolPolicyDeclaration } from './permission-policy.js'
