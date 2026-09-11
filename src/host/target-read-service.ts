/** Host-owned target and visibility authority for local read consumers. */
import type { Context } from '@deepseek-ai/cordis'
import { readPersistedSession } from '../runtime/persisted-session.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title'
import { isModelInvocable, type SkillRegistry } from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { TeamDomainError } from '../domain/error.js'
import type { TeamState } from '../domain/types.js'
import type { AgentSwarmRuntime } from '../runtime/orchestrator-runtime.js'
import { projectTeamSummary, type AgentSwarmHostReadService } from './host-read-service.js'
import type { SwarmReadTargetHint, SwarmReadCaptainSectionRequest, SwarmReadSkillCatalogV1, SwarmReadToolCatalogV1, SwarmReadTaskDetailRequest, SwarmReadTaskDetailRequestV2 } from '../rpc/read-rpc-contract.js'
import { readCaptainSection } from './captain-section-read.js'
import { projectTaskDetail } from './task-detail-read.js'
import type { RetirementBinding } from '../runtime/team-retirement.js'
import type { RetirementTarget } from '../shared/team-retirement.js'

interface RootView {
  readonly id: string
  readonly cwd: string
  readonly parentSession?: string
  readonly live?: Agent
  readonly session?: Session | undefined
}

export class HostTargetReadService {
  constructor(private readonly ctx: Context, private readonly runtime: AgentSwarmRuntime, private readonly host: AgentSwarmHostReadService) {}

  teams(rootSessionId: string) { return this.host.withTargetRead(() => this.readTeams(rootSessionId)) }
  read(target: SwarmReadTargetHint, afterCursor?: string) { return this.host.withTargetRead(() => this.readProjection(target, afterCursor)) }
  section(request: SwarmReadCaptainSectionRequest) { return this.host.withTargetRead(() => this.readSection(request)) }
  tools(rootSessionId: string) { return this.host.withTargetRead(() => this.readTools(rootSessionId)) }
  skills(rootSessionId: string) { return this.host.withTargetRead(() => this.readSkills(rootSessionId)) }
  taskDetail(request: SwarmReadTaskDetailRequest | SwarmReadTaskDetailRequestV2) { return this.host.withTargetRead(() => this.readTaskDetail(request)) }
  readTasksV2(target: SwarmReadTargetHint, afterCursor?: string) {
    return this.host.withTargetRead(async () => {
      const { root, team } = await this.boundTeam(target)
      this.assertUnchanged(root)
      return this.host.projectAuthorizedTeamV2(team, root.cwd, afterCursor, team.captainSessionId || root.id)
    })
  }

  /** Shared Host visibility proof; callers never supply an execution identity. */
  withPublicTeam<T>(target: SwarmReadTargetHint, operation: (scope: string, team: TeamState, verify: () => Promise<void>,
    assertCurrentTeam: (current: TeamState) => void) => Promise<T>): Promise<T> {
    return this.host.withTargetRead(async () => {
      if (target.teamId === undefined) throw new TeamDomainError('Public chat requires an explicit Team', 'SWARM_RPC_INVALID_REQUEST')
      const { root, team, verify, assertCurrentTeam } = await this.boundTeam(target)
      const current = async () => { await verify(true); this.assertUnchanged(root); this.assertLiveCaptain(team, root.cwd) }
      await current()
      return await operation(root.cwd, team, current, assertCurrentTeam)
    })
  }

  /** Authenticated local operator authority is Main scope, independent of Captain execution. */
  withOperatorTeam<T>(target: RetirementTarget, operation: (binding: RetirementBinding) => Promise<T>): Promise<T> {
    return this.host.withTargetRead(async () => {
      const view = await this.visibleTeams(target.rootSessionId)
      const team = view.visible.find(candidate => candidate.id === target.teamId)
      const main = view.main
      if (team === undefined || main === undefined || target.rootSessionId !== main.id) throw new TeamDomainError('Team retirement requires its exact Main binding', 'SWARM_HOST_BINDING_MISMATCH')
      const captain = team.captainSessionId === '' ? undefined : await this.optionalView(team.captainSessionId)
      if (team.captainSessionId !== main.id && (captain === undefined ? !team.managedOrigin?.startsWith(`managed:${main.id}:`) : captain.parentSession !== main.id)) this.bindingChanged()
      const assertMain = () => {
        this.assertUnchanged(main)
        if (main.parentSession !== undefined || (main.live !== undefined && !this.ctx.agents.roots().includes(main.live))) this.bindingChanged()
      }
      const assertTeam = (current: TeamState) => {
        assertMain()
        if (current.id !== team.id || current.captainSessionId !== team.captainSessionId || current.managedOrigin !== team.managedOrigin) this.bindingChanged()
        if (captain !== undefined) this.assertUnchanged(captain)
      }
      const verify = async () => { await view.verify(true); assertTeam(team) }
      await verify()
      return operation({ scope: main.cwd, mainSessionId: main.id, team, verify, assertTeam })
    })
  }

