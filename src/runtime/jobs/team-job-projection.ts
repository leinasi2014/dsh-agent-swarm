/**
 * The Team bridge job registry (M2-2, issue #76): an implementation of the
 * official abstract `JobRegistry` whose records are a READ-ONLY projection
 * of the authoritative Team task board (design note:
 * docs/development/2026-08-21-m2b-jobs-bridge-design.md).
 *
 * Registration posture: the official base class hardcodes the `jobs` service
 * name and Cordis rejects a second same-scope registration, so this registry
 * is constructed on `ctx.isolate('jobs')` — the official mechanism for a
 * different implementation beside the default-scope one. The default scope's
 * `ctx.jobs` (the official local registry, when composed) is never taken
 * over.
 *
 * Projection discipline (red line, issue #76): the Team aggregate in the
 * `agent_swarm` storage domain is the ONLY authority. Records are derived
 * from post-durability `domain/changed` snapshots and from explicit scope
 * seeds; `start()` and `kill()` — the job face's two write paths — refuse
 * work so no caller can create or cancel Team state through the job face.
 * There is no projection storage: a rebuilt process re-derives identical
 * records from the aggregate.
 * @module dsh-agent-swarm/runtime/jobs/team-job-projection
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { JobId, JobRegistry } from '@deepseek-ai/dsh-jobs'
import type {
  JobDoneListener,
  JobId as JobIdType,
  JobRead,
  JobSnapshot,
  JobStart,
  JobsChangedListener,
} from '@deepseek-ai/dsh-jobs'
import type { TeamState } from '../../domain/types.js'
import type { TeamScope } from '../../domain/team-domain-port.js'
import { TEAM_DOMAIN_NAME } from '../../storage/team-spec.js'
import type { AgentSwarmRuntime } from '../orchestrator-runtime.js'
import { deriveTeamJobs, isTerminalStatus, TEAM_TASK_JOB_KIND } from './projection-derive.js'
import type { DerivedTeamJob } from './projection-derive.js'

/** Job status vocabulary alias for the mutable record. */
type ProjectedJobStatus = JobSnapshot['status']

/** The mutable projection record — never handed out live (see {@link snapshot}). */
interface ProjectedJob {
  readonly id: JobIdType
  readonly teamId: string
  readonly taskId: string
  label: string
  status: ProjectedJobStatus
  detail: string
  output: string
  startedAt: number
  finishedAt: number | undefined
  reported: boolean
  /** Live waits; settlement with a waiter marks the record reported. */
  waiters: number
  /** Removable waiter continuations; settlement or disposal releases them. */
  waitersPending: Set<(error: unknown) => void>
}

/** Minimal structural check of a `domain/changed` put value for the teams table. */
function isTeamEnvelope(value: unknown): value is { workspace: string; team: TeamState } {
  if (typeof value !== 'object' || value === null) return false
  const record = value as { workspace?: unknown; team?: unknown }
  if (typeof record.workspace !== 'string') return false
  const team = record.team
  if (typeof team !== 'object' || team === null) return false
  const candidate = team as Partial<TeamState>
  return typeof candidate.id === 'string'
    && typeof candidate.revision === 'number'
    && Array.isArray(candidate.tasks)
    && Array.isArray(candidate.attempts)
}

/** The read-only Team projection over the official `ctx.jobs` seam. */
export class TeamJobProjection extends JobRegistry {
  private readonly runtime: AgentSwarmRuntime
  private readonly records = new Map<JobIdType, ProjectedJob>()
  /** Locates one task's record across re-derived snapshots. */
  private readonly recordByTask = new Map<string, JobIdType>()
  /** Highest Team revision already projected (stale-snapshot guard). */
  private readonly derivedRevision = new Map<string, number>()
  private readonly watchedScopes = new Set<TeamScope>()
  private readonly scopeSeeds = new Map<TeamScope, Promise<void>>()
  private counter = 0
  private readonly doneListeners = new Set<JobDoneListener>()
  private readonly changedListeners = new Set<JobsChangedListener>()
  private controllerCount = 0
  private stopListening: (() => void) | undefined
  private closing = false

  constructor(ctx: Context, runtime: AgentSwarmRuntime) {
    super(ctx)
    this.runtime = runtime
  }

  /**
   * The isolated `jobs`-scope context this registry serves. Official
   * companions whose installers `inject: ['jobs']` (the
   * `@deepseek-ai/dsh-jobs/invariant` checker) must be composed under this
   * context — and under an invariants service mounted here — so their `jobs`
   * resolution reaches the projection instead of the default scope.
   */
  get bridgeContext(): Context {
    return this.ctx
  }

