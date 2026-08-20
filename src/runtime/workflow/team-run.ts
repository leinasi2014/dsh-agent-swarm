/**
 * One Team-backed workflow run (M2-1, issue #75): the official
 * `WorkflowRun` handle whose lifecycle IS a Team lifecycle.
 *
 * `start` creates and assembles the Team (captain = the request parent);
 * each `agent()` call drives the full Team protocol (member provisioning,
 * task creation, scheduler assignment, member submission, captain review);
 * the event stream projects Team state onto the official `workflow/*` events;
 * cancellation and failure settle bounded with synthesized agent ends; the
 * durable run overlay (`agent_swarm_workflow` domain) is the ONLY run truth —
 * no official run storage exists for a Team-started run (planning-note trap
 * 1). Mapping table and line-cited evidence:
 * docs/development/2026-08-21-m2a-workflow-bridge-design.md §2.
 * @module dsh-agent-swarm/runtime/workflow/team-run
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkflowError, WorkflowRunId } from '@deepseek-ai/dsh-workflow'
import type {
  WorkflowEventName,
  WorkflowMeta,
  WorkflowResult,
  WorkflowRun,
  WorkflowRunInfo,
} from '@deepseek-ai/dsh-workflow'
import { TeamDomainError } from '../../domain/error.js'
import type { TeamDomainPort, TeamScope } from '../../domain/team-domain-port.js'
import { TeamId, type TeamStatusSnapshot } from '../../domain/types.js'
import type { AgentSwarmRuntime } from '../orchestrator-runtime.js'
import type { WorkflowRunOverlayStore } from '../../storage/workflow-run-overlay.js'
import type { AgentCall, AgentCallOutcome, ExecutorLimits } from './script-executor.js'
import { BridgeScriptExecution } from './script-executor.js'

/** Dependencies one run needs from its engine. */
export interface TeamRunDeps {
  readonly ctx: Context
  readonly runtime: AgentSwarmRuntime
  readonly overlay: WorkflowRunOverlayStore
  /** Contained event dispatch (the engine's protected helper). */
  readonly emitEvent: (name: WorkflowEventName, ...args: unknown[]) => void
  readonly limits: ExecutorLimits
  /** Cancellation grace: an unsettled cancelled run force-settles after this. */
  readonly disposeGraceMs: number
  /** Bound for every Team teardown settlement step (runtime disposal bound). */
  readonly disposalTimeoutMs: number
  /** The resolved member provider for this run. */
  readonly provider: string
  readonly maxTotalAgents: number
  /** The caller's cancel signal from the start request. */
  readonly signal?: AbortSignal
}

/** Team task terminal statuses. */
const TERMINAL_TASK = new Set(['completed', 'failed', 'cancelled'])

/** A plain timer sleep; unref'd so it never holds the process open. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}

/**
 * The live Team-backed run returned by the bridge engine's `start()`. Owns the
 * Team aggregate, the script execution, the agent-event pairing ledger and
 * the overlay commits; `result` never rejects.
 */
export class TeamRun implements WorkflowRun {
  readonly id = WorkflowRunId(randomUUID())
  readonly result: Promise<WorkflowResult>
  private settleResolve!: (result: WorkflowResult) => void
  private settled = false
  /** A terminal source claimed settlement before its cleanup callbacks. */
  private terminalClaimed = false
  private cancelReason: string | undefined
  private graceTimer: ReturnType<typeof setTimeout> | undefined
  private disposed: Promise<void> | undefined
  private executor: BridgeScriptExecution | undefined
  private teamId: string | undefined
  private readonly controller = new AbortController()
  /** Started-but-unended agents by seq — the exactly-once pairing ledger. */
  private readonly liveAgents = new Map<number, { label: string; phase?: string; childId: string }>()
  /** In-flight agent driver calls (member quiescence for dispose). */
  private readonly inflight = new Set<Promise<unknown>>()
  private inputSignal: AbortSignal | undefined
  private inputSignalAbort: (() => void) | undefined
  private archived = false
  private readonly scope: TeamScope
  private readonly info: WorkflowRunInfo

  constructor(
    private readonly deps: TeamRunDeps,
    readonly meta: WorkflowMeta,
    private readonly script: string,
    private readonly args: unknown,
    private readonly parent: Agent,
  ) {
    this.result = new Promise<WorkflowResult>(resolve => { this.settleResolve = resolve })
    this.scope = deps.runtime.scopeOf(parent)
    this.info = { id: this.id, meta }
    if (deps.signal?.aborted) {
      this.cancel('workflow start signal already aborted')
    } else if (deps.signal !== undefined) {
      const onAbort = (): void => {
        this.detachInputSignal()
        this.cancel('workflow signal aborted')
      }
      this.inputSignal = deps.signal
      this.inputSignalAbort = onAbort
      deps.signal.addEventListener('abort', onAbort, { once: true })
    }
  }

