/**
 * Scoped, read-only projection of Team task execution.
 *
 * This is intentionally NOT an implementation of the official `JobRegistry`:
 * that Provider contract owns producer admission, cancellation, controller
 * coverage, owner cleanup, and teardown settlement. A Team task projection
 * owns none of those resources. TeamDomainPort remains the only authority for
 * all task mutation. See docs/development/2026-08-27-jobs-scope-owner-fix-design.md.
 * @module dsh-agent-swarm/runtime/jobs/team-job-projection
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { JobId } from '@deepseek-ai/dsh-jobs'
import type { JobId as JobIdType, JobSnapshot } from '@deepseek-ai/dsh-jobs'
import { TeamDomainError } from '../../domain/error.js'
import type { TeamState } from '../../domain/types.js'
import type { TeamScope } from '../../domain/team-domain-port.js'
import { TEAM_DOMAIN_NAME } from '../../storage/team-spec.js'
import type { AgentSwarmRuntime } from '../orchestrator-runtime.js'
import { deriveTeamJobs, isTerminalStatus, TEAM_TASK_JOB_KIND } from './projection-derive.js'
import type { DerivedTeamJob } from './projection-derive.js'

/** Mutable, process-local record. It never owns or controls the Team task. */
interface ProjectedJob {
  readonly id: JobIdType
  readonly scope: TeamScope
  readonly teamId: string
  readonly taskId: string
  label: string
  status: JobSnapshot['status']
  detail: string
  startedAt: number
  finishedAt: number | undefined
}

/** Minimal structural check of one post-durability teams-table event. */
function isTeamEnvelope(value: unknown): value is { workspace: TeamScope; team: TeamState } {
  if (typeof value !== 'object' || value === null) return false
  const record = value as { workspace?: unknown; team?: unknown }
  if (typeof record.workspace !== 'string') return false
  const team = record.team
  if (typeof team !== 'object' || team === null) return false
  const candidate = team as Partial<TeamState>
  return typeof candidate.id === 'string'
    && typeof candidate.revision === 'number'
    && Array.isArray(candidate.members)
    && Array.isArray(candidate.tasks)
    && Array.isArray(candidate.attempts)
}

/**
 * A caller-authorized read view over durable Team aggregates.
 *
 * The only exported operation is `list(caller)`. Its required live Agent
 * identity is the authorization boundary; it returns fresh snapshots for the
 * one Team that the latest durable aggregate authorizes that caller to read.
 */
export class TeamJobProjection {
  private readonly records = new Map<JobIdType, ProjectedJob>()
  private readonly recordByTask = new Map<string, JobIdType>()
  private readonly derivedRevision = new Map<string, number>()
  private readonly teams = new Map<string, TeamState>()
  private readonly watchedScopes = new Set<TeamScope>()
  private readonly scopeSeeds = new Map<TeamScope, Promise<void>>()
  private counter = 0
  private stopListening: (() => void) | undefined
  private closing = false

  constructor(
    private readonly ctx: Context,
    private readonly runtime: AgentSwarmRuntime,
  ) {}

  /** Subscribe to post-durability aggregate changes. */
  async activate(): Promise<void> {
    if (this.closing) throw new Error('Team job projection is disposing')
    this.stopListening = this.ctx.on('domain/changed', change => {
      if (this.closing) return
      if (change.domain !== TEAM_DOMAIN_NAME || change.table !== 'teams' || change.operation !== 'put') return
      if (!isTeamEnvelope(change.value)) {
        this.ctx.logger.warn('agent-swarm jobs projection: ignoring an unreadable teams-table change payload')
        return
      }
      const scope = change.value.workspace
      if (!this.watchedScopes.has(scope)) return
      this.projectTeam(scope, change.value.team)
    })
  }

  /**
   * Latch and seed one workspace scope. This is projection recovery only;
   * caller authorization remains mandatory for every read.
   */
  watchScope(scope: TeamScope): Promise<void> {
    if (this.closing) return Promise.resolve()
    this.watchedScopes.add(scope)
    const seeded = this.scopeSeeds.get(scope)
    if (seeded !== undefined) return seeded
    const seed = (async () => {
      const teams = await this.runtime.listTeamAggregates(scope)
      if (this.closing) return
      for (const team of teams) this.projectTeam(scope, team)
    })()
    this.scopeSeeds.set(scope, seed)
    void seed.catch(error => {
      this.scopeSeeds.delete(scope)
      this.ctx.logger.warn(`agent-swarm jobs projection: scope seed failed for ${scope}: ${String(error)}`)
    })
    return seed
  }

