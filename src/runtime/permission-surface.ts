/** Official pre-execute consumer for participant policy and member-to-Captain
 * approvals. The original invocation still passes official downstream guards.
 * This lifecycle also owns the optional human verifier and reviewer Provider. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { isAdjacentAgentSendMessageTool } from '@deepseek-ai/dsh-subagent/internal'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { TeamDomainError } from '../domain/error.js'
import type { HumanInteractionRequest } from '../human/human-interaction-contract.js'
import type { HumanPrincipalVerifier } from './human-provenance.js'
import type { AgentSwarmRuntime } from './orchestrator-runtime.js'
import { CAPTAIN_APPROVAL_TOOL, CaptainToolApproval } from './captain-tool-approval.js'
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
  private readonly toolApproval: CaptainToolApproval
  private humanPrincipalVerifier: HumanPrincipalVerifier | undefined
  private reviewerAgentProvider: ReviewerAgentProvider | undefined
  private unregisterReviewer: (() => void) | undefined

  constructor(private readonly deps: TeamPermissionSurfaceDeps) {
    validateToolPolicyDeclaration(deps.policy)
    this.toolApproval = new CaptainToolApproval(deps.ctx, deps.runtime)
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
    await this.toolApproval.dispose()
    this.humanPrincipalVerifier = undefined
    this.unregisterReviewer?.()
  }

  /** Effective member provisioning deny overlay: explicit policy denials. */
  memberPolicyDenyNames(): readonly string[] {
    return [...(this.deps.policy.deny ?? [])]
  }

  /** Read-only Team overlay. It never runs approval or official execution guards. */
  directoryPolicy(role: 'captain' | 'member', names: readonly string[]) {
    const policy = { allow: [...(this.deps.policy.allow ?? [])], ask: [...(this.deps.policy.ask ?? [])], deny: [...(this.deps.policy.deny ?? [])] }
    return { policy, entries: names.map(name => ({ name, decision: decideToolPermission(policy, name, {
      callerRole: role === 'captain' ? 'captain' : 'delegated-member', sameTurnConcreteToolCall: true,
      openTurn: true, approvalSeamAvailable: this.deps.ctx.get('approval') !== undefined,
    }) })) }
  }

  async decideToolApproval(exec: ToolExecution, requestId: string, decision: 'approve' | 'deny'): Promise<void> {
    await this.toolApproval.decide(exec, requestId, decision)
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
      if (membership === undefined) {
        // Historical/provisioning membership is a denial witness only, never
        // an active authority grant. A child can start its first model turn
        // before active admission commits; it must not bypass the ask gate.
        const known = await this.deps.runtime.domain.findAccountingMembership(scope, agent.id)
        if (known?.role === 'member') {
          throw new TeamDomainError('This Team member is not actively admitted; retry after assignment', 'TEAM_NOT_JOINED')
        }
        return undefined
      }
      return { role: membership.role }
    } catch (error) {
      if (error instanceof TeamDomainError) throw error
      throw new TeamDomainError(
        'Team permission identity resolution failed; failing closed instead of treating the caller as unrelated',
        'TEAM_PERMISSION_RESOLUTION_FAILED',
      )
    }
  }

  /** Only the standard tool's live-child-to-direct-parent route inherits host permission. */
  private isOfficialUpwardMessage(exec: ToolExecution): boolean {
    if (exec.name !== 'send_message' || exec.agent === undefined) return false
    if (this.deps.ctx.agents.get(exec.agent.id) !== exec.agent) return false
    const parentId = exec.agent.session.header.parentSession
    if (parentId === undefined) return false
    const args = exec.arguments as { agent_id?: unknown } | undefined
    return args?.agent_id === parentId
      && isAdjacentAgentSendMessageTool(this.deps.ctx.tools.get('send_message', exec.agent))
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
      if (this.isOfficialUpwardMessage(exec)) return await next()
      const role = await this.resolveTeamRole(exec.agent)
      if (role === undefined) return await next()
      const context = {
        callerRole: role.role === 'captain' ? ('captain' as const) : ('delegated-member' as const),
        // The concrete member gate verifies the official open-turn projection.
        sameTurnConcreteToolCall: true,
        openTurn: true,
        approvalSeamAvailable: this.deps.ctx.get('approval') !== undefined,
      }
      const decision = decideToolPermission(this.deps.policy, exec.name, context)
      const downstream = await next()
      if (decision === 'ask') {
        if (downstream.kind !== 'allow') return downstream
        if (decideToolPermission(this.deps.policy, CAPTAIN_APPROVAL_TOOL, { ...context, callerRole: 'captain' }) === 'deny') {
          return { kind: 'deny', reason: 'Captain tool approval is disabled by the Team tool policy' }
        }
        return await this.toolApproval.request(exec) ? downstream : { kind: 'deny', reason: 'This member tool call did not receive a valid Captain approval' }
      }
      const ours = toPreToolDecision(decision, exec.name)
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