  private get domain(): TeamDomainPort {
    return this.deps.runtime.domain
  }

  /** The Team backing this run; set before the script executes. */
  private requireTeamId(): TeamId {
    if (this.teamId === undefined) {
      throw new WorkflowError('workflow run has no Team aggregate', 'AGENT_RESULT')
    }
    return TeamId(this.teamId)
  }

  /**
   * Async begin: create the Team, commit the running overlay record, THEN
   * publish `workflow/start` (authoritative commit precedes publication),
   * execute the script and settle. Never rejects; every failure settles the
   * run instead.
   */
  begin(): void {
    void (async () => {
      let teamId: string
      try {
        const team = await this.deps.runtime.create(
          { agent: this.parent, signal: this.controller.signal },
          this.meta.name,
          this.meta.description,
        )
        teamId = team.id
        this.teamId = teamId
        await this.deps.overlay.put({
          schemaVersion: 1,
          runId: this.id,
          teamId,
          scope: this.scope,
          meta: { name: this.meta.name, description: this.meta.description },
          state: 'running',
          agentsStarted: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
      } catch (error: unknown) {
        // The run cannot even establish its authoritative state: settle error
        // without ever publishing workflow/start (nothing was published).
        this.settle({ value: null, stopReason: 'error', error: `Team bridge could not establish the run: ${String(error)}`, agentsStarted: 0 })
        return
      }
      if (this.cancelReason !== undefined) {
        this.settle(this.cancelledResult(0))
        return
      }
      this.deps.emitEvent('workflow/start', this.info)
      const executor = new BridgeScriptExecution(
        this.meta,
        this.script,
        this.args,
        this.deps.limits,
        {
          phase: title => { this.deps.emitEvent('workflow/phase', this.info, title) },
          log: message => { this.deps.emitEvent('workflow/log', this.info, message) },
        },
        { drive: call => this.driveAgent(call) },
      )
      this.executor = executor
      const settled = await executor.drive()
      this.settle(settled)
    })()
  }

  /**
   * Cancel the run: the script dies at its next hook boundary, in-flight
   * member waits abort, and the grace timer arms — a run still unsettled
   * `disposeGraceMs` later force-settles `cancelled` with synthesized agent
   * ends. Idempotent; the first reason wins.
   * @param reason - human-readable cause (default `'workflow cancelled'`).
   */
  cancel(reason?: string): void {
    if (this.settled || this.terminalClaimed || this.cancelReason !== undefined) return
    this.cancelReason = reason ?? 'workflow cancelled'
    this.executor?.cancel(this.cancelReason)
    this.controller.abort(this.cancelReason)
    this.graceTimer = setTimeout(() => {
      this.terminalClaimed = true
      // The script can no longer speak: pair every stranded start before the
      // run settles, so ends precede workflow/end.
      this.endStrandedAgents()
      this.settle(this.cancelledResult(this.executor?.startedCount ?? 0))
    }, this.deps.disposeGraceMs)
    this.graceTimer.unref()
  }

  /**
   * Cancel + bounded settle + Team teardown. Waits (at most the grace) for
   * the result and member quiescence, then archives the Team within the
   * disposal bound. Idempotent; safe on every path.
   * @returns resolves when the run's resources are released or abandoned.
   */
  dispose(): Promise<void> {
    const existing = this.disposed
    if (existing !== undefined) return existing
    let claimedResolve!: () => void
    let claimedReject!: (error: unknown) => void
    const claimed = new Promise<void>((resolve, reject) => {
      claimedResolve = resolve
      claimedReject = reject
    })
    this.disposed = claimed
    void (async () => {
      this.detachInputSignal()
      this.cancel('workflow disposed')
      await Promise.race([
        (async () => {
          await this.result
          // Array.from snapshots the set: a settling call removes itself in its finally.
          await Promise.allSettled(Array.from(this.inflight))
        })(),
        sleep(this.deps.disposeGraceMs),
      ])
      await this.archiveBounded('workflow disposed')
    })().then(
      () => { claimedResolve() },
      /* v8 ignore next -- every branch above is contained */
      error => { claimedReject(error) },
    )
    return claimed
  }

  /** The single agent-end emission gate: exactly one end per emitted start. */
  private endAgent(seq: number, outcome: 'completed' | 'failed' | 'cancelled'): void {
    const info = this.liveAgents.get(seq)
    if (info === undefined) return
    this.liveAgents.delete(seq)
    this.deps.emitEvent('workflow/agent-end', this.info, { seq, ...info, outcome })
  }

  /** Synthesize the missing `cancelled` end for every stranded started agent. */
  private endStrandedAgents(): void {
    // Array.from snapshots the ledger: endAgent deletes entries while iterating.
    for (const seq of Array.from(this.liveAgents.keys())) this.endAgent(seq, 'cancelled')
  }

  /**
   * Drive one admitted `agent()` call through the full Team protocol: member
   * provisioning (durable record first), publication (`workflow/agent-start`
   * after activation), task creation and scheduler assignment, the member's
   * submission, and the captain review gate. Emits the paired agent events;
   * a call that never reaches an activated member emits neither.
   */
  private async driveAgent(call: AgentCall): Promise<AgentCallOutcome> {
    const task = this.trackInflight((async () => {
      let memberSessionId: string
      try {
        const member = await this.deps.runtime.addMember(
          { agent: this.parent, signal: this.controller.signal },
          { name: `wf-agent-${call.seq}`, role: 'workflow agent', ...call.provider !== undefined ? { provider: call.provider } : {}, ...call.model !== undefined ? { model: call.model } : {} },
        )
        memberSessionId = member.sessionId
      } catch (error: unknown) {
        if (this.cancelReason !== undefined) throw new WorkflowError(`workflow run cancelled: ${this.cancelReason}`, 'CANCELLED')
        if (error instanceof TeamDomainError && error.code === 'TEAM_MEMBER_LIMIT') {
          throw new WorkflowError(
            `this run reached the Team member limit — the workflow agent cap backstop; raise the Team maxMembers limit if the scale is intentional`,
            'AGENT_CAP',
            { cause: error },
          )
        }
        throw error
      }
      // The member is published (activated): the call's identity is now real.
      this.liveAgents.set(call.seq, { label: call.label, ...call.phase !== undefined ? { phase: call.phase } : {}, childId: memberSessionId })
      this.deps.emitEvent('workflow/agent-start', this.info, {
        seq: call.seq,
        label: call.label,
        ...call.phase !== undefined ? { phase: call.phase } : {},
        childId: SessionId(memberSessionId),
      })
      return this.awaitTaskCompletion(call, memberSessionId)
    })())
    return await task
  }

  /** Create the call's task and follow it through the review gate to a terminal state. */
  private async awaitTaskCompletion(call: AgentCall, memberSessionId: string): Promise<AgentCallOutcome> {
    const exec = { agent: this.parent, signal: this.controller.signal }
    const created = await this.deps.runtime.createTask(exec, {
      subject: call.label,
      description: call.prompt,
      acceptanceCriteria: ['Complete the workflow agent prompt and submit concrete output.'],
    })
    try {
      let snapshot: TeamStatusSnapshot = await this.domain.snapshot(this.scope, this.requireTeamId(), this.parent.id)
      for (;;) {
        if (this.cancelReason !== undefined) throw new WorkflowError(`workflow run cancelled: ${this.cancelReason}`, 'CANCELLED')
        const task = snapshot.team.tasks.find(candidate => candidate.id === created.id)
        if (task === undefined) {
          this.endAgent(call.seq, 'failed')
          throw new WorkflowError(`workflow task ${created.id} disappeared from the Team aggregate`, 'AGENT_RESULT')
        }
        if (task.status === 'completed') {
          this.endAgent(call.seq, 'completed')
          return { outcome: 'completed', output: task.output ?? '' }
        }
        if (TERMINAL_TASK.has(task.status)) {
          this.endAgent(call.seq, 'failed')
          return { outcome: 'failed' }
        }
        if (task.status === 'submitted' || task.status === 'verifying') {
          const attemptId = task.currentAttemptId
          if (attemptId !== undefined) {
            try {
              await this.deps.runtime.reviewTask(exec, {
                taskId: task.id,
                expectedRevision: task.revision,
                attemptId,
                decision: 'accept',
                diagnostic: 'workflow bridge auto-accept',
              })
            } catch (error: unknown) {
              // A raced transition defers to the next observed change; a
              // review provider that rejects leaves the task to its own
              // terminal state on the next pass.
              if (!(error instanceof TeamDomainError && ['TEAM_TASK_STALE_REVISION', 'TEAM_ATTEMPT_STALE'].includes(error.code))) {
                this.deps.ctx.logger.warn(`agent-swarm workflow bridge: review failed for ${task.id}: ${String(error)}`)
              }
            }
          }
          snapshot = await this.domain.snapshot(this.scope, this.requireTeamId(), this.parent.id)
          continue
        }
        // pending / in_progress: wait for the next authoritative change.
        snapshot = await this.domain.waitForChange(
          this.scope, this.requireTeamId(), this.parent.id, snapshot.team.revision, this.controller.signal,
        )
      }
    } catch (error: unknown) {
      if (this.cancelReason !== undefined) {
        this.endAgent(call.seq, 'cancelled')
        await this.cancelTaskWorkBounded(created.id, memberSessionId)
        throw new WorkflowError(`workflow run cancelled: ${this.cancelReason}`, 'CANCELLED')
      }
      this.endAgent(call.seq, 'failed')
      throw error
    }
  }

  /** Bounded, best-effort cancellation of one call's task attempt and member turn. */
  private async cancelTaskWorkBounded(taskId: string, memberSessionId: string): Promise<void> {
    try {
      const snapshot = await Promise.race([
        this.domain.snapshot(this.scope, this.requireTeamId(), this.parent.id),
        sleep(this.deps.disposalTimeoutMs),
      ])
      if (snapshot === undefined) return
      const task = snapshot.team.tasks.find(candidate => candidate.id === taskId)
      if (task !== undefined && ['in_progress', 'submitted', 'verifying'].includes(task.status)) {
        await this.domain.cancelAttempt(this.scope, this.requireTeamId(), this.parent.id, task.id, task.revision, `workflow run cancelled: ${this.cancelReason ?? 'workflow cancelled'}`)
      }
    } catch (error: unknown) {
      this.deps.ctx.logger.warn(`agent-swarm workflow bridge: task cancel failed for ${taskId}: ${String(error)}`)
    }
    try {
      this.deps.ctx.subagents.interrupt(SessionId(memberSessionId), { kind: 'ancestor', agent: this.parent })
    } catch (error: unknown) {
      this.deps.ctx.logger.warn(`agent-swarm workflow bridge: member interrupt failed for ${memberSessionId}: ${String(error)}`)
    }
  }

  /** Track one in-flight driver call for member-quiescence disposal. */
  private async trackInflight<T>(operation: Promise<T>): Promise<T> {
    this.inflight.add(operation)
    try {
      return await operation
    } finally {
      this.inflight.delete(operation)
    }
  }

  /** Archive the Team within the disposal bound; idempotent and best-effort. */
  private async archiveBounded(reason: string): Promise<void> {
    if (this.archived || this.teamId === undefined) return
    this.archived = true
    try {
      await Promise.race([
        this.deps.runtime.archive({ agent: this.parent, signal: AbortSignal.timeout(this.deps.disposalTimeoutMs) }, `workflow run ${this.id}: ${reason}`),
        sleep(this.deps.disposalTimeoutMs),
      ])
    } catch (error: unknown) {
      this.deps.ctx.logger.warn(`agent-swarm workflow bridge: team archive failed for ${this.teamId}: ${String(error)}`)
    }
  }

  private cancelledResult(agentsStarted: number): WorkflowResult {
    const reason = this.cancelReason ?? 'workflow cancelled'
    return { value: null, stopReason: 'cancelled', error: `workflow run cancelled: ${reason}`, agentsStarted }
  }

  /** Remove the exact abort callback installed on the caller's start signal. */
  private detachInputSignal(): void {
    const signal = this.inputSignal
    const onAbort = this.inputSignalAbort
    if (signal === undefined || onAbort === undefined) return
    this.inputSignal = undefined
    this.inputSignalAbort = undefined
    signal.removeEventListener('abort', onAbort)
  }

  /**
   * First settle wins: commit the terminal overlay record durably, publish
   * `workflow/end` (exactly once), then release the holder's result.
   */
  private settle(result: WorkflowResult): void {
    if (this.settled) return
    this.terminalClaimed = true
    this.settled = true
    this.detachInputSignal()
    if (this.graceTimer !== undefined) clearTimeout(this.graceTimer)
    const teamId = this.teamId
    void (async () => {
      if (teamId !== undefined) {
        try {
          const previous = this.deps.overlay.get(this.id)
          await this.deps.overlay.put({
            schemaVersion: 1,
            runId: this.id,
            teamId,
            scope: this.scope,
            meta: { name: this.meta.name, description: this.meta.description },
            state: result.stopReason === 'completed' ? 'completed' : result.stopReason === 'cancelled' ? 'cancelled' : 'error',
            stopReason: result.stopReason,
            ...result.error !== undefined ? { error: result.error } : {},
            agentsStarted: result.agentsStarted,
            createdAt: previous?.createdAt ?? Date.now(),
            updatedAt: Date.now(),
            settledAt: Date.now(),
          })
        } catch (error: unknown) {
          // The overlay is the only run truth: a failed terminal commit is
          // loud, but the holder's result still settles (bounded teardown).
          this.deps.ctx.logger.error(`agent-swarm workflow bridge: overlay terminal commit failed for ${this.id}: ${String(error)}`)
        }
      }
      this.deps.emitEvent('workflow/end', this.info, {
        stopReason: result.stopReason,
        ...result.error !== undefined ? { error: result.error } : {},
        agentsStarted: result.agentsStarted,
      })
      this.settleResolve(result)
      if (result.stopReason !== 'completed') {
        await this.archiveBounded(result.stopReason === 'cancelled' ? this.cancelReason ?? 'cancelled' : 'error')
      } else {
        await this.archiveBounded('completed')
      }
    })()
  }
}
