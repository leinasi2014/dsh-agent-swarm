/**
 * Skills-specific test harness for the S1 skills-management vertical
 * (task-1, attempt-1830b1d8). Composes the REAL official stack through the
 * existing restart fixture (real Context, AgentLoop/AgentRegistry, durable
 * Session persistence, official Storage Domain over the json backend, the
 * agent-swarm plugin), plus the Skills module's own function plugin mounted
 * as a real plugin beside the swarm.
 *
 * RED discipline: this helper NEVER statically imports the Skills module.
 * `mountSkillsModule` checks whether `src/skills/plugin.ts` exists yet and
 * only then dynamically mounts it, so the frozen RED run drives the real
 * official tool path against a composition where the capability genuinely
 * is not provided (tool dispatch fails on the product surface) — never on
 * an import error. Once the module exists, any import or apply failure
 * propagates loudly (fail loud, no silent skip).
 */
import { existsSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId, createUserMessage, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, vi } from 'vitest'
import type { SkillsManagementModule } from '../../src/skills/module.js'
import { readPersistedSession } from '../../src/runtime/persisted-session.js'
import {
  disposeRestartComposition,
  mountRestartComposition,
  RESTART_SIGNAL,
  restartTool,
  type RestartMounted,
} from './restart-real-composition.js'

/** Root Captain Session identity shared by every Skills vertical restart pair. */
export const SKILLS_ROOT = SessionId('skills-s1-root')
/** Captain-side model route used by the composition (never the manager route). */
export const SKILLS_CAPTAIN_ROUTE = { provider: 'skills-fixture', model: 'skills-model' }
/** Module-owned Storage Domain unit file (official json backend layout). */
export const SKILLS_UNIT_NAME = 'agent_swarm_skills_management'

/** Adapter that records every model request so zero-model claims are assertable. */
export class SkillsCountingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const text = 'Skills fixture turn settled.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * Fixture adapter for the official subagent settlement lifecycle
 * (dsh-subagent watchSettlement): a child Agent whose turn finishes with an
 * empty inbox and no owned children is DISPOSED at the natural epoch — a
 * durable continuable Session is not a resident Agent instance. To run an
 * intake/claim inside the REAL child's live window, every NON-root Session
 * turn is held at a cancellable gate before its finish chunk; the main root
 * bootstrap settles normally. The gate honours `options.signal` so dispose
 * cancels cleanly, and callers release it in `finally` before teardown.
 */
export class SkillsHeldChildAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private gate: Promise<void>
  private releaseGate: (() => void) | undefined
  private released = false
  /** How many non-root Session turns have entered the gate. */
  gateEntered = 0

  constructor(private readonly freeSession: string) {
    super()
    this.gate = new Promise<void>(resolve => { this.releaseGate = resolve })
  }

  releaseAll(): void {
    this.released = true
    this.releaseGate?.()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const held = options.sessionId !== undefined && String(options.sessionId) !== this.freeSession
    if (held && !this.released) {
      this.gateEntered += 1
      const signal = options.signal
      if (signal?.aborted === true) throw new Error('held child turn cancelled before the gate')
      if (signal === undefined) {
        await this.gate
      } else {
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => { reject(new Error('held child turn cancelled at the gate')) }
          signal.addEventListener('abort', onAbort, { once: true })
          this.gate.then(
            () => { signal.removeEventListener('abort', onAbort); resolve() },
            reject,
          )
        })
      }
    }
    const text = 'Skills held-child turn settled.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Structural mirror of the module plugin config (no src/skills runtime import here). */
export interface SkillsModuleMountConfig {
  readonly manager?: { readonly provider?: string; readonly model?: string }
  readonly management: readonly { readonly scope: string; readonly teamId: string }[]
  readonly activityPageSize?: number
}

export interface SkillsComposition {
  readonly mounted: RestartMounted
  readonly ctx: Context
  readonly root: Agent
  readonly teamId: string
  readonly scope: string
  readonly adapter: SkillsCountingAdapter
}

