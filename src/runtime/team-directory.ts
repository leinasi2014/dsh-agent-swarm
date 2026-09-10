/** One read-only directory projection; never resumes an Agent or reads private memory. */
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { SessionId, SessionLogOffset, foldRequestHeader, type SessionEvent } from '@deepseek-ai/dsh-session'
import { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { isModelInvocable } from '@deepseek-ai/dsh-skill'
import { z } from 'zod'
import { TeamDomainError } from '../domain/error.js'
import { isSafePixelAvatarSvg } from '../domain/identity-profile.js'
import type { TeamScope } from '../domain/team-domain-port.js'
import type { TeamId, TeamMember, TeamState, TeamLimits } from '../domain/types.js'
import type { DirectoryEntry, DirectoryResponse, DirectorySkillSet, DirectorySource } from '../rpc/directory-contract.js'
import { readPersistedSession } from './persisted-session.js'
import { injectedSkills } from './injected-skills.js'

const digest = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
const cursorSchema = z.object({ teamId: z.string(), revision: z.string(), offset: z.number().int().nonnegative() }).strict()
const text = (value: string, length = 500) => [...value].slice(0, length).join('')
const skillSummary = (row: { name: string; description: string }) => ({ name: row.name, description: text(row.description),
  ...([...row.description].length > 500 ? { descriptionTruncated: true } : {}) })
const emptySource = (sourceName: string, reason: string, observedAt: number): DirectorySource => ({ state: 'unknown', source: sourceName, reason, observedAt })
const emptySkills = (sourceName: string, reason: string, observedAt: number): DirectorySkillSet => ({ ...emptySource(sourceName, reason, observedAt), entries: [] })
function source(sourceName: string, value: unknown, observedAt: number): DirectorySource {
  return { state: 'available', source: sourceName, version: digest(value), observedAt }
}
function withoutObservation(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutObservation)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'observedAt').map(([key, item]) => [key, withoutObservation(item)]))
  return value
}

/** This is the exact catalog previously shown in the Session, not a guess from assignments. */
function sessionSkills(events: readonly SessionEvent[], observedAt: number): DirectorySkillSet {
  for (const event of events.toReversed()) {
    if (event.type !== 'user/message' || event.data.source?.kind !== 'skill-catalog' || event.data.source.form !== 'catalog') continue
    const entries = event.data.source.entries.map(skillSummary)
    return { ...source('session-skill-catalog', { seq: event.seq, entries }, observedAt), entries }
  }
  return emptySkills('session-skill-catalog', 'no-catalog-observed', observedAt)
}

export class TeamDirectory {
  private readonly skillsOf: ReturnType<typeof injectedSkills>
  constructor(private readonly ctx: Context, private readonly teams: (scope: TeamScope) => Promise<TeamState[]>,
    private readonly limits: Pick<TeamLimits, 'maxDirectoryReadConcurrency' | 'maxDirectoryReadMs' | 'maxDirectoryEntryReadMs'>) {
    this.skillsOf = injectedSkills(ctx)
  }

