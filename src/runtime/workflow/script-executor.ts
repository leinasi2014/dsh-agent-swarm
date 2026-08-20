/**
 * Script execution for the Team bridge workflow engine (M2-1, issue #75).
 *
 * Executes the model-written workflow body in a fresh in-process `node:vm`
 * context with the official script realm contract (frozen `agent`,
 * `parallel`, `pipeline`, `phase`, `log` hooks plus the `args` global),
 * mirroring the official worker-thread runtime's discipline
 * (`packages/workflow/workflow-worker-thread/src/runtime.ts` at the rc.8
 * baseline): cancellation kills the script at its next HOOK boundary,
 * combinators null ordinary per-item errors but re-throw fatal
 * `WorkflowError`s, caps fail loud, and `drive()` NEVER rejects.
 *
 * The per-realm vm context keeps `isFatalWorkflowError` unforgeable the same
 * way the official worker does: a script-built object's prototype chain lives
 * in the guest realm, so host-side `instanceof WorkflowError` fails. Unlike
 * the official engine there is no worker thread — a parked script cannot be
 * terminated, so the Team run bounds settlement with its disposal grace
 * instead (design note §4.4).
 * @module dsh-agent-swarm/runtime/workflow/script-executor
 */

import * as vm from 'node:vm'
import { isFatalWorkflowError, WorkflowError } from '@deepseek-ai/dsh-workflow'
import type { WorkflowMeta, WorkflowResult } from '@deepseek-ai/dsh-workflow'
import { MaterializeError, materializeFromRealm, renderThrown } from './realm.js'

/** One admitted `agent()` call, sequenced and labeled by the executor. */
export interface AgentCall {
  /** 1-based sequence number of this call within the run. */
  readonly seq: number
  /** Display label (the `label` option, or a prompt snippet). */
  readonly label: string
  /** The phase this call belongs to (the `phase` option, else the current `phase()` title). */
  readonly phase?: string
  /** The validated non-empty prompt string. */
  readonly prompt: string
  /** Optional per-call provider override. */
  readonly provider?: string
  /** Optional per-call model override. */
  readonly model?: string
}

/** How one driven `agent()` call settled from the Team side. */
export type AgentCallOutcome =
  | { readonly outcome: 'completed'; readonly output: string }
  | { readonly outcome: 'failed' }

/** The Team-side driver owning member/task execution and agent-event emission. */
export interface AgentCallDriver {
  /**
   * Drive one admitted agent call to settlement. Emits the paired
   * `workflow/agent-start`/`workflow/agent-end` events; a call that never
   * reaches a published member emits neither.
   * @param call - the sequenced call to execute.
   * @returns the settled outcome (child failure maps to `failed`).
   */
  drive(call: AgentCall): Promise<AgentCallOutcome>
}

/** Execution limits, resolved from the engine config and request. */
export interface ExecutorLimits {
  /** Concurrent `agent()` ceiling (FIFO slots). */
  readonly maxConcurrentAgents: number
  /** Total `agent()` calls one run may start (runaway-loop backstop). */
  readonly maxTotalAgents: number
  /** Items accepted by a single `parallel()`/`pipeline()` call. */
  readonly maxItemsPerCall: number
  /** vm timeout for the script's initial synchronous slice. */
  readonly syncTimeoutMs: number
}

/** Progress narration hooks (agent events belong to the driver). */
export interface ExecutionObserver {
  phase(title: string): void
  log(message: string): void
}

/** The `agent()` options the script may pass; everything else rejects loud. */
const SUPPORTED_AGENT_OPTIONS = new Set(['label', 'phase', 'provider', 'model'])
/** Official deferred options named explicitly in the rejection message. */
const DEFERRED_AGENT_OPTIONS = new Set(['schema', 'effort', 'isolation', 'agentType'])

/** A short display label derived from the prompt when the script passes none. */
function defaultLabel(prompt: string): string {
  const newline = prompt.indexOf('\n')
  const line = newline === -1 ? prompt : prompt.slice(0, newline)
  return line.length <= 48 ? line : `${line.slice(0, 47)}…`
}

/**
 * One live script execution. Constructed per run; `drive()` is called exactly
 * once and NEVER rejects — every failure becomes a {@link WorkflowResult}
 * with a non-`completed` stop reason. The Team run owns cancellation and
 * cleanup of any dropped agent work.
 */
export class BridgeScriptExecution {
  /** 1-based count of `agent()` calls admitted (the `agentsStarted` field). */
  private started = 0

  /** Host-observable count of admitted `agent()` calls (termination paths). */
  get startedCount(): number {
    return this.started
  }