/** Mount the real official composition plus the swarm plugin for Skills tests.
 * The official dsh-llm registry FORBIDS a second adapter for one provider
 * (DUPLICATE_ADAPTER), so each provider is registered exactly once: the
 * Captain route uses the caller-provided adapter when given (a held-child
 * fixture, for instance) and otherwise the default counting adapter. The
 * zero-model assertion surface ({@link skillsAdapter}) always points at the
 * ACTUALLY REGISTERED instance for the Captain route.
 */
export async function mountSkillsComposition(sandbox: string, extraAdapters: Record<string, LlmAdapter> = {}): Promise<RestartMounted> {
  const defaultAdapter = new SkillsCountingAdapter()
  const captainAdapter = extraAdapters[SKILLS_CAPTAIN_ROUTE.provider] ?? defaultAdapter
  const mounted = await mountRestartComposition(sandbox, 0, undefined, undefined, ctx => {
    ctx.llm.registerAdapter([SKILLS_CAPTAIN_ROUTE.provider], captainAdapter)
    for (const [provider, extra] of Object.entries(extraAdapters)) {
      if (provider === SKILLS_CAPTAIN_ROUTE.provider) continue
      ctx.llm.registerAdapter([provider], extra)
    }
  }, { captainLlmProvider: SKILLS_CAPTAIN_ROUTE.provider, captainModel: SKILLS_CAPTAIN_ROUTE.model })
  ;(mounted as { skillsAdapter?: { readonly requests: GenerateOptions[] } }).skillsAdapter = captainAdapter as SkillsCountingAdapter
  return mounted
}

/** The adapter ACTUALLY registered for the Captain route, for zero-model claims. */
export function skillsAdapter(mounted: RestartMounted): { readonly requests: GenerateOptions[] } {
  const adapter = (mounted as { skillsAdapter?: { readonly requests: GenerateOptions[] } }).skillsAdapter
  if (adapter === undefined) throw new Error('skills composition adapter missing')
  return adapter
}

/**
 * Live the root Captain and create its Team through the real tool face.
 *
 * Restart precondition (external S ruling, mirroring the accepted restart
 * baseline): the Captain lives through the official AgentLoop so one real
 * turn settles into its durable Session log, and the settled `turn/end` is
 * confirmed readable on the medium BEFORE the first Context may be disposed
 * — that recoverable log is exactly what `agents.resume` reopens under the
 * SAME SessionId on the restart side. No new Session ids, no hand-written logs.
 */
export async function createSkillsTeam(mounted: RestartMounted, sandbox: string, resume = false): Promise<{ root: Agent; teamId: string }> {
  if (resume) {
    const root = (await mounted.ctx.agents.resume({ resumeSessionId: SKILLS_ROOT })).agent
    const teams = await mounted.ctx.agentSwarm.listTeamAggregates(mounted.ctx.agentSwarm.scopeOf(root))
    const team = teams[0]
    if (team === undefined) throw new Error('no Team aggregate survived the restart')
    return { root, teamId: team.id }
  }
  const root = await mounted.ctx.agentLoop.create(SKILLS_ROOT, SKILLS_CAPTAIN_ROUTE, { cwd: join(sandbox, 'workspace') })
  root.followup(createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'Skills S1 fixture bootstrap turn — settle one real turn so the Session log is recoverable across restart.' }],
  }))
  await root.whenIdle()
  const created = await restartTool(mounted.ctx, root, 'skills-team-create', 'agent_swarm_create', {
    name: 'Skills S1 vertical',
    description: 'Freeze the Captain skill-request vertical through the official tool path.',
  })
  expect(created.isError, `agent_swarm_create failed: ${JSON.stringify(created.isError ? created.error : created.value)}`).toBe(false)
  await vi.waitFor(async () => {
    const stored = await readPersistedSession(mounted.ctx.sessionPersistence, SKILLS_ROOT)
    expect(stored.events.some(event => event.type === 'turn/end'), 'the Captain Session log must durably settle a turn/end before restart').toBe(true)
  }, { timeout: 5_000 })
  return { root, teamId: (created.value as { team_id: string }).team_id }
}