  /**
   * Subscribe to the authoritative aggregate's post-durability change
   * events. Fail closed on a disposing registry; the subscription itself is
   * the projection's only live resource.
   */
  async activate(): Promise<void> {
    if (this.closing) throw new Error('Team job projection is disposing')
    this.stopListening = this.ctx.on('domain/changed', change => {
      if (this.closing) return
      if (change.domain !== TEAM_DOMAIN_NAME || change.table !== 'teams' || change.operation !== 'put') return
      if (!isTeamEnvelope(change.value)) {
        this.ctx.logger.warn('agent-swarm jobs bridge: ignoring an unreadable teams-table change payload')
        return
      }
      if (!this.watchedScopes.has(change.value.workspace)) return
      this.projectTeam(change.value.team)
    })
  }

  /**
   * Watch one workspace scope: latch it synchronously (so no interleaved
   * change is missed), then seed the projection from every aggregate the
   * scope currently holds. Seeding is best-effort — a failing seed logs and
   * un-latches its promise so a later call can retry; live changes keep
   * flowing either way. This is also the crash-recovery entry point: a
   * rebuilt process re-derives identical records from the durable aggregate.
   */
  watchScope(scope: TeamScope): Promise<void> {
    if (this.closing) return Promise.resolve()
    this.watchedScopes.add(scope)
    const seeded = this.scopeSeeds.get(scope)
    if (seeded !== undefined) return seeded
    const seed = (async () => {
      const teams = await this.runtime.listTeamAggregates(scope)
      if (this.closing) return
      for (const team of teams) this.projectTeam(team)
    })()
    this.scopeSeeds.set(scope, seed)
    void seed.catch(error => {
      this.scopeSeeds.delete(scope)
      this.ctx.logger.warn(`agent-swarm jobs bridge: scope seed failed for ${scope}: ${String(error)}`)
    })
    return seed
  }

  // ---- Official abstract surface -----------------------------------------

  /** Refused: the job face never creates authoritative Team work (red line). */
  start(spec: JobStart): JobIdType {
    void spec
    throw new Error(
      'the Team bridge job registry is a read-only projection: create Team tasks through the Team face (agent_swarm_create_task / TeamDomainPort.createTask)',
    )
  }

  list(caller?: Agent): JobSnapshot[] {
    void caller
    if (this.closing) return []
    return [...this.records.values()].map(job => this.snapshot(job))
  }

  get(id: JobIdType, caller?: Agent): JobSnapshot {
    void caller
    return this.snapshot(this.expect(id))
  }

  read(id: JobIdType, caller?: Agent): JobRead {
    void caller
    const job = this.expect(id)
    const text = isTerminalStatus(job.status) ? job.output : ''
    if (isTerminalStatus(job.status)) job.reported = true
    return { text, snapshot: this.snapshot(job) }
  }

  /** Refused: cancelling Team work is a captain decision on the Team face (red line). */
  kill(id: JobIdType, caller?: Agent, reason?: string): 'requested' | 'already-finished' {
    void id; void caller; void reason
    throw new Error(
      'the Team bridge job registry is a read-only projection: cancel work through the Team face (TeamDomainPort.cancelAttempt by the captain)',
    )
  }