  async read(scope: TeamScope, teamId: TeamId, input: { limit?: number; cursor?: string }, signal: AbortSignal): Promise<DirectoryResponse> {
    const limit = input.limit ?? 50
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new TeamDomainError('Directory limit must be 1..50', 'SWARM_RPC_INVALID_REQUEST')
    let cursor: z.infer<typeof cursorSchema> | undefined
    if (input.cursor !== undefined) {
      try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))) }
      catch { throw new TeamDomainError('Invalid directory cursor', 'SWARM_RPC_INVALID_REQUEST') }
      if (cursor.teamId !== teamId) throw new TeamDomainError('Directory cursor belongs to another Team', 'SWARM_DIRECTORY_STALE')
    }
    const readTeam = async () => {
      const team = (await this.teams(scope)).find(row => row.id === teamId)
      if (team === undefined) throw new TeamDomainError('Team not found', 'TEAM_NOT_FOUND')
      return team
    }
    const team = await readTeam()
    const first = await this.collect(scope, team, signal)
    const current = await readTeam()
    if (current.revision !== team.revision) throw new TeamDomainError('Directory changed during read', 'SWARM_DIRECTORY_STALE')
    const second = await this.collect(scope, current, signal)
    const final = await readTeam()
    if (final.revision !== team.revision || first.revision !== second.revision
      || first.live.some((agent, index) => agent !== second.live[index])) throw new TeamDomainError('Directory sources changed during read', 'SWARM_DIRECTORY_STALE')
    const revision = second.revision
    if (cursor !== undefined && cursor.revision !== revision) throw new TeamDomainError('Directory page belongs to an older revision', 'SWARM_DIRECTORY_STALE')
    const offset = cursor?.offset ?? 0
    if (offset > second.entries.length) throw new TeamDomainError('Invalid directory offset', 'SWARM_RPC_INVALID_REQUEST')
    const entries = second.entries.slice(offset, offset + limit)
    const end = offset + entries.length, total = second.entries.length
    const nextCursor = end < total ? Buffer.from(JSON.stringify({ teamId, revision, offset: end })).toString('base64url') : undefined
    signal.throwIfAborted()
    return { schemaVersion: 2, binding: { rootSessionId: team.captainSessionId, teamId }, directoryRevision: revision,
      observedAt: Date.now(), entries, page: { offset, limit, totalCount: total, returnedCount: entries.length, hasMore: end < total,
        ...(nextCursor === undefined ? {} : { nextCursor }), unreadRanges: [
          ...(offset === 0 ? [] : [{ offset: 0, count: offset }]), ...(end === total ? [] : [{ offset: end, count: total - end }]),
        ] } }
  }

  private async collect(scope: TeamScope, team: TeamState, signal: AbortSignal) {
    const identities = [undefined, ...team.members]
    const entries: DirectoryEntry[] = [], live: (Agent | undefined)[] = []
    let next = 0
    const pageSignal = AbortSignal.any([signal, AbortSignal.timeout(this.limits.maxDirectoryReadMs)])
    await Promise.all(Array.from({ length: Math.min(this.limits.maxDirectoryReadConcurrency, identities.length) }, async () => {
      for (;;) {
        const index = next++
        if (index >= identities.length) return
        signal.throwIfAborted()
        const member = identities[index]
        const id = member?.sessionId ?? team.captainSessionId
        live[index] = id === '' ? undefined : this.ctx.agents.get(SessionId(id))
        entries[index] = await this.entry(scope, team, member, live[index], pageSignal)
      }
    }))
    signal.throwIfAborted()
    return { entries, live, revision: digest({ teamId: team.id, teamRevision: team.revision, entries: withoutObservation(entries) }) }
  }

  private async entry(scope: TeamScope, team: TeamState, member: TeamMember | undefined, live: Agent | undefined, pageSignal: AbortSignal): Promise<DirectoryEntry> {
    const observedAt = Date.now(), role = member === undefined ? 'captain' : 'member'
    const memberId = member?.sessionId ?? team.captainSessionId, profile = member ?? team.captainProfile
    const assigned = member?.assignedSkills
    const base: DirectoryEntry = {
      memberId, role, name: member?.name ?? 'captain', label: profile?.displayName ?? member?.name ?? 'captain',
      responsibility: member?.role ?? 'Lead and coordinate the Team', phase: member?.phase ?? team.phase,
      ...(profile?.profession === undefined ? {} : { profession: profile.profession }),
      ...(profile?.personality === undefined ? {} : { personality: profile.personality }),
      ...(profile?.biography === undefined ? {} : { biography: profile.biography }),
      profile: source('team-aggregate', { revision: team.revision, memberId, profile }, observedAt),
      avatar: profile?.pixelAvatarSvg !== undefined && isSafePixelAvatarSvg(profile.pixelAvatarSvg)
        ? { state: 'generated', svg: profile.pixelAvatarSvg } : { state: 'not_generated', reason: 'avatar_backend_not_implemented' },
      currentTasks: team.tasks.filter(task => task.ownerSessionId === memberId && ['in_progress', 'submitted', 'verifying'].includes(task.status))
        .map(task => ({ id: task.id, subject: task.subject, status: task.status })),
      skills: { assigned: assigned === undefined ? emptySkills('team-assignment', 'not-declared', observedAt)
        : { ...source('team-assignment', assigned, observedAt), entries: assigned.map(name => ({ name })) },
        sessionVisible: emptySkills('session-skill-catalog', 'session-unavailable', observedAt),
        catalog: emptySkills('scoped-skill-registry', 'no-live-scope', observedAt) },
      tools: { ...emptySource('scoped-tool-registry-and-team-policy', 'no-live-scope', observedAt), complete: false, entries: [] },
      model: { ...emptySource('session-model-selection', 'session-unavailable', observedAt), imageInput: 'unknown' },
    }
    if (memberId === '' || pageSignal.aborted) return base
    const signal = AbortSignal.any([pageSignal, AbortSignal.timeout(this.limits.maxDirectoryEntryReadMs)])
    try {
      const stored = live !== undefined ? { meta: live.session.header, inheritedEventCount: live.session.inheritedEventCount, events: live.session.snapshotEvents() }
        : await readPersistedSession(this.ctx.sessionPersistence, SessionId(memberId), signal)
      if (stored.meta.id !== memberId || stored.meta.cwd === undefined || resolve(stored.meta.cwd) !== scope
        || (member !== undefined && stored.meta.parentSession !== team.captainSessionId)) return base
      const own = stored.events.slice(stored.inheritedEventCount)
      const descriptor = stored.meta.parentSession === undefined ? undefined : foldSubagentDescriptor(own)
      const projection = this.ctx.get('sessionProjections')
      const route = own.some(event => event.type === 'model/selection')
        ? projection?.restore({}, stored.events, SessionLogOffset(0), stored.meta, stored.inheritedEventCount).snapshot.values.modelSelection?.next
        : foldRequestHeader(own)?.config ?? (descriptor?.mode === 'continuable' && descriptor.agentProvider !== undefined && descriptor.agentModel !== undefined
          ? { provider: descriptor.agentProvider, model: descriptor.agentModel } : undefined)
      let model = base.model
      if (route !== null && route !== undefined) {
        const routeSource = source('session-model-selection', { provider: route.provider, model: route.model }, observedAt)
        model = { ...routeSource, provider: route.provider, model: route.model, imageInput: 'unknown' }
        try {
          const info = await this.ctx.llm.resolveModelInfo(route.provider, route.model, signal)
          model = { ...model, version: digest({ route: { provider: route.provider, model: route.model }, inputModalities: info.inputModalities }),
            imageInput: info.inputModalities === undefined ? 'unknown' : info.inputModalities.includes('image') ? 'supported' : 'unsupported' }
        } catch { model = { ...model, reason: 'model-metadata-unavailable' } }
      }
      let catalog = base.skills.catalog, tools = base.tools
      if (live !== undefined && this.ctx.agents.get(live.id) === live && this.ctx.sessions.get(live.id) === live.session) {
        const schemas = this.ctx.tools.schemas(live)
        const names = schemas.map(schema => schema.name).toSorted()
        const policy = this.ctx.get('agentSwarmPermission')?.directoryPolicy(role, names)
        const entries = names.map(name => {
          const teamPolicy = policy?.entries.find(row => row.name === name)?.decision ?? 'unknown' as const
          return { name, teamPolicy, state: teamPolicy === 'deny' ? 'disabled' as const
            : teamPolicy === 'ask' ? 'approval-required' as const : 'unknown' as const }
        })
        tools = { ...source('scoped-tool-registry-and-team-policy', { names, policy }, observedAt),
          reason: 'argument-dependent-official-guards-not-evaluated', complete: false, entries }
        const skills = this.skillsOf()
        if (skills !== undefined) {
          try {
            const snapshot = await skills.snapshot({ cwd: scope, scope: live, signal })
            const found = snapshot.skills.filter(skill => isModelInvocable(skill) && (team.allowedSkills === undefined || team.allowedSkills.includes(skill.name)))
              .map(skill => ({ name: skill.name, description: skill.description })).toSorted((a, b) => a.name.localeCompare(b.name))
            const catalogEntries = found.map(skillSummary)
            catalog = { ...source('scoped-skill-registry', found, observedAt), state: snapshot.complete ? 'available' : 'unknown',
              ...(snapshot.complete ? {} : { reason: 'incomplete-discovery' }), entries: catalogEntries }
          } catch { catalog = emptySkills('scoped-skill-registry', 'inspection-failed', observedAt) }
        }
      }
      const visible = sessionSkills(own, observedAt)
      const descriptions = new Map([...visible.entries, ...catalog.entries].map(skill => [skill.name, skill]))
      const assignedSet = { ...base.skills.assigned, entries: base.skills.assigned.entries.map(skill => {
        return { ...skill, ...descriptions.get(skill.name) }
      }) }
      return { ...base, model, tools, skills: { assigned: assignedSet, sessionVisible: visible, catalog } }
    } catch { return base }
  }
}