/**
 * Mount the Skills module plugin (real official plugin composition). Returns
 * false ONLY while `src/skills/plugin.ts` does not exist yet (frozen-RED
 * window); with the module present, mount failures reject loudly.
 */
export async function mountSkillsModule(ctx: Context, config: SkillsModuleMountConfig, fibers?: Fiber[]): Promise<boolean> {
  const sourcePath = fileURLToPath(new URL('../../src/skills/plugin.ts', import.meta.url))
  if (!existsSync(sourcePath)) return false
  // `as string` keeps the literal specifier for the module runner while the
  // frozen-RED window (module absent) stays free of compile-time resolution
  // (verified: a plain specifier would raise TS2307 until the module lands).
  // Once the module exists, any import/apply failure propagates loudly.
  const mod = (await import('../../src/skills/plugin.js' as string)) as { apply: unknown }
  const fiber = await ctx.plugin(mod as never, config as never)
  if (fibers !== undefined) fibers.push(fiber)
  return true
}

/** Durable unit file of the module-owned Storage Domain under the json root. */
export function skillsUnitFile(sandbox: string): string {
  return join(sandbox, 'storage', `${SKILLS_UNIT_NAME}.json`)
}

export interface SkillsToolOutcome {
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: string
  readonly code?: string
}

/** Real Captain tool call whose dispatch failure surfaces as an assertion, not a throw. */
export async function captainSkillsTool(
  ctx: Context,
  captain: Agent,
  callId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<SkillsToolOutcome> {
  return await restartTool(ctx, captain, callId, name, args).then(
    result => result.isError
      ? { ok: false, error: result.error.message, ...(result.error.info?.code === undefined ? {} : { code: result.error.info.code }) }
      : { ok: true, value: result.value },
    (error: unknown) => error instanceof Error
      ? {
          ok: false,
          error: `${error.name}: ${error.message}`,
          ...((error as Error & { code?: string }).code === undefined ? {} : { code: (error as Error & { code?: string }).code }),
        }
      : { ok: false, error: String(error) },
  )
}

export { RESTART_SIGNAL, disposeRestartComposition, restartTool }

// ── Manager-side fixtures (full S1 batch) ───────────────────────────────────

/** The module manager's OWN model route — deliberately distinct from the Captain route. */
export const SKILLS_MANAGER_ROUTE = { provider: 'skills-manager-fixture', model: 'skills-manager-model' }
/** The reserved investigate tool the manager scope registers. */
export const SKILLS_INVESTIGATE_TOOL = 'skills_management_investigate'
/** A GLOBAL tool registered only AFTER the manager Session exists (counterexample). */
export const SKILLS_LATE_GLOBAL_TOOL = 'skills_late_global_probe'

/** Mount config with a real manager route configured (full processing path). */
export function skillsManagerModuleConfig(
  scope: string,
  teamId: string,
  extra: { readonly activityPageSize?: number; readonly manifest?: readonly { readonly scope: string; readonly teamId: string }[] } = {},
): SkillsModuleMountConfig {
  return {
    manager: { ...SKILLS_MANAGER_ROUTE },
    management: extra.manifest ?? [{ scope, teamId }],
    ...(extra.activityPageSize === undefined ? {} : { activityPageSize: extra.activityPageSize }),
  }
}

/** Build one scripted model turn that emits exactly one tool call, then finishes. */
export function skillsToolTurn(callId: string, name: string, args: unknown): StreamChunk[] {
  const argsText = JSON.stringify(args)
  const id = ToolCallId(callId)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argsText },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argsText } },
    { type: 'usage', usage: { inputTokens: 6, outputTokens: 6 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** Build one scripted plain-text settling turn. */
export function skillsTextChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 2, outputTokens: 2 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * A script turn is a segment list: individual StreamChunks, or a GATE
 * segment the adapter awaits mid-turn — the primitive for genuinely stalled
 * model turns (close/timeout/stale-writer counterexamples that must
 * intercept BEFORE the turn dispatches its tool call).
 */
export type SkillsTurnSegment = StreamChunk | { readonly gate: Promise<void> }

/**
 * One scripted manager turn: fixed segments, or a DYNAMIC function of the
 * real GenerateOptions (message history included) — the honest stand-in for
 * a model that reads actual tool results (e.g. a captured batchId) before
 * deciding its next call.
 */
export type SkillsTurnSpec = SkillsTurnSegment[] | ((options: GenerateOptions) => SkillsTurnSegment[])

/** Build one stalled tool-call turn that dispatches NOTHING until the gate opens. */
export function skillsStalledToolTurn(callId: string, name: string, args: unknown, gate: Promise<void>): SkillsTurnSegment[] {
  return [{ gate }, ...skillsToolTurn(callId, name, args)]
}

/**
 * Scripted adapter for the manager route. The manager provider is registered
 * for NO other Session, so every request reaching this adapter IS a manager
 * request — no late binding races (mount-time recovery may call the model
 * before any test statement runs). Records every real model request for
 * route/headers/tool-list assertions and serves queued scripted turns.
 */
export class SkillsManagerScriptAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private readonly script: SkillsTurnSpec[] = []

  append(...turns: SkillsTurnSpec[]): void {
    this.script.push(...turns)
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const spec = this.script.shift() ?? skillsTextChunks('Manager settled.')
    const next = typeof spec === 'function' ? spec(options) : spec
    for (const segment of next) {
      if ('gate' in segment) {
        // The gate HONOURS options.signal: a real dispose/cancel unblocks the
        // stalled turn instead of hanging cleanup forever.
        const signal = options.signal
        if (signal?.aborted === true) throw new Error('manager stream cancelled before the gate')
        if (signal === undefined) {
          await segment.gate
        } else {
          await new Promise<void>((resolve, reject) => {
            const onAbort = (): void => { reject(new Error('manager stream cancelled at the gate')) }
            signal.addEventListener('abort', onAbort, { once: true })
            segment.gate.then(
              () => { signal.removeEventListener('abort', onAbort); resolve() },
              reject,
            )
          })
        }
      } else {
        yield segment
      }
    }
  }

  /** Every recorded manager-route request. */
  managerRequests(): GenerateOptions[] {
    return [...this.requests]
  }
}

/** Register a plain GLOBAL tool AFTER the manager exists (restrict counterexample). */
export function registerSkillsLateGlobalTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: SKILLS_LATE_GLOBAL_TOOL,
    description: 'Late-registered global probe tool used by the Skills restrict counterexample.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => true,
    execute: async () => 'late-global-ok',
  }))
}