  /** A completed deletion remains queryable after its Team and Captain disappear. */
  withOperatorMain<T>(rootSessionId: string, operation: (scope: string, mainSessionId: string) => Promise<T>): Promise<T> {
    return this.host.withTargetRead(async () => {
      const root = await this.rootView(rootSessionId)
      if (root.parentSession !== undefined || (root.live !== undefined && !this.ctx.agents.roots().includes(root.live))) this.bindingChanged()
      this.assertUnchanged(root)
      return operation(root.cwd, root.id)
    })
  }

  private async readTaskDetail(request: SwarmReadTaskDetailRequest | SwarmReadTaskDetailRequestV2) {
    if (request.target.teamId === undefined) throw new TeamDomainError('Task detail requires an explicit Team selector', 'SWARM_RPC_INVALID_REQUEST')
    const { root, team, verify } = await this.boundTeam(request.target)
    // Project selected content from the final authorized aggregate cut. Normal
    // task updates do not invalidate the caller's Session or roster identity.
    const latest = await verify(true)
    const current = latest.find(candidate => candidate.id === team.id)!
    this.assertUnchanged(root)
    this.assertLiveCaptain(current, root.cwd)
    return projectTaskDetail(current, request.taskId, current.captainSessionId || root.id, request.schemaVersion)
  }

  private async readTeams(rootSessionId: string) {
    const { root, visible, main, title, currentTeamId, currentMemberName } = await this.visibleTeams(rootSessionId, { includeMainTitle: true })
    this.assertUnchanged(root)
    return {
      schemaVersion: 1 as const,
      binding: { rootSessionId,
        ...(main === undefined ? {} : { mainSessionId: main.id, ...(title === undefined ? {} : { mainSessionTitle: title }) }),
        ...(currentTeamId === undefined ? {} : { currentTeamId }),
        ...(currentMemberName === undefined ? {} : { currentMemberName }) },
      teams: visible.map(projectTeamSummary),
      complete: true, observedAt: Date.now(),
    }
  }

  private async readProjection(target: SwarmReadTargetHint, afterCursor?: string) {
    const { root, team } = await this.boundTeam(target)
    this.assertUnchanged(root)
    return this.host.projectAuthorizedTeam(team, root.cwd, afterCursor, team.captainSessionId || root.id)
  }

  private async readSection(request: SwarmReadCaptainSectionRequest) {
    if (request.target.teamId === undefined) throw new TeamDomainError('Captain section requires an explicit Team selector', 'SWARM_RPC_INVALID_REQUEST')
    const { root, team, verify } = await this.boundTeam(request.target)
    const result = await readCaptainSection(this.ctx, team, request)
    await verify()
    this.assertUnchanged(root)
    this.assertLiveCaptain(team, root.cwd)
    return result
  }

