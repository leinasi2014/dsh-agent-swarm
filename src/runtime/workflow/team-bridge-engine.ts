/**
 * The Team bridge workflow engine (M2-1, issue #75): an implementation of
 * the official abstract `WorkflowEngine` whose runs are backed by a Team
 * aggregate (design note:
 * docs/development/2026-08-21-m2a-workflow-bridge-design.md).
 *
 * Registration posture: the official base class hardcodes the
 * `workflowEngine` service name and Cordis rejects a second same-scope
 * registration, so this engine is constructed on `ctx.isolate('workflowEngine')`
 * — the official mechanism for providing a different implementation without
 * affecting the parent scope. The default scope's `ctx.workflowEngine` (the
 * official worker-thread engine, when composed) is never taken over, and the
 * bridge's `workflow/*` events still dispatch on the shared global event bus
 * so official consumers and invariant companions observe them unchanged.
 * @module dsh-agent-swarm/runtime/workflow/team-bridge-engine
 */

import * as vm from 'node:vm'
import { availableParallelism } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import WorkflowEngine from '@deepseek-ai/dsh-workflow'
import { WorkflowError } from '@deepseek-ai/dsh-workflow'
import type {
  WorkflowMeta,
  WorkflowPhase,
  WorkflowRun,
  WorkflowStartRequest,
} from '@deepseek-ai/dsh-workflow'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import {
  WorkflowRunOverlayStore,
  workflowOverlayDomainSpec,
} from '../../storage/workflow-run-overlay.js'
import type { AgentSwarmRuntime } from '../orchestrator-runtime.js'
import { TeamRun } from './team-run.js'
import type { ExecutorLimits } from './script-executor.js'

/** Resolved engine configuration (plugin `Config` supplies the defaults). */
export interface BridgeEngineConfig {
  /** Total `agent()` calls one run may start — the runaway-loop backstop. */
  readonly maxTotalAgents: number
  /** Cancellation/disposal grace bounding run settlement. */
  readonly disposeGraceMs: number
}

/** A body that still carries the Claude Code-style meta header (meta rides the seam as data here). */
const META_STATEMENT = /^\s*export\s+const\s+meta\b/

/**
 * Parse-check the body with the SAME wrapper the executor compiles, so
 * `start()` keeps the seam's synchronous `SCRIPT_PARSE` throw. Mirrors the
 * official engine's pre-parse (worker-thread `index.ts:64-74`).
 */
function assertBodyParses(body: string, name: string): void {
  if (META_STATEMENT.test(body)) {
    throw new WorkflowError('workflow meta rides the `meta` request field, not the script: remove the `export const meta = {...}` statement from the body', 'SCRIPT_PARSE')
  }
  try {
    // Parse only — the script object is discarded, nothing executes.
    void new vm.Script(`(async () => {\n${body}\n})()`, { filename: `workflow:${name}`, lineOffset: -1 })
  } catch (error: unknown) {
    throw new WorkflowError(`workflow script does not parse: ${String(error)}`, 'SCRIPT_PARSE', { cause: error })
  }
}