  async wait(id: JobIdType, timeoutMs: number, caller?: Agent, signal?: AbortSignal): Promise<JobSnapshot> {
    void caller
    const job = this.expect(id)
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`invalid wait timeout: expected a positive number of milliseconds, got ${JSON.stringify(timeoutMs)}`)
    }
    if (!isTerminalStatus(job.status)) {
      if (signal?.aborted) throw new Error('wait aborted')
      job.waiters += 1
      let counted = true
      const uncount = (): void => {
        if (!counted) return
        counted = false
        job.waiters -= 1
      }
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { cleanup(); resolve() }, timeoutMs)
          const onAbort = (): void => {
            cleanup()
            // Settlement releases its waiters before announcing, so a live
            // abort here cannot race a settlement this wait already owed.
            if (isTerminalStatus(job.status)) resolve()
            else reject(new Error('wait aborted'))
          }
          const cleanup = (): void => {
            clearTimeout(timer)
            signal?.removeEventListener('abort', onAbort)
            job.waitersPending.delete(release)
          }
          const release = (error: unknown): void => {
            cleanup()
            if (error === undefined) resolve()
            else reject(error)
          }
          job.waitersPending.add(release)
          signal?.addEventListener('abort', onAbort, { once: true })
        })
      } finally {
        uncount()
      }
    }
    if (isTerminalStatus(job.status)) job.reported = true
    return this.snapshot(job)
  }

  onJobDone(listener: JobDoneListener): () => void {
    this.doneListeners.add(listener)
    return this.ctx.effect(() => () => { this.doneListeners.delete(listener) }, 'team job projection: onJobDone')
  }

  onJobsChanged(listener: JobsChangedListener): () => void {
    this.changedListeners.add(listener)
    return this.ctx.effect(() => () => { this.changedListeners.delete(listener) }, 'team job projection: onJobsChanged')
  }

  attachController(name: string): () => void {
    void name
    this.controllerCount += 1
    return this.ctx.effect(() => () => { this.controllerCount -= 1 }, 'team job projection: attachController')
  }

  /**
   * Stop projecting: unsubscribe, reject live waiters, drop every record and
   * announce the emptied visible set (official disposal-notification
   * semantics). Records are NOT settled — the authoritative Team may outlive
   * the bridge, and a projection must not pronounce terminal outcomes the
   * authority has not. Idempotent.
   */
  async dispose(): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.stopListening?.()
    this.stopListening = undefined
    const emptied = this.records.size > 0
    for (const job of this.records.values()) {
      // Array.from snapshots the set: releasing a waiter unregisters itself.
      for (const release of Array.from(job.waitersPending)) release(new Error('team job projection disposed'))
      job.waitersPending.clear()
    }
    this.records.clear()
    this.recordByTask.clear()
    this.derivedRevision.clear()
    this.scopeSeeds.clear()
    this.doneListeners.clear()
    this.changedListeners.clear()
    if (emptied) this.notifyChanged()
  }

  // ---- Derivation and reconciliation --------------------------------------

  /** Reconcile one authoritative aggregate snapshot into the projection. */
  private projectTeam(team: TeamState): void {
    const last = this.derivedRevision.get(team.id)
    if (last !== undefined && team.revision <= last) return
    this.derivedRevision.set(team.id, team.revision)
    for (const derived of deriveTeamJobs(team)) {
      const key = taskKey(team.id, derived.taskId)
      const existingId = this.recordByTask.get(key)
      if (existingId === undefined) {
        this.registerRecord(team.id, derived)
        continue
      }
      const job = this.records.get(existingId)
      if (job === undefined) continue
      if (!isTerminalStatus(job.status) && isTerminalStatus(derived.status)) {
        this.settleRecord(job, derived)
      }
      // Live stays live (attempt generations and review-reject requeues are
      // internal); terminal stays terminal (first-wins).
    }
  }

  /** Register one derived record. A rebuild-terminal record registers silently. */
  private registerRecord(teamId: string, derived: DerivedTeamJob): void {
    this.counter += 1
    const id = JobId(`${TEAM_TASK_JOB_KIND}-${this.counter}`)
    const job: ProjectedJob = {
      id,
      teamId,
      taskId: derived.taskId,
      label: derived.label,
      status: derived.status,
      detail: derived.detail,
      output: derived.output,
      startedAt: derived.startedAt,
      finishedAt: derived.finishedAt,
      reported: false,
      waiters: 0,
      waitersPending: new Set(),
    }
    this.records.set(id, job)
    this.recordByTask.set(taskKey(teamId, derived.taskId), id)
    this.notifyChanged()
  }

  /**
   * First-wins settlement of one observed live→terminal transition: record
   * the outcome, release waiters, announce the visible-set change, then
   * deliver contained completion notices (the official ordering — every
   * other observer sees the committed record before a reporter can react).
   */
  private settleRecord(job: ProjectedJob, derived: DerivedTeamJob): void {
    job.status = derived.status
    job.detail = derived.detail
    job.output = derived.output
    job.finishedAt = derived.finishedAt ?? Date.now()
    job.label = derived.label
    if (job.waiters > 0) job.reported = true
    const snapshot = this.snapshot(job)
    // Array.from snapshots the set: releasing a waiter unregisters itself.
    for (const release of Array.from(job.waitersPending)) release(undefined)
    job.waitersPending.clear()
    this.notifyChanged()
    if (this.closing) return
    for (const listener of this.doneListeners) {
      try {
        const returned = listener(snapshot, undefined)
        void Promise.resolve(returned).catch(error => {
          this.ctx.logger.warn(`agent-swarm jobs bridge: onJobDone listener rejected for ${job.id}: ${String(error)}`)
        })
      } catch (error: unknown) {
        this.ctx.logger.warn(`agent-swarm jobs bridge: onJobDone listener threw for ${job.id}: ${String(error)}`)
      }
    }
  }

  // ---- Contained helpers ---------------------------------------------------

  /** Look up one record or fail loud (unknown ids are caller errors). */
  private expect(id: JobIdType): ProjectedJob {
    const job = this.records.get(id)
    if (job === undefined) throw new Error(`unknown job ${id}`)
    return job
  }

  /** Project a fresh read-only snapshot from the mutable record. */
  private snapshot(job: ProjectedJob): JobSnapshot {
    return {
      id: job.id,
      kind: TEAM_TASK_JOB_KIND,
      label: job.label,
      status: job.status,
      ...job.detail !== '' ? { detail: job.detail } : {},
      startedAt: job.startedAt,
      ...job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {},
      reported: job.reported,
    }
  }

  /** Announce a visible-set change; every listener is contained. */
  private notifyChanged(): void {
    for (const listener of this.changedListeners) {
      try {
        listener(undefined)
      } catch (error: unknown) {
        this.ctx.logger.warn(`agent-swarm jobs bridge: onJobsChanged listener threw: ${String(error)}`)
      }
    }
  }
}

/** Composite key of one task's projection slot. */
function taskKey(teamId: string, taskId: string): string {
  return `${teamId}\n${taskId}`
}
