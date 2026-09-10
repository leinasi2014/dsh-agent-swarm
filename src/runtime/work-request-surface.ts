/** Agent-backed work-request operations; the Team Domain owns every durable change. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TeamId, type TeamState } from '../domain/types.js'
import { TeamDomainError } from '../domain/error.js'
import type { TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import type { ResolveWorkRequestInput } from '../domain/work-request.js'
import { publicManagedParent } from '../domain/public-message.js'
import type { SubmitWorkRequestInput } from '../shared/work-request.js'
import { requireAgent, type ToolExecutionAuthority } from './authority.js'
import { publicAppendEligibility } from './public-lineage.js'

export class WorkRequestSurface {
  constructor(private readonly ctx: Context, private readonly deps: {
    ready(): Promise<void>; assertOpen(): void; domain(): TeamDomainPort
    scopeOf(agent: Agent): TeamScope; teams(scope: TeamScope): Promise<TeamState[]>
    fence<T>(scope: TeamScope, teamId: TeamId, signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T>
    kick(scope: TeamScope, teamId: TeamId): void
    schedule(scope: TeamScope, teamId: TeamId, captain: Agent): void
  }) {}

  private exact(exec: ToolExecutionAuthority, agent: Agent, scope: TeamScope): void {
    this.deps.assertOpen(); exec.signal.throwIfAborted()
    if (this.ctx.agents.get(agent.id) !== agent || this.ctx.sessions.get(agent.id) !== agent.session
      || this.deps.scopeOf(agent) !== scope) {
      throw new TeamDomainError('Work requests require the exact live executing Session', 'TEAM_AGENT_REQUIRED')
    }
  }

  async submitMain(exec: ToolExecutionAuthority, teamId: string, input: SubmitWorkRequestInput) {
    await this.deps.ready()
    const agent = requireAgent(exec), scope = this.deps.scopeOf(agent)
    this.exact(exec, agent, scope)
    if (agent.session.header.parentSession !== undefined) throw new TeamDomainError('Only the managed Main can propose work through this tool', 'TEAM_MAIN_REQUIRED')
    const result = await this.deps.fence(scope, TeamId(teamId), exec.signal, async signal => {
      const team = (await this.deps.teams(scope)).find(candidate => candidate.id === teamId)
      if (team === undefined || publicManagedParent(team.managedOrigin) !== agent.id) {
        throw new TeamDomainError('This Team does not belong to the executing Main', 'TEAM_MAIN_REQUIRED')
      }
      if ((await publicAppendEligibility(this.ctx, scope, team, signal)).state !== 'available') {
        throw new TeamDomainError('Work requests require an active managed Team with official lineage', 'TEAM_WORK_REQUEST_UNAVAILABLE')
      }
      this.exact(exec, agent, scope); signal.throwIfAborted()
      return await this.deps.domain().submitWorkRequest(scope, team.id, { kind: 'main', sessionId: agent.id }, input, {
        expectedCaptainSessionId: team.captainSessionId, expectedTeamRevision: team.revision, expectedManagedOrigin: team.managedOrigin!,
      })
    })
    this.deps.kick(scope, TeamId(teamId))
    return result
  }

  private async memberExecution(exec: ToolExecutionAuthority) {
    await this.deps.ready()
    const actor = requireAgent(exec), scope = this.deps.scopeOf(actor)
    this.exact(exec, actor, scope)
    const membership = await this.deps.domain().requireMembership(scope, actor.id)
    this.exact(exec, actor, scope)
    return { actor, scope, team: membership.team }
  }

  async list(exec: ToolExecutionAuthority) {
    const { actor, scope, team } = await this.memberExecution(exec)
    this.exact(exec, actor, scope)
    return await this.deps.domain().listWorkRequests(scope, team.id, actor.id)
  }

  async resolve(exec: ToolExecutionAuthority, input: ResolveWorkRequestInput) {
    const { actor, scope, team } = await this.memberExecution(exec)
    this.exact(exec, actor, scope)
    const result = await this.deps.domain().resolveWorkRequest(scope, team.id, actor.id, input)
    const captain = this.ctx.agents.get(SessionId(team.captainSessionId))
    if (captain !== undefined) this.deps.schedule(scope, team.id, captain)
    return result
  }
}
