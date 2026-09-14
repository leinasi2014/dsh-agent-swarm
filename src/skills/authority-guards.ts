/**
 * The skills module's non-public authorization guards (task-1 S1).
 *
 * Kept as a leaf so `module.ts` stays an orchestration surface: every guard
 * is a pure re-validation over official live instances and the Host manifest
 * — the SAME checks the module re-runs inside official queued update
 * callbacks at the final commit boundary, from one single source.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TeamDomainError } from '../domain/error.js'
import type { TeamDomainPort } from '../domain/team-domain-port.js'

type Membership = NonNullable<Awaited<ReturnType<TeamDomainPort['findMembership']>>>

export interface AuthorityGuardState {
  readonly ctx: Context
  readonly domain: TeamDomainPort
  readonly management: () => readonly { readonly scope: string; readonly teamId: string }[]
  readonly isAdmissionClosed: () => boolean
}

export class AuthorityGuards {
  constructor(private readonly deps: AuthorityGuardState) {}

  assertAdmission(): void {
    if (this.deps.isAdmissionClosed()) throw new TeamDomainError('the skills-management module admission is closed', 'SKILLS_ADMISSION_CLOSED')
  }

  /** The caller must still be the EXACT live Agent instance AND Session. */
  assertLive(agent: Agent): void {
    if (this.deps.ctx.agents.get(agent.id) !== agent || this.deps.ctx.sessions.get(agent.id) !== agent.session) {
      throw new TeamDomainError('the Skills caller Agent is no longer the exact live Session', 'TEAM_AGENT_REQUIRED')
    }
  }

  manifestKeys(): ReadonlySet<string> {
    return new Set(this.deps.management().map(entry => `${entry.scope}\u0000${entry.teamId}`))
  }

  assertManifest(scope: string, teamId: string): void {
    if (!this.deps.management().some(entry => entry.scope === scope && entry.teamId === teamId)) {
      throw new TeamDomainError('the workspace+Team pair is outside the Host management manifest', 'SKILLS_UNAUTHORIZED')
    }
  }

  /** Captain-only on an ACTIVE Team, read from official membership. */
  async assertCaptain(agent: Agent, scope: string): Promise<Membership> {
    this.assertLive(agent)
    const membership = await this.deps.domain.findMembership(scope, agent.id)
    if (membership === undefined || membership.role !== 'captain' || membership.team.captainSessionId !== agent.id || membership.team.phase !== 'active') {
      throw new TeamDomainError('the Skills request face is Captain-only on an active Team', 'SKILLS_CAPTAIN_REQUIRED')
    }
    return membership
  }
}