  private activeSlots = 0
  private readonly slotWaiters: { resolve(): void; reject(error: unknown): void }[] = []
  private cancelReason: string | undefined
  private cancelError: WorkflowError | undefined
  private currentPhase: string | undefined
  private readonly context: vm.Context
  private readonly compiled: vm.Script

  constructor(
    meta: WorkflowMeta,
    body: string,
    args: unknown,
    private readonly limits: ExecutorLimits,
    private readonly observer: ExecutionObserver,
    private readonly driver: AgentCallDriver,
  ) {
    // Compile FIRST: a body syntax error must throw out of the constructor
    // before any realm state exists. The engine pre-parses the identical
    // wrapper, so under one Node version this throw is unreachable in
    // production; it is mapped defensively all the same.
    try {
      this.compiled = new vm.Script(`(async () => {\n${body}\n})()`, {
        filename: `workflow:${meta.name}`,
        lineOffset: -1,
      })
    } catch (error: unknown) {
      throw new WorkflowError(`workflow script does not parse: ${String(error)}`, 'SCRIPT_PARSE', { cause: error })
    }

    this.context = vm.createContext({}, { name: `workflow:${meta.name}` })

    // The seam contract makes `args` plain JSON, so one structured clone is
    // total and doubles as the caller-isolation copy (the official engine
    // buys the same property from the worker's structured clone).
    const clonedArgs = args === undefined ? undefined : structuredClone(args)
    const globals: Record<string, unknown> = {
      agent: (prompt: unknown, opts?: unknown) => this.contain(this.agent(prompt, opts)),
      parallel: (thunks: unknown) => this.contain(this.parallel(thunks)),
      pipeline: (items: unknown, ...stages: unknown[]) => this.contain(this.pipeline(items, stages)),
      phase: (title: unknown) => { this.phase(title) },
      log: (message: unknown) => { this.log(message) },
      args: clonedArgs,
    }
    for (const [key, value] of Object.entries(globals)) {
      // Data properties on the contextified global; frozen shape not
      // required — a script overwriting its own hooks only sabotages itself.
      ;(this.context as Record<string, unknown>)[key] = typeof value === 'function' ? Object.freeze(value) : value
    }
  }

  /**
   * Whether the run has been cancelled. A METHOD, not an inline property
   * read: `cancel()` mutates `cancelReason` concurrently and an inline read
   * after an `await` gets narrowed by control flow into an always-false
   * comparison.
   */
  private isCancelled(): boolean {
    return this.cancelReason !== undefined
  }

  /**
   * Shared hook entry guard: after {@link cancel}, EVERY hook throws
   * `CANCELLED` at its next call — cancellation is the next HOOK boundary,
   * not just the next `agent()`.
   */
  private throwIfCancelled(): void {
    if (this.isCancelled()) throw this.cancelledError()
  }

  /**
   * Cancel the run: waiting `agent()` slots reject and every future hook call
   * throws `CANCELLED` — the script dies at its next await. A script that
   * never settles anyway is the RUN's problem: its grace bound force-settles
   * the result. Idempotent; the first reason wins.
   * @param reason - human-readable cause carried on the CANCELLED error.
   */
  cancel(reason: string): void {
    if (this.cancelReason !== undefined) return
    this.cancelReason = reason
    this.cancelError = new WorkflowError(`workflow run cancelled: ${reason}`, 'CANCELLED')
    for (const waiter of this.slotWaiters.splice(0)) waiter.reject(this.cancelledError())
  }

  /**
   * Run the script to settlement. Resolves — never rejects — with the run's
   * {@link WorkflowResult}.
   * @returns the settled outcome; this promise NEVER rejects (the seam's
   *   `result`-never-rejects contract).
   */
  async drive(): Promise<WorkflowResult> {
    try {
      if (this.isCancelled()) throw this.cancelledError()
      const scriptPromise = this.compiled.runInContext(this.context, { timeout: this.limits.syncTimeoutMs }) as Promise<unknown>
      const raw: unknown = await this.contain(Promise.resolve(scriptPromise))
      // Cancelled while the body ran: a script that settled without touching
      // another hook must still report `cancelled`.
      if (this.isCancelled()) throw this.cancelledError()
      const value = raw === undefined ? null : this.materializeResult(raw)
      return { value, stopReason: 'completed', agentsStarted: this.started }
    } catch (error: unknown) {
      if (this.isCancelled()) {
        return { value: null, stopReason: 'cancelled', error: this.cancelledError().message, agentsStarted: this.started }
      }
      return { value: null, stopReason: 'error', error: renderThrown(error), agentsStarted: this.started }
    }
  }