/** The module service face mounted by the plugin (throws loudly when absent). */
export function skillsModule(ctx: Context): SkillsManagementModule {
  const service = (ctx as unknown as { agentSwarmSkills?: SkillsManagementModule }).agentSwarmSkills
  if (service === undefined) throw new Error('the skills-management module service is not mounted')
  return service
}

/**
 * Obtain a live Agent through the OFFICIAL registry surface. Registration may
 * have fired its event before any listener could attach, so the registry —
 * not future events — is the authoritative poll (`ctx.agents.get`).
 */
export async function liveSkillsAgent(ctx: Context, sessionId: string): Promise<Agent> {
  await vi.waitFor(() => expect(
    ctx.agents.get(SessionId(sessionId)),
    `Session ${sessionId} must be live in the official Agent registry`,
  ).toBeDefined(), { timeout: 15_000 })
  return ctx.agents.get(SessionId(sessionId))!
}

/** Create one real Team task through the Captain tool face; returns its id. */
export async function createSkillsTask(ctx: Context, captain: Agent, callId: string, subject: string): Promise<string> {
  const created = await restartTool(ctx, captain, callId, 'agent_swarm_create_task', {
    subject,
    description: `${subject} — durable work fact for the Skills consumer/evidence path.`,
  })
  expect(created.isError, `agent_swarm_create_task failed: ${JSON.stringify(created.isError ? created.error : created.value)}`).toBe(false)
  return (created.value as { task_id: string }).task_id
}