/** Collect meta shape violations (plain JSON data by the seam contract). */
function validateMetaShape(meta: unknown): { meta?: WorkflowMeta; violations: string[] } {
  const violations: string[] = []
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return { violations: ['meta must be an object'] }
  }
  const record = meta as Record<string, unknown>
  const known = new Set(['name', 'description', 'whenToUse', 'phases'])
  for (const key of Object.keys(record)) {
    if (!known.has(key)) violations.push(`meta.${key} is not a recognized field (name/description/whenToUse/phases)`)
  }
  if (typeof record.name !== 'string' || record.name.length === 0) violations.push('meta.name must be a non-empty string')
  if (typeof record.description !== 'string' || record.description.length === 0) violations.push('meta.description must be a non-empty string')
  if (record.whenToUse !== undefined && typeof record.whenToUse !== 'string') violations.push('meta.whenToUse must be a string')
  const phases: WorkflowPhase[] = []
  if (record.phases !== undefined) {
    if (!Array.isArray(record.phases)) {
      violations.push('meta.phases must be an array')
    } else {
      record.phases.forEach((phase, index) => {
        if (typeof phase !== 'object' || phase === null || Array.isArray(phase)) {
          violations.push(`meta.phases[${index}] must be an object`)
          return
        }
        const entry = phase as Record<string, unknown>
        for (const key of Object.keys(entry)) {
          if (!['title', 'detail', 'provider', 'model'].includes(key)) violations.push(`meta.phases[${index}].${key} is not a recognized field`)
        }
        if (typeof entry.title !== 'string' || entry.title.length === 0) violations.push(`meta.phases[${index}].title must be a non-empty string`)
        if (entry.detail !== undefined && typeof entry.detail !== 'string') violations.push(`meta.phases[${index}].detail must be a string`)
        if (entry.provider !== undefined && typeof entry.provider !== 'string') violations.push(`meta.phases[${index}].provider must be a string`)
        if (entry.model !== undefined && typeof entry.model !== 'string') violations.push(`meta.phases[${index}].model must be a string`)
        if (violations.length === 0) {
          phases.push({
            title: entry.title as string,
            ...entry.detail !== undefined ? { detail: entry.detail as string } : {},
            ...entry.provider !== undefined ? { provider: entry.provider as string } : {},
            ...entry.model !== undefined ? { model: entry.model as string } : {},
          })
        }
      })
    }
  }
  if (violations.length > 0) return { violations }
  return {
    violations,
    meta: {
      name: record.name as string,
      description: record.description as string,
      ...record.whenToUse !== undefined ? { whenToUse: record.whenToUse as string } : {},
      ...record.phases !== undefined ? { phases } : {},
    },
  }
}

/**
 * Validate a caller-provided meta value against the official
 * {@link WorkflowMeta} contract. Throws `META_INVALID` naming every
 * violation; the returned meta is a NORMALIZED copy built from the validated
 * fields, so the engine never aliases the caller's object (official
 * worker-thread `meta.ts:76-82` semantics).
 * @param value - the meta data from the start request (plain JSON by the seam contract).
 * @returns the validated, normalized meta block.
 */
export function validateBridgeMeta(value: unknown): WorkflowMeta {
  const { meta, violations } = validateMetaShape(value)
  if (meta === undefined) {
    throw new WorkflowError(`invalid meta: ${violations.join('; ')}`, 'META_INVALID')
  }
  return meta
}

/**
 * The Team-backed workflow engine service. `start()` validates the request
 * synchronously (meta, body parse, provider, caps — throwing before any
 * publication), then returns a live {@link TeamRun} whose Team assembly,
 * overlay commit and event publication proceed under the run's own bounded
 * lifecycle. Activate once (opens the overlay domain and recovers
 * interrupted runs) before starting runs.
 */
export class TeamBridgeWorkflowEngine extends WorkflowEngine {
  private overlayInstance?: WorkflowRunOverlayStore
  private overlayDomain?: Domain<typeof workflowOverlayDomainSpec>
  private readonly liveRuns = new Set<TeamRun>()
  private closing = false

  constructor(
    ctx: Context,
    private readonly runtime: AgentSwarmRuntime,
    private readonly config: BridgeEngineConfig,
  ) {
    super(ctx)
  }

  /** The overlay store; available after {@link activate}. */
  get overlay(): WorkflowRunOverlayStore {
    if (this.overlayInstance === undefined) {
      throw new WorkflowError('Team bridge engine is not activated', 'INVALID_ARGUMENT')
    }
    return this.overlayInstance
  }

  /**
   * Open the `agent_swarm_workflow` overlay domain and recover interrupted
   * runs. Fail closed: an unavailable domain, missing backend route, version
   * mismatch or invalid stored record fails plugin activation.
   */
  async activate(): Promise<void> {
    if (this.closing) throw new WorkflowError('Team bridge engine is disposing', 'INVALID_ARGUMENT')
    const handle = await this.ctx.storageDomain.open(workflowOverlayDomainSpec)
    const store = new WorkflowRunOverlayStore(this.ctx, handle)
    this.overlayDomain = handle
    this.overlayInstance = store
    // Trap 1: the overlay is the only run truth. Runs still marked `running`
    // lost their process; mark them interrupted (evidence-only — re-driving
    // belongs to the orchestration-mode surface, #77).
    for (const record of store.list()) {
      if (record.state !== 'running') continue
      await store.markInterrupted(record.runId, 'process boundary interrupted the run before settlement')
      this.ctx.logger.warn(`agent-swarm workflow bridge: run ${record.runId} (team ${record.teamId}) recovered as interrupted`)
    }
  }