  private async readTools(rootSessionId: string): Promise<SwarmReadToolCatalogV1> {
    const root = this.ctx.agents.get(SessionId(rootSessionId))
    if (root === undefined || this.ctx.sessions.get(root.id) !== root.session) {
      throw new TeamDomainError('Tool catalog requires an exact live Session', 'SWARM_RPC_TARGET_NOT_LIVE')
    }
    const cwd = root.session.header.cwd
    if (cwd === undefined) throw new TeamDomainError('Target Session has no workspace cwd', 'SWARM_HOST_WORKSPACE_REQUIRED')
    const registry = this.ctx.get('tools')
    if (registry === undefined) throw new TeamDomainError('Tool catalog is unavailable for this Session', 'SWARM_RPC_TOOL_CATALOG_UNAVAILABLE')
    const schemas = registry.schemas(root)
    if (schemas.length > 512) throw new TeamDomainError('Tool catalog exceeds the bounded read ceiling', 'SWARM_RPC_PROJECTION_LIMIT')
    const tools = [...new Map(schemas.map(tool => [tool.name, { name: tool.name, description: tool.description }])).values()].toSorted((a, b) => a.name.localeCompare(b.name))
    if (tools.some(tool => tool.name.length > 128 || tool.description.length > 4096)) {
      throw new TeamDomainError('Tool metadata exceeds the bounded read ceiling', 'SWARM_RPC_PROJECTION_LIMIT')
    }
    if (this.ctx.agents.get(root.id) !== root || this.ctx.sessions.get(root.id) !== root.session || root.session.header.cwd !== cwd) {
      throw new TeamDomainError('Session binding changed during tool read', 'SWARM_HOST_BINDING_MISMATCH')
    }
    return { schemaVersion: 1, binding: { rootSessionId }, complete: true, tools, observedAt: Date.now() }
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
    const view = await this.visibleTeams(target.rootSessionId)
    const { root, visible, all, currentTeamId } = view
    if (target.teamId !== undefined) {
      const team = visible.find(candidate => candidate.id === target.teamId)
      if (team !== undefined) return { ...this.bindTeam(root, team), verify: view.verify, assertCurrentTeam: view.assertCurrentTeam }
      throw new TeamDomainError('Target Team is not visible to this Session', all.some(candidate => candidate.id === target.teamId)
        ? 'SWARM_HOST_BINDING_MISMATCH' : 'SWARM_HOST_BINDING_NOT_FOUND')
    }
    const owned = visible.filter(team => team.id === currentTeamId || team.captainSessionId === root.id)
    const candidates = owned.length === 0 ? visible : owned
    const active = candidates.filter(team => team.phase === 'active')
    if (active.length === 1) return { ...this.bindTeam(root, active[0]!), verify: view.verify, assertCurrentTeam: view.assertCurrentTeam }
    if (active.length > 1 || candidates.length > 1) throw new TeamDomainError('Multiple Teams are available; select one Team', 'SWARM_HOST_BINDING_AMBIGUOUS')
    if (candidates.length === 1) return { ...this.bindTeam(root, candidates[0]!), verify: view.verify, assertCurrentTeam: view.assertCurrentTeam }
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

  private async visibleTeams(rootSessionId: string, options: { includeMainTitle?: boolean } = {}) {
    const root = await this.rootView(rootSessionId)
    // Resolve optional display data before the root's sole aggregate cut.
    // Keep this original identity witness for the final verification below.
    const rootTitle = options.includeMainTitle && root.parentSession === undefined ? await this.mainTitle(root) : undefined
    const all = await this.runtime.listTeamAggregates(root.cwd)
    const managed = new Set(this.runtime.managedCaptainSessionsOf(root.id))
    const visible: TeamState[] = []
    for (const team of all) {
      if (team.captainSessionId === root.id) {
        if (root.live !== undefined || root.parentSession === undefined || team.phase === 'active') visible.push(team)
        continue
      }
      if (root.parentSession !== undefined) {
        // Exact current membership grants this Team only; never inherit a
        // parent's other Teams or revive a removed/previous Session identity.
        if (root.parentSession === team.captainSessionId
          && team.members?.some(member => member.phase === 'active' && member.sessionId === root.id)) visible.push(team)
        continue
      }
      // A plan-first Team has no Captain descriptor yet. Its durable managed
      // origin proves ownership; the actual root still comes from DSH above.
      if (team.captainSessionId === ''
        && (team.phase === 'staged' || (team.phase === 'archived' && team.discardReason === 'discarded'))
        && team.managedOrigin?.startsWith(`managed:${root.id}:`)) {
        visible.push(team)
        continue
      }
      if (team.captainSessionId === '') continue
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
    const association = await this.mainAssociation(root, all)
    const witnesses = [...new Map([root, ...association.witnesses].map(view => [view.id, view])).values()]
    if (association.main !== undefined && association.main.id !== root.id) {
      for (const team of all) {
        if (visible.includes(team)) continue
        if (team.captainSessionId === '') {
          if ((team.phase === 'staged' || (team.phase === 'archived' && team.discardReason === 'discarded'))
            && team.managedOrigin?.startsWith(`managed:${association.main.id}:`)) visible.push(team)
          continue
        }
        const captain = await this.optionalView(team.captainSessionId)
        if (captain?.cwd === root.cwd && captain.parentSession === association.main.id) {
          visible.push(team)
          witnesses.push(captain)
        }
      }
    }
    // A child needs the initial aggregates to locate Main. Its title await
    // belongs before the existing final parent/member authorization cut.
    const title = options.includeMainTitle && association.main !== undefined
      ? association.main.id === root.id ? rootTitle : await this.mainTitle(association.main) : undefined
    // Header reads and section composition can yield. Re-read the canonical
    // aggregates after those awaits; a removed/retried member cannot keep an
    // earlier authorization snapshot. Official Session headers are immutable.
    const verify = async (refreshAggregates = false) => {
      for (const before of witnesses) {
        const after = await this.rootView(before.id)
        if (after.cwd !== before.cwd || after.parentSession !== before.parentSession
          || after.live !== before.live || after.session !== before.session) this.bindingChanged()
      }
      let latest = all
      // Revalidate authorization facts, not aggregate revisions: ordinary
      // tasks, announcements and public messages may advance during a read.
      if (root.parentSession !== undefined || refreshAggregates) {
        latest = await this.runtime.listTeamAggregates(root.cwd)
        for (const before of [...visible, ...(association.current === undefined ? [] : [association.current])]) {
          const after = latest.find(team => team.id === before.id)
          if (after === undefined || after.captainSessionId !== before.captainSessionId) this.bindingChanged()
          if (before === association.current && after.phase !== 'active') this.bindingChanged()
          if (root.parentSession === before.captainSessionId && (before === association.current || association.main === undefined)
            && !after.members.some(member => member.phase === 'active' && member.sessionId === root.id)) this.bindingChanged()
          if (before.captainSessionId === root.id && root.live === undefined && root.parentSession !== undefined && association.main === undefined
            && after.phase !== 'active') this.bindingChanged()
          if (before.captainSessionId === '' && (after.managedOrigin !== before.managedOrigin
            || !(after.phase === 'staged' || (after.phase === 'archived' && after.discardReason === 'discarded')))) this.bindingChanged()
        }
      }
      for (const witness of witnesses) this.assertUnchanged(witness)
      if (association.main?.live !== undefined && !this.ctx.agents.roots().includes(association.main.live)) this.bindingChanged()
      return latest
    }
    // A write consumer calls this synchronously while holding the target
    // Team's existing lock. Never await verify() there: it re-enters that lock.
    const assertCurrentTeam = (candidate: TeamState): void => {
      for (const witness of witnesses) this.assertUnchanged(witness)
      if (association.main?.live !== undefined && !this.ctx.agents.roots().includes(association.main.live)) this.bindingChanged()
      const before = visible.find(item => item.id === candidate.id)
      if (before === undefined || candidate.captainSessionId !== before.captainSessionId
        || candidate.managedOrigin !== before.managedOrigin) this.bindingChanged()
      if (root.parentSession !== undefined && association.current !== undefined && association.current.id !== candidate.id) {
        // A member's cross-Team read association is not a write capability:
        // its other Team roster cannot be revalidated inside this Team lock.
        this.bindingChanged()
      }
      if (root.parentSession === candidate.captainSessionId
        && !candidate.members.some(member => member.sessionId === root.id && member.phase === 'active')) this.bindingChanged()
      this.assertLiveCaptain(candidate, root.cwd)
    }
    const latest = await verify()
    return { root, visible: latest.filter(team => visible.some(before => before.id === team.id)), all: latest, main: association.main, title,
      currentTeamId: association.current?.id, currentMemberName: association.currentMemberName, verify, assertCurrentTeam }
  }

  /** Association is local single-user UI read authority only. A member must
   *  be the active exact roster identity, and both parent links must be official. */
  private async mainAssociation(root: RootView, all: TeamState[]) {
    const candidates = all.filter(team => team.phase === 'active' && (team.captainSessionId === root.id
      || (team.captainSessionId === root.parentSession && team.members?.some(member => member.phase === 'active' && member.sessionId === root.id))))
    const current = candidates.length === 1 ? candidates[0] : undefined
    const witnesses: RootView[] = []
    let main: RootView | undefined = root.parentSession === undefined ? root : undefined
    if (main === undefined && current !== undefined) {
      const captain = current.captainSessionId === root.id ? root : await this.optionalView(current.captainSessionId)
      if (captain?.cwd === root.cwd && captain.parentSession !== undefined) {
        const parent = await this.optionalView(captain.parentSession)
        if (parent?.cwd === root.cwd && parent.parentSession === undefined
          && (parent.live === undefined || this.ctx.agents.roots().includes(parent.live))) {
          main = parent
          witnesses.push(captain, parent)
        }
      }
    }
    const member = current?.captainSessionId === root.id ? undefined
      : current?.members.find(row => row.phase === 'active' && row.sessionId === root.id)
    return { main, current, currentMemberName: member?.displayName ?? member?.name, witnesses }
  }

  private async optionalView(id: string): Promise<RootView | undefined> {
    try { return await this.rootView(id) } catch (error) {
      if (error instanceof TeamDomainError && (error.code === 'SWARM_RPC_TARGET_NOT_LIVE' || error.code === 'SWARM_HOST_WORKSPACE_REQUIRED')) return undefined
      throw error
    }
  }

  private bindingChanged(): never {
    throw new TeamDomainError('Session or Team binding changed during read', 'SWARM_HOST_BINDING_MISMATCH')
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
      return { id, cwd: this.runtime.scopeOf(live), live, session: current,
        ...(live.session.header.parentSession === undefined ? {} : { parentSession: live.session.header.parentSession }) }
    }
    const session = this.ctx.sessions.get(SessionId(id))
    const header = session?.header ?? await this.persistedHeader(id)
    if (header === undefined) throw new TeamDomainError('Target is not an official persisted Session', 'SWARM_RPC_TARGET_NOT_LIVE')
    if (header.cwd === undefined) throw new TeamDomainError('Target Session has no workspace cwd', 'SWARM_HOST_WORKSPACE_REQUIRED')
    return { id, cwd: this.runtime.scopeOf({ session: { header } } as Agent), session,
      ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }) }
  }

  private async persistedHeader(id: string): Promise<{ cwd?: string; parentSession?: string } | undefined> {
    try {
      return (await this.ctx.sessionPersistence?.stat(SessionId(id), { signal: AbortSignal.timeout(3_000) }))?.header
    } catch { return undefined }
  }

  /** Titles are display data for teams only, never part of an identity witness. */
  private async mainTitle(main: RootView): Promise<string | undefined> {
    const session = main.live?.session ?? main.session
    const projections = this.ctx.get?.('sessionProjections')
    if (session !== undefined && projections !== undefined) {
      const title = projections.stateOf(session, 'title')
      if (title !== undefined) return title ?? undefined
    }
    if (session !== undefined) return typeof session.snapshotEvents === 'function' ? foldSessionTitle(session.snapshotEvents())?.title : undefined
    const stored = await readPersistedSession(this.ctx.sessionPersistence, SessionId(main.id), AbortSignal.timeout(3_000))
    if (stored.meta.id !== main.id || stored.meta.cwd === undefined || this.runtime.scopeOf({ session: { header: stored.meta } } as Agent) !== main.cwd
      || stored.meta.parentSession !== main.parentSession) this.bindingChanged()
    return foldSessionTitle(stored.events)?.title
  }

  private assertUnchanged(root: RootView): void {
    if (root.live === undefined) {
      if (this.ctx.agents.get(SessionId(root.id)) !== undefined || this.ctx.sessions.get(SessionId(root.id)) !== root.session) this.bindingChanged()
      return
    }
    const current = this.ctx.sessions.get(SessionId(root.id))
    if (this.ctx.agents.get(SessionId(root.id)) !== root.live || (current !== undefined && current !== root.live.session)
      || this.runtime.scopeOf(root.live) !== root.cwd || root.live.session.header.parentSession !== root.parentSession) throw new TeamDomainError('Session binding changed during read', 'SWARM_HOST_BINDING_MISMATCH')
  }
}