/**
 * Extend the RETAINED work activity of the one official Team aggregate to
 * `count` sequences (or replace the durable ID of `replaceSeq`), writing the
 * official record medium directly — the only way these source conditions
 * physically occur. Entries satisfy the official strict activity schema
 * (`task-created`, session actor, taskId, epoch-ms time). Returns the number
 * of aggregates touched; callers must assert it equals 1.
 */
export async function craftSkillsTeamActivity(sandbox: string, teamId: string, count: number, replaceSeq?: number): Promise<number> {
  const dir = join(sandbox, 'storage')
  let touched = 0
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.json') || name === `${SKILLS_UNIT_NAME}.json`) continue
    const file = join(dir, name)
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { tables?: Record<string, Record<string, Record<string, unknown> | undefined> | undefined> }
    if (parsed.tables === undefined) continue
    let fileTouched = 0
    for (const rows of Object.values(parsed.tables)) {
      for (const row of Object.values(rows ?? {})) {
        const team = row?.team as Record<string, unknown> | undefined
        if (team === undefined || team.id !== teamId) continue
        const existing = team.workActivity as { entries?: { sequence: number; id: string }[]; nextSequence?: number } | undefined
        const entries: Record<string, unknown>[] = [...(existing?.entries ?? [])]
        const maxSeq = entries.reduce((max, entry) => Math.max(max, entry.sequence as number), 0)
        const sessionId = team.captainSessionId as string
        // OFFICIAL linkage: the source validator asserts every `task-created`
        // activity references a task row that EXISTS in the same aggregate.
        // Grow the durable fixture as a consistent pair — real official task
        // rows cloned from the real one, plus their activity entries.
        const tasks = team.tasks as Record<string, unknown>[] | undefined
        const taskTemplate = tasks?.[0]
        expect(tasks !== undefined && taskTemplate !== undefined, 'the aggregate must carry at least one real task to clone').toBe(true)
        for (let sequence = maxSeq + 1; sequence <= count; sequence += 1) {
          const task = structuredClone(taskTemplate) as Record<string, unknown>
          task.id = `craft-task-${sequence}`
          task.subject = `Crafted durable work fact ${sequence}`
          tasks!.push(task)
          entries.push({
            sequence,
            id: `craft-${sequence}`,
            kind: 'task-created',
            occurredAt: 1_700_000_000_000 + sequence * 1_000, // official time schema: epoch ms
            actor: { kind: 'session', sessionId },
            taskId: `craft-task-${sequence}`,
          })
        }
        if (replaceSeq !== undefined) {
          const target = entries.find(entry => entry.sequence === replaceSeq)
          expect(target, `sequence ${replaceSeq} must be retained`).toBeTruthy()
          ;(target as { id: string }).id = `craft-${replaceSeq}-replaced`
        }
        entries.sort((left, right) => (left.sequence as number) - (right.sequence as number))
        team.workActivity = {
          schemaVersion: 1,
          nextSequence: entries.reduce((max, entry) => Math.max(max, entry.sequence as number), 0) + 1,
          entries,
        }
        fileTouched += 1
      }
    }
    if (fileTouched > 0) {
      touched += fileTouched
      await writeFile(file, JSON.stringify(parsed))
    }
  }
  return touched
}