  /**
   * Return fresh snapshots for exactly the caller's authorized Team.
   * Missing, stale, unjoined, or ambiguous callers fail before any record is
   * selected; a process-global list is deliberately unavailable.
  */
  list(caller: Agent): JobSnapshot[] {
    const { scope, teamId } = this.authorize(caller)
    if (this.closing) return []
    return [...this.records.values()]
      .filter(job => job.scope === scope && job.teamId === teamId)
      .map(job => this.snapshot(job))
  }

  /** Stop observing and drop only derived state; no Team task is settled. */
  async dispose(): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.stopListening?.()
    this.stopListening = undefined
    this.records.clear()
    this.recordByTask.clear()
    this.derivedRevision.clear()
    this.teams.clear()
    this.scopeSeeds.clear()
  }

  /** Reconcile one scope-qualified aggregate snapshot. */
  private projectTeam(scope: TeamScope, team: TeamState): void {
    const key = teamKey(scope, team.id)
    const last = this.derivedRevision.get(key)
    if (last !== undefined && team.revision <= last) return
    this.derivedRevision.set(key, team.revision)
    this.teams.set(key, team)
    for (const derived of deriveTeamJobs(team)) {
      const task = taskKey(scope, team.id, derived.taskId)
      const existingId = this.recordByTask.get(task)
      if (existingId === undefined) {
        this.registerRecord(scope, team.id, derived)
        continue
      }
      const job = this.records.get(existingId)
      if (job === undefined) continue
      if (!isTerminalStatus(job.status) && isTerminalStatus(derived.status)) this.settleRecord(job, derived)
    }
  }

  private registerRecord(scope: TeamScope, teamId: string, derived: DerivedTeamJob): void {
    this.counter += 1
    const id = JobId(`${TEAM_TASK_JOB_KIND}-${this.counter}`)
    const job: ProjectedJob = {
      id,
      scope,
      teamId,
      taskId: derived.taskId,
      label: derived.label,
      status: derived.status,
      detail: derived.detail,
      startedAt: derived.startedAt,
      finishedAt: derived.finishedAt,
    }
    this.records.set(id, job)
    this.recordByTask.set(taskKey(scope, teamId, derived.taskId), id)
  }

  private settleRecord(job: ProjectedJob, derived: DerivedTeamJob): void {
    job.status = derived.status
    job.detail = derived.detail
    job.label = derived.label
    job.finishedAt = derived.finishedAt
  }

  /** Derive one Team read authority from an exact live Agent identity. */
  private authorize(caller: Agent | undefined): { scope: TeamScope; teamId: string } {
    if (caller === undefined || this.ctx.agents.get(SessionId(caller.id)) !== caller) {
      throw new TeamDomainError(
        'the jobs projection requires the exact live Agent caller; anonymous or stale callers are not authorized',
        'TEAM_JOBS_CALLER_REQUIRED',
      )
    }
    const scope = this.runtime.scopeOf(caller)
    const teams = [...this.teams.entries()]
      .filter(([key]) => key.startsWith(`${scope}\n`))
      .map(([, team]) => team)
    const active = teams.filter(team => team.phase === 'active' && (
      team.captainSessionId === caller.id
      || team.members.some(member => member.sessionId === caller.id && member.phase === 'active')
    ))
    if (active.length > 1) throw membershipAmbiguous(caller.id, active)
    if (active.length === 1) return { scope, teamId: active[0]!.id }
    const archived = teams.filter(team => team.phase !== 'active' && team.captainSessionId === caller.id)
    if (archived.length > 1) throw membershipAmbiguous(caller.id, archived)
    if (archived.length === 1) return { scope, teamId: archived[0]!.id }
    throw new TeamDomainError('caller is not an active participant or archived captain in the watched Team scope', 'TEAM_NOT_JOINED')
  }

  private snapshot(job: ProjectedJob): JobSnapshot {
    return {
      id: job.id,
      kind: TEAM_TASK_JOB_KIND,
      label: job.label,
      status: job.status,
      ...(job.detail === '' ? {} : { detail: job.detail }),
      startedAt: job.startedAt,
      ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
      // The Team view is not an official owned job. Omit ownerSession rather
      // than assigning a false producer identity.
      reported: false,
    }
  }
}

function membershipAmbiguous(sessionId: string, teams: readonly TeamState[]): TeamDomainError {
  return new TeamDomainError(
    `session "${sessionId}" belongs to multiple readable teams: ${teams.map(team => team.id).join(', ')}`,
    'TEAM_MEMBERSHIP_AMBIGUOUS',
  )
}

function teamKey(scope: TeamScope, teamId: string): string {
  return `${scope}\n${teamId}`
}

function taskKey(scope: TeamScope, teamId: string, taskId: string): string {
  return `${scope}\n${teamId}\n${taskId}`
}