  /**
   * Parse, validate and Team-execute a workflow script. Throws
   * {@link WorkflowError} synchronously (`META_INVALID`, `SCRIPT_PARSE`,
   * `INVALID_ARGUMENT`, `AGENT_START`) for a request that cannot begin; once
   * a run is returned, every failure resolves through `result.stopReason`.
   * @param request - the script body, its meta data and `args`, the parent
   *   agent, and an optional cancel signal.
   * @returns the live Team-backed run (its `result` resolves when it settles).
   */
  start(request: WorkflowStartRequest): WorkflowRun {
    if (this.overlayInstance === undefined) {
      throw new WorkflowError('Team bridge engine is not activated', 'INVALID_ARGUMENT')
    }
    if (this.closing) throw new WorkflowError('Team bridge engine is disposing', 'INVALID_ARGUMENT')
    const meta = validateBridgeMeta(request.meta)
    assertBodyParses(request.script, meta.name)
    const provider = this.resolveSubagentProvider(request.subagentProvider)
    const maxTotalAgents = this.resolveMaxTotalAgents(request.maxTotalAgents)
    // Team aggregate field bounds (authoritative domain limits): reject before
    // publication instead of failing the run after it began.
    if (Buffer.byteLength(meta.name, 'utf8') > 128 || Buffer.byteLength(meta.description, 'utf8') > 16_384) {
      throw new WorkflowError('meta.name (128 bytes) and meta.description (16384 bytes) must fit the Team aggregate limits', 'INVALID_ARGUMENT')
    }
    const limits: ExecutorLimits = {
      maxConcurrentAgents: Math.min(16, Math.max(1, availableParallelism() - 2)),
      maxTotalAgents,
      maxItemsPerCall: 4096,
      syncTimeoutMs: 5000,
    }
    const run = new TeamRun({
      ctx: this.ctx,
      runtime: this.runtime,
      overlay: this.overlayInstance,
      emitEvent: (name, ...args) => { this.emitWorkflowEvent(name, ...args) },
      limits,
      disposeGraceMs: this.config.disposeGraceMs,
      disposalTimeoutMs: this.runtime.config.disposalTimeoutMs,
      provider,
      maxTotalAgents,
      ...request.signal !== undefined ? { signal: request.signal } : {},
    }, meta, request.script, request.args, request.parent)
    this.liveRuns.add(run)
    void run.result.then(() => { this.liveRuns.delete(run) }).catch(() => { this.liveRuns.delete(run) })
    run.begin()
    return run
  }

  /** Resolve one run's provider route before publishing work (official semantics). */
  private resolveSubagentProvider(override: string | undefined): string {
    const provider = override ?? this.runtime.config.memberProvider
    if (provider.length === 0 || provider !== provider.trim()) {
      throw new WorkflowError('workflow subagentProvider must be a non-empty normalized string', 'INVALID_ARGUMENT')
    }
    if (this.ctx.subagents.getProvider(provider) === undefined) {
      throw new WorkflowError(`no subagent provider registered for "${provider}"`, 'AGENT_START')
    }
    return provider
  }

  /** Resolve one run's total-child cap against the engine deployment ceiling. */
  private resolveMaxTotalAgents(requested: number | undefined): number {
    if (requested === undefined) return this.config.maxTotalAgents
    if (!Number.isSafeInteger(requested) || requested < 1) {
      throw new WorkflowError('workflow maxTotalAgents must be a positive safe integer', 'INVALID_ARGUMENT')
    }
    if (requested > this.config.maxTotalAgents) {
      throw new WorkflowError(
        `workflow maxTotalAgents ${requested} exceeds the engine ceiling ${this.config.maxTotalAgents}`,
        'INVALID_ARGUMENT',
      )
    }
    return requested
  }

  /**
   * Bounded teardown: settle every live run (cancelled within the grace),
   * then release the overlay domain handle. Idempotent.
   */
  async dispose(): Promise<void> {
    if (this.closing) return
    this.closing = true
    const failures: unknown[] = []
    // Array.from snapshots the registry: run disposal removes entries.
    for (const run of Array.from(this.liveRuns)) {
      try {
        await run.dispose()
      } catch (error: unknown) {
        failures.push(error)
      }
    }
    this.liveRuns.clear()
    try {
      this.overlayInstance?.close()
      await this.overlayDomain?.close()
    } catch (error: unknown) {
      failures.push(error)
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Team bridge engine disposal failed')
  }
}
