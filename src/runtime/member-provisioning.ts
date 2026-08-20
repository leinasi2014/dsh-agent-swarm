/**
 * Continuable member provisioning.
 *
 * One admitted operation at a time: the durable provisioning record commits
 * before the child starts, activation settles only after `startContinuable`
 * accepted, and every failure path settles the record failed and drains the
 * uncommitted child. The persisted-child reconciliation recovery (M1B/F3)
 * lands here.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TeamDomainError } from '../domain/error.js'
import type { TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import type { TeamId, TeamMember } from '../domain/types.js'
import { requireAgent, type ToolExecutionAuthority } from './authority.js'
import type { RuntimeConfig } from './orchestrator-runtime.js'
import { CAPTAIN_ONLY_TOOLS, memberPersona } from './prompts.js'

/** Captain-owned member creation over one admitted operation slot. */
export class MemberProvisioner {
  private readonly operations = new Set<Promise<void>>()

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
    input: { name: string; role: string; provider?: string; model?: string },
  ): Promise<TeamMember> {
    let completeOperation!: () => void
    const operation = new Promise<void>(settle => { completeOperation = settle })
    this.operations.add(operation)
    try {
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
      if (!provider.capabilities.persona || !provider.capabilities.toolFilter) {
        throw new TeamDomainError(
          `subagent provider "${providerName}" must support persona and toolFilter`,
          'TEAM_MEMBER_PROVIDER_INCOMPATIBLE',
        )
      }

      const childId = SessionId(randomUUID())
      const provisioning = await this.deps.domain().provisionMember(scope, membership.team.id, captain.id, {
        name: input.name,
        role: input.role,
        sessionId: childId,
        provider: providerName,
      })
      try {
        await this.ctx.subagents.startContinuable({
          provider: providerName,
          label: `agent-swarm:${membership.team.id}:${provisioning.name}`,
          childId,
          request: {
            prompt: [{ type: 'text', text: `You joined Team "${membership.team.name}". Wait for a task assignment.` }],
            parent: captain,
            persona: memberPersona(membership.team, provisioning.name, provisioning.role),
            toolFilter: { deny: [...CAPTAIN_ONLY_TOOLS] },
            agentOptions: {
              ...(captain.options.provider === undefined ? {} : { provider: captain.options.provider }),
              ...(input.model ?? this.deps.config.memberModel ?? captain.options.model) === undefined
                ? {}
                : { model: input.model ?? this.deps.config.memberModel ?? captain.options.model },
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
        await this.deps.afterActivation(scope, membership.team.id, captain, childId)
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
}