  /**
   * Attach a no-op rejection consumer WITHOUT changing what the caller
   * receives: a dropped hook promise must not surface an unhandled rejection.
   */
  private contain<T>(promise: Promise<T>): Promise<T> {
    promise.catch(() => { /* consumed: a dropped hook promise must not surface an unhandled rejection */ })
    return promise
  }

  private cancelledError(): WorkflowError {
    // cancel() arms cancelError before any caller can observe isCancelled().
    /* v8 ignore next -- defensive fallback outside the cancel state machine */
    return this.cancelError ?? new WorkflowError('workflow run cancelled', 'CANCELLED')
  }

  /** Materialize the script's return value; violations become RESULT_UNSERIALIZABLE. */
  private materializeResult(raw: unknown): unknown {
    try {
      return materializeFromRealm(raw, 'workflow result')
    } catch (error: unknown) {
      /* v8 ignore next -- defensive rethrow arm: materializeFromRealm only throws MaterializeError */
      if (!(error instanceof MaterializeError)) throw error
      throw new WorkflowError(
        `the workflow's return value is not plain JSON data — ${error.message}. Return only JSON-serializable objects/arrays/scalars.`,
        'RESULT_UNSERIALIZABLE',
        { cause: error },
      )
    }
  }

  /** Acquire one concurrency slot (FIFO); cancellation rejects QUEUED waiters. */
  private acquireSlot(): Promise<void> {
    if (this.activeSlots < this.limits.maxConcurrentAgents) {
      this.activeSlots += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      this.slotWaiters.push({
        resolve: () => {
          this.activeSlots += 1
          resolve()
        },
        reject,
      })
    })
  }

  private releaseSlot(): void {
    this.activeSlots -= 1
    const next = this.slotWaiters.shift()
    if (next) next.resolve()
  }

  /** The `agent(prompt, opts)` hook. */
  private async agent(rawPrompt: unknown, rawOpts: unknown): Promise<unknown> {
    this.throwIfCancelled()
    if (typeof rawPrompt !== 'string' || rawPrompt.length === 0) {
      throw new WorkflowError('agent() requires a non-empty prompt string', 'INVALID_ARGUMENT')
    }
    const opts = this.readAgentOptions(rawOpts)
    if (this.started >= this.limits.maxTotalAgents) {
      throw new WorkflowError(
        `this run reached its total agent cap (${this.limits.maxTotalAgents}) — a runaway-loop backstop; raise the applicable maxTotalAgents limit if the scale is intentional`,
        'AGENT_CAP',
      )
    }
    this.started += 1
    const phase = opts.phase ?? this.currentPhase
    const call: AgentCall = {
      seq: this.started,
      label: opts.label ?? defaultLabel(rawPrompt),
      ...phase !== undefined ? { phase } : {},
      prompt: rawPrompt,
      ...opts.provider !== undefined ? { provider: opts.provider } : {},
      ...opts.model !== undefined ? { model: opts.model } : {},
    }

    await this.acquireSlot()
    try {
      // Re-check after the acquire: the await yields at least one microtask
      // tick, and a cancel() landing in that window must not start a member.
      this.throwIfCancelled()
      let settled: AgentCallOutcome
      try {
        settled = await this.driver.drive(call)
      } catch (error: unknown) {
        if (this.isCancelled()) throw this.cancelledError()
        if (error instanceof WorkflowError) throw error
        throw new WorkflowError(`agent() could not start a child: ${renderThrown(error)}`, 'AGENT_START', { cause: error })
      }
      if (this.isCancelled()) throw this.cancelledError()
      return settled.outcome === 'completed' ? settled.output : null
    } finally {
      this.releaseSlot()
    }
  }

  /** Materialize + validate the `agent()` options bag from the realm. */
  private readAgentOptions(rawOpts: unknown): {
    label?: string
    phase?: string
    provider?: string
    model?: string
  } {
    if (rawOpts === undefined) return {}
    let opts: unknown
    try {
      opts = materializeFromRealm(rawOpts, 'agent() options')
    } catch (error: unknown) {
      /* v8 ignore next -- defensive rethrow arm: materializeFromRealm only throws MaterializeError */
      if (!(error instanceof MaterializeError)) throw error
      throw new WorkflowError(`agent() options must be plain JSON data — ${error.message}`, 'INVALID_ARGUMENT', { cause: error })
    }
    if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) {
      throw new WorkflowError('agent() options must be an object', 'INVALID_ARGUMENT')
    }
    const record = opts as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (SUPPORTED_AGENT_OPTIONS.has(key)) continue
      if (key === 'schema') {
        throw new WorkflowError(
          'agent() option "schema" is not supported by the Team bridge engine (continuable members have no outputSchema channel); supported: label, phase, provider, model',
          'UNSUPPORTED_OPTION',
        )
      }
      if (DEFERRED_AGENT_OPTIONS.has(key)) {
        throw new WorkflowError(`agent() option "${key}" is deferred and not supported by this engine (supported: label, phase, provider, model)`, 'UNSUPPORTED_OPTION')
      }
      throw new WorkflowError(`agent() option "${key}" is not recognized (supported: label, phase, provider, model)`, 'UNSUPPORTED_OPTION')
    }
    for (const key of ['label', 'phase', 'provider', 'model'] as const) {
      if (record[key] !== undefined && typeof record[key] !== 'string') {
        throw new WorkflowError(`agent() option "${key}" must be a string`, 'INVALID_ARGUMENT')
      }
    }
    return {
      ...record.label !== undefined ? { label: record.label as string } : {},
      ...record.phase !== undefined ? { phase: record.phase as string } : {},
      ...record.provider !== undefined ? { provider: record.provider as string } : {},
      ...record.model !== undefined ? { model: record.model as string } : {},
    }
  }

  /** The `parallel(thunks)` hook: each thunk caught → `null`; fatal errors propagate. */
  private async parallel(rawThunks: unknown): Promise<unknown[]> {
    this.throwIfCancelled()
    if (!Array.isArray(rawThunks)) {
      throw new WorkflowError('parallel() requires an array of zero-argument functions', 'INVALID_ARGUMENT')
    }
    this.assertItemCap(rawThunks.length, 'parallel()')
    const thunks = rawThunks.map((thunk, index) => {
      if (typeof thunk !== 'function') {
        throw new WorkflowError(`parallel() item ${index} is not a function`, 'INVALID_ARGUMENT')
      }
      return thunk as () => unknown
    })
    return Promise.all(thunks.map(async (thunk) => {
      try {
        return await thunk()
      } catch (error: unknown) {
        // Hook failures are WorkflowErrors built OUTSIDE the script's realm;
        // fatality is recognized by `instanceof` against this realm's class —
        // a script-built object can never pass it.
        if (isFatalWorkflowError(error)) throw error
        return null
      }
    }))
  }

  /** The `pipeline(items, ...stages)` hook: per-item stage chains, NO cross-stage barrier. */
  private async pipeline(rawItems: unknown, rawStages: unknown[]): Promise<unknown[]> {
    this.throwIfCancelled()
    if (!Array.isArray(rawItems)) {
      throw new WorkflowError('pipeline() requires an items array', 'INVALID_ARGUMENT')
    }
    this.assertItemCap(rawItems.length, 'pipeline()')
    if (rawStages.length === 0) {
      throw new WorkflowError('pipeline() requires at least one stage function', 'INVALID_ARGUMENT')
    }
    const stages = rawStages.map((stage, index) => {
      if (typeof stage !== 'function') {
        throw new WorkflowError(`pipeline() stage ${index} is not a function`, 'INVALID_ARGUMENT')
      }
      return stage as (previous: unknown, item: unknown, index: number) => unknown
    })
    return Promise.all(rawItems.map(async (item: unknown, index: number) => {
      let value: unknown = item
      try {
        for (const stage of stages) {
          value = await stage(value, item, index)
        }
        return value
      } catch (error: unknown) {
        if (isFatalWorkflowError(error)) throw error
        return null
      }
    }))
  }

  private assertItemCap(length: number, hook: string): void {
    if (length > this.limits.maxItemsPerCall) {
      throw new WorkflowError(
        `${hook} received ${length} items — over the per-call cap (${this.limits.maxItemsPerCall}); split the work or raise the item cap in the engine config`,
        'ITEM_CAP',
      )
    }
  }

  /** The `phase(title)` hook: sets the current label and notifies observers. */
  private phase(title: unknown): void {
    this.throwIfCancelled()
    if (typeof title !== 'string' || title.length === 0) {
      throw new WorkflowError('phase() requires a non-empty title string', 'INVALID_ARGUMENT')
    }
    this.currentPhase = title
    this.observer.phase(title)
  }

  /** The `log(message)` hook: narration to observers. */
  private log(message: unknown): void {
    this.throwIfCancelled()
    if (typeof message !== 'string') {
      throw new WorkflowError('log() requires a message string', 'INVALID_ARGUMENT')
    }
    this.observer.log(message)
  }
}
