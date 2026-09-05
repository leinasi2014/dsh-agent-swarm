/** Host-owned target and visibility authority for local read consumers. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { isModelInvocable, type SkillRegistry } from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { TeamDomainError } from '../domain/error.js'
import type { TeamState } from '../domain/types.js'
import type { AgentSwarmRuntime } from '../runtime/orchestrator-runtime.js'
import { projectTeamSummary, type AgentSwarmHostReadService } from './host-read-service.js'
import type { SwarmReadTargetHint, SwarmReadCaptainSectionRequest, SwarmReadSkillCatalogV1 } from '../rpc/read-rpc-contract.js'
import { readCaptainSection } from './captain-section-read.js'

interface RootView {
  readonly id: string
  readonly cwd: string
  readonly parentSession?: string
  readonly live?: Agent
}

export class HostTargetReadService {
  constructor(private readonly ctx: Context, private readonly runtime: AgentSwarmRuntime, private readonly host: AgentSwarmHostReadService) {}

  teams(rootSessionId: string) { return this.host.withTargetRead(() => this.readTeams(rootSessionId)) }
  read(target: SwarmReadTargetHint, afterCursor?: string) { return this.host.withTargetRead(() => this.readProjection(target, afterCursor)) }
  section(request: SwarmReadCaptainSectionRequest) { return this.host.withTargetRead(() => this.readSection(request)) }
  skills(rootSessionId: string) { return this.host.withTargetRead(() => this.readSkills(rootSessionId)) }

  private async readTeams(rootSessionId: string) {
    const { root, visible } = await this.visibleTeams(rootSessionId)
    this.assertUnchanged(root)
    return {
      schemaVersion: 1 as const,
      binding: { rootSessionId },
      teams: visible.map(projectTeamSummary),
      complete: true, observedAt: Date.now(),
    }
  }

  private async readProjection(target: SwarmReadTargetHint, afterCursor?: string) {
    const { root, team } = await this.boundTeam(target)
    this.assertUnchanged(root)
    return this.host.projectAuthorizedTeam(team, root.cwd, afterCursor)
  }

  private async readSection(request: SwarmReadCaptainSectionRequest) {
    if (request.target.teamId === undefined) throw new TeamDomainError('Captain section requires an explicit Team selector', 'SWARM_RPC_INVALID_REQUEST')
    const { root, team } = await this.boundTeam(request.target)
    const result = await readCaptainSection(this.ctx, team, request)
    this.assertUnchanged(root)
    this.assertLiveCaptain(team, root.cwd)
    return result
  }

  private async readSkills(rootSessionId: string): Promise<SwarmReadSkillCatalogV1> {
    const root = this.ctx.agents.get(SessionId(rootSessionId))
    if (root === undefined || this.ctx.sessions.get(root.id) !== root.session) {
      throw new TeamDomainError('Skill catalog requires an exact live Session', 'SWARM_RPC_TARGET_NOT_LIVE')
    }
    const cwd = root.session.header.cwd
    if (cwd === undefined) throw new TeamDomainError('Target Session has no workspace cwd', 'SWARM_HOST_WORKSPACE_REQUIRED')
    const registry = this.ctx.get('agentPresets')?.serviceFor(root, 'skills') as SkillRegistry | undefined
      ?? this.ctx.get('skills')
    if (registry === undefined) throw new TeamDomainError('Skill catalog is unavailable for this Session', 'SWARM_RPC_SKILL_CATALOG_UNAVAILABLE')
    const observation = await registry.snapshot({ cwd, scope: root, signal: AbortSignal.timeout(3_000) })
    const skills = observation.skills.filter(isModelInvocable)
    if (skills.length > 512) throw new TeamDomainError('Skill catalog exceeds the bounded read ceiling', 'SWARM_RPC_PROJECTION_LIMIT')
    if (this.ctx.agents.get(root.id) !== root || this.ctx.sessions.get(root.id) !== root.session || root.session.header.cwd !== cwd) {
      throw new TeamDomainError('Session binding changed during Skill read', 'SWARM_HOST_BINDING_MISMATCH')
    }
    return { schemaVersion: 1, binding: { rootSessionId }, complete: observation.complete,
      skills: skills.map(skill => ({ name: skill.name, description: skill.description,
        ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }), modelInvocable: true })), observedAt: Date.now() }
  }

  private async boundTeam(target: SwarmReadTargetHint) {
    const { root, visible, all } = await this.visibleTeams(target.rootSessionId)
    if (target.teamId !== undefined) {
      const team = visible.find(candidate => candidate.id === target.teamId)
      if (team !== undefined) return this.bindTeam(root, team)
      throw new TeamDomainError('Target Team is not visible to this Session', all.some(candidate => candidate.id === target.teamId)
        ? 'SWARM_HOST_BINDING_MISMATCH' : 'SWARM_HOST_BINDING_NOT_FOUND')
    }
    const owned = visible.filter(team => team.captainSessionId === root.id)
    const candidates = owned.length === 0 ? visible : owned
    const active = candidates.filter(team => team.phase === 'active')
    if (active.length === 1) return this.bindTeam(root, active[0]!)
    if (active.length > 1 || candidates.length > 1) throw new TeamDomainError('Multiple Teams are available; select one Team', 'SWARM_HOST_BINDING_AMBIGUOUS')
    if (candidates.length === 1) return this.bindTeam(root, candidates[0]!)
    throw new TeamDomainError('No Team is available for this Session', 'SWARM_HOST_BINDING_NOT_FOUND')
  }

  private bindTeam(root: RootView, team: TeamState) {
    this.assertLiveCaptain(team, root.cwd)
    return { root, team }
  }

  /** A live Captain is usable only with its exact current official Session.
   *  A genuinely cold Captain remains eligible through the persisted binding. */
  private assertLiveCaptain(team: TeamState, scope: string): void {
    const captain = this.ctx.agents.get(SessionId(team.captainSessionId))
    if (captain !== undefined && (this.ctx.sessions.get(captain.id) !== captain.session
      || captain.session.header.cwd === undefined || this.runtime.scopeOf(captain) !== scope)) {
      throw new TeamDomainError('Dedicated Captain Session is not live', 'SWARM_RPC_TARGET_NOT_LIVE')
    }
  }

  private async visibleTeams(rootSessionId: string) {
    const root = await this.rootView(rootSessionId)
    const all = await this.runtime.listTeamAggregates(root.cwd)
    const managed = new Set(this.runtime.managedCaptainSessionsOf(root.id))
    const visible: TeamState[] = []
    for (const team of all) {
      if (team.captainSessionId === root.id) {
        if (root.live !== undefined || root.parentSession === undefined || team.phase === 'active') visible.push(team)
        continue
      }
      if (root.parentSession !== undefined) continue // a member/child never inherits its parent's Teams
      const captain = this.ctx.agents.get(SessionId(team.captainSessionId))
      const descriptor = captain?.session.header ?? this.ctx.sessions.get(SessionId(team.captainSessionId))?.header
        ?? await this.persistedHeader(team.captainSessionId)
      if (descriptor?.cwd !== undefined && this.runtime.scopeOf({ session: { header: descriptor } } as Agent) !== root.cwd) continue
      if (descriptor?.parentSession === root.id || (captain === undefined && managed.has(team.captainSessionId))) visible.push(team)
    }
    if (root.live !== undefined && root.parentSession === undefined && !this.ctx.agents.roots().includes(root.live)) {
      throw new TeamDomainError('Target is not a root Session', all.some(team => team.captainSessionId === root.id)
        ? 'SWARM_RPC_TARGET_NOT_LIVE' : 'SWARM_HOST_BINDING_MISMATCH')
    }
    this.assertUnchanged(root)
    return { root, visible, all }
  }

  private async rootView(id: string): Promise<RootView> {
    const live = this.ctx.agents.get(SessionId(id))
    if (live !== undefined) {
      const current = this.ctx.sessions.get(live.id)
      if ((current !== undefined && current !== live.session)
        ) {
        throw new TeamDomainError('Target Session binding is not current', 'SWARM_RPC_TARGET_NOT_LIVE')
      }
      if (live.session.header.cwd === undefined) throw new TeamDomainError('Target Session has no workspace cwd', 'SWARM_HOST_WORKSPACE_REQUIRED')
      return { id, cwd: this.runtime.scopeOf(live), live,
        ...(live.session.header.parentSession === undefined ? {} : { parentSession: live.session.header.parentSession }) }
    }
    const header = await this.persistedHeader(id)
    if (header === undefined) throw new TeamDomainError('Target is not an official persisted Session', 'SWARM_RPC_TARGET_NOT_LIVE')
    if (header.cwd === undefined) throw new TeamDomainError('Target Session has no workspace cwd', 'SWARM_HOST_WORKSPACE_REQUIRED')
    return { id, cwd: this.runtime.scopeOf({ session: { header } } as Agent),
      ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }) }
  }

  private async persistedHeader(id: string): Promise<{ cwd?: string; parentSession?: string } | undefined> {
    try {
      const stored = await this.ctx.sessionPersistence?.inspect(SessionId(id), AbortSignal.timeout(3_000))
      if (stored === undefined) return undefined
      return { ...(stored.meta.cwd === undefined ? {} : { cwd: stored.meta.cwd }),
        ...(stored.meta.parentSession === undefined ? {} : { parentSession: stored.meta.parentSession }) }
    } catch { return undefined }
  }

  private assertUnchanged(root: RootView): void {
    if (root.live === undefined) return
    const current = this.ctx.sessions.get(SessionId(root.id))
    if (this.ctx.agents.get(SessionId(root.id)) !== root.live || (current !== undefined && current !== root.live.session)
      || this.runtime.scopeOf(root.live) !== root.cwd) throw new TeamDomainError('Session binding changed during read', 'SWARM_HOST_BINDING_MISMATCH')
  }
}
