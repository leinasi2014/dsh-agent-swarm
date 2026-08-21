/**
 * Real-composition tests for the Team bridge workflow engine (M2-1, #75).
 *
 * Tree: AgentLoop + official durable stack + the official workflow context
 * (`@deepseek-ai/dsh-invariants` + the `@deepseek-ai/dsh-workflow/invariant`
 * companion) + the swarm plugin with the bridge enabled, all in one Cordis
 * tree. Members are real continuable subagents whose LLM adapter parses the
 * Team assignment frame and answers with a real `agent_swarm_submit_task`
 * tool call. Lessons 28/29 discipline: `vi.waitFor` timeouts are 15s and
 * every case carries an explicit budget of at least 60s.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import {
  CallId,
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { WorkflowError } from '@deepseek-ai/dsh-workflow'
import * as WorkflowInvariant from '@deepseek-ai/dsh-workflow/invariant'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'

/** Assignment-frame identity fields the member must echo in its submission. */
const ASSIGNMENT_RE = /Task: (task-[a-z0-9-]+), revision (\d+)\nAttempt capability: (\S+)/

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * Content-driven member adapter: a member that received a Team assignment
 * frame answers with one real `agent_swarm_submit_task` tool call carrying
 * the frame's task/revision/attempt identity; every other turn is plain
 * text. `submit` disables the tool-call arm (parked-run scenarios).
 */
class MemberAdapter extends LlmAdapter {
  private calls = 0

  constructor(private readonly options: { submit: boolean }) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  private lastUserText(options: GenerateOptions): string {
    for (let index = options.messages.length - 1; index >= 0; index -= 1) {
      const message = options.messages[index]!
      if (message.role !== 'user') continue
      return message.content
        .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('\n')
    }
    return ''
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = this.lastUserText(options)
    const assignment = ASSIGNMENT_RE.exec(text)
    if (this.options.submit && assignment !== null) {
      const [, taskId, revision, attemptId] = assignment
      const id = CallId(`wf-submit-${(this.calls += 1)}`)
      const args = JSON.stringify({
        task_id: taskId,
        expected_revision: Number(revision),
        attempt_id: attemptId,
        output: `Workflow member output for ${taskId}.`,
      })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'agent_swarm_submit_task', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'agent_swarm_submit_task', arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 24 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    for (const chunk of textResponse('Member ready.')) yield chunk
  }
}

interface MountedTree {
  ctx: Context
  fibers: Fiber[]
  adapter: MemberAdapter
  lead: ReturnType<Context['agentLoop']['create']>
  workflowEvents: Array<{ name: string; runId: string | undefined; detail: unknown }>
}

/** Mount the full official + swarm + workflow-invariant tree over one sandbox. */
async function mountTree(sandbox: string, options: {
  submit: boolean
  workflowBridge: boolean
  workflowDisposeGraceMs?: number
  /** Skip the official invariant companion (default false = compose it). */
  withoutInvariantCompanion?: boolean
}): Promise<MountedTree> {
  const ctx = new Context()
  const fibers: Fiber[] = []
  await mountAgentLoopTestDependencies(ctx)
  fibers.push(await ctx.plugin(SqliteSessionPersistence, { path: join(sandbox, 'sessions', 'sessions.db') }))
  fibers.push(await ctx.plugin(Storage))
  fibers.push(await ctx.plugin(StorageJson, { root: join(sandbox, 'storage') }))
  fibers.push(await ctx.plugin(StorageDomain, { backend: 'json' }))
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
  fibers.push(await ctx.plugin(SubagentService))
  fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
  fibers.push(await ctx.plugin(InvariantRegistry))
  if (options.withoutInvariantCompanion !== true) {
    fibers.push(await ctx.plugin(WorkflowInvariant))
  }
  fibers.push(await ctx.plugin(AgentSwarm, {
    memberProvider: 'spawn',
    memberMaxDepth: 1,
    schedulerProvider: 'priority-ready',
    reviewProvider: 'manual',
    workflowBridge: options.workflowBridge,
    ...(options.workflowDisposeGraceMs === undefined ? {} : { workflowDisposeGraceMs: options.workflowDisposeGraceMs }),
  }))
  const adapter = new MemberAdapter({ submit: options.submit })
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = ctx.agentLoop.create(
    SessionId(`wf-lead-${Math.random().toString(36).slice(2, 8)}`),
    { provider: 'mock', model: 'mock' },
    { cwd: join(sandbox, 'workspace') },
  )
  const workflowEvents: Array<{ name: string; runId: string | undefined; detail: unknown }> = []
  ctx.on('internal/dispatch', (_mode, name, args) => {
    if (typeof name !== 'string' || !name.startsWith('workflow/')) return
    const info = args[0] as { id?: string } | undefined
    workflowEvents.push({ name, runId: info?.id, detail: args[1] })
  })
  return { ctx, fibers, adapter, lead, workflowEvents }
}

const META = {
  name: 'bridge-proof',
  description: 'Prove the Team bridge executes an official workflow run.',
} as const

function scriptOf(body: string): string {
  return body
}

describe('Team bridge workflow engine (M2-1, issue #75)', () => {
  const sandboxes: string[] = []

  afterEach(async () => {
    await Promise.all(sandboxes.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  it('runs a workflow to completion through a real Team and the official event stream', { timeout: 90_000 }, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-wf-bridge-'))
    sandboxes.push(sandbox)
    const tree = await mountTree(sandbox, { submit: true, workflowBridge: true })
    try {
      const bridge = tree.ctx.agentSwarm.workflowBridge
      expect(bridge).toBeDefined()
      const script = scriptOf(`phase('research')
log('starting one workflow agent')
const out = await agent('Summarize the bridge proof and submit it.')
return { done: true, out }`)
      const run = bridge!.start({ script, meta: { ...META }, parent: tree.lead })

      const settled = await vi.waitFor(() => run.result, { timeout: 15_000 })
      expect(settled).toMatchObject({ stopReason: 'completed' })
      expect(settled.value).toEqual({ done: true, out: 'Workflow member output for task-1.' })
      expect(settled.agentsStarted).toBe(1)

      // Official event-stream alignment, recorded through internal/dispatch
      // while the official workflow invariant companion is composed in-tree.
      const names = tree.workflowEvents.map(event => event.name)
      expect(names).toEqual([
        'workflow/start',
        'workflow/phase',
        'workflow/log',
        'workflow/agent-start',
        'workflow/agent-end',
        'workflow/end',
      ])
      expect(tree.workflowEvents[0]!.runId).toBe(run.id)
      expect(tree.workflowEvents[3]!.detail).toMatchObject({ seq: 1, label: 'Summarize the bridge proof and submit it.' })
      expect(tree.workflowEvents[4]!.detail).toMatchObject({ seq: 1, outcome: 'completed' })
      expect(tree.workflowEvents[5]!.detail).toMatchObject({ stopReason: 'completed', agentsStarted: 1 })

      // Overlay-as-truth: the durable run record is the only run storage.
      const overlay = bridge!.overlay.get(run.id)
      expect(overlay).toMatchObject({
        state: 'completed',
        stopReason: 'completed',
        agentsStarted: 1,
        scope: tree.ctx.agentSwarm.scopeOf(tree.lead),
      })

      // The Team aggregate carries the full protocol trail and is archived.
      await vi.waitFor(async () => {
        const snapshot = await tree.ctx.agentSwarm.domain.snapshot(
          tree.ctx.agentSwarm.scopeOf(tree.lead), AgentSwarm.TeamId(overlay!.teamId), tree.lead.id,
        )
        expect(snapshot.team.phase).toBe('archived')
        expect(snapshot.team.members[0]).toMatchObject({ name: 'wf-agent-1' })
        expect(snapshot.team.tasks[0]).toMatchObject({ status: 'completed', subject: 'Summarize the bridge proof and submit it.' })
      }, { timeout: 15_000 })
    } finally {
      for (const fiber of tree.fibers.toReversed()) await fiber.dispose()
    }
  })

  it('settles a cancelled run bounded, with synthesized agent ends and an archived Team', { timeout: 90_000 }, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-wf-bridge-'))
    sandboxes.push(sandbox)
    const tree = await mountTree(sandbox, { submit: false, workflowBridge: true, workflowDisposeGraceMs: 1_500 })
    try {
      const bridge = tree.ctx.agentSwarm.workflowBridge!
      const run = bridge.start({
        script: scriptOf(`const out = await agent('Park forever without submitting.')
return { out }`),
        meta: { ...META },
        parent: tree.lead,
      })

      // Wait until the run is live on its Team (agent started, task in flight).
      await vi.waitFor(() => {
        expect(tree.workflowEvents.some(event => event.name === 'workflow/agent-start')).toBe(true)
      }, { timeout: 15_000 })
      const overlayRunning = bridge.overlay.get(run.id)
      expect(overlayRunning).toMatchObject({ state: 'running' })

      const cancelAt = Date.now()
      run.cancel('test cancel')
      const settled = await vi.waitFor(() => run.result, { timeout: 15_000 })
      expect(Date.now() - cancelAt).toBeLessThan(15_000)
      expect(settled).toMatchObject({ stopReason: 'cancelled' })
      expect(settled.error).toContain('test cancel')
      expect(settled.agentsStarted).toBe(1)

      // Exactly one paired cancelled end; the end precedes workflow/end.
      const names = tree.workflowEvents.map(event => event.name)
      expect(names.filter(name => name === 'workflow/agent-end')).toHaveLength(1)
      expect(tree.workflowEvents.find(event => event.name === 'workflow/agent-end')!.detail)
        .toMatchObject({ seq: 1, outcome: 'cancelled' })
      expect(names.indexOf('workflow/agent-end')).toBeLessThan(names.indexOf('workflow/end'))
      expect(tree.workflowEvents.find(event => event.name === 'workflow/end')!.detail)
        .toMatchObject({ stopReason: 'cancelled', agentsStarted: 1 })

      expect(bridge.overlay.get(run.id)).toMatchObject({ state: 'cancelled', stopReason: 'cancelled' })
      await vi.waitFor(async () => {
        const snapshot = await tree.ctx.agentSwarm.domain.snapshot(
          tree.ctx.agentSwarm.scopeOf(tree.lead), AgentSwarm.TeamId(overlayRunning!.teamId), tree.lead.id,
        )
        expect(snapshot.team.phase).toBe('archived')
      }, { timeout: 15_000 })

      await run.dispose()
    } finally {
      for (const fiber of tree.fibers.toReversed()) await fiber.dispose()
    }
  })

  it('recovers a crashed run from the overlay as interrupted, without re-driving it', { timeout: 120_000 }, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-wf-bridge-'))
    sandboxes.push(sandbox)
    const treeA = await mountTree(sandbox, { submit: false, workflowBridge: true })
    let crashedRunId = ''
    let crashedTeamId = ''
    const scopeA = treeA.ctx.agentSwarm.scopeOf(treeA.lead)
    const captainSession = treeA.lead.id
    // Crash equivalence: the durable state stays; the live tree is never torn
    // down gracefully (a crashed process runs no disposers) and nothing
    // settles the run. Tree A is only cleaned up after tree B is gone.
    const treeB = await (async () => {
      const bridge = treeA.ctx.agentSwarm.workflowBridge!
      const run = bridge.start({
        script: `await agent('Park forever; the process is about to disappear.')`,
        meta: { ...META },
        parent: treeA.lead,
      })
      crashedRunId = run.id
      await vi.waitFor(() => {
        expect(treeA.workflowEvents.some(event => event.name === 'workflow/agent-start')).toBe(true)
      }, { timeout: 15_000 })
      const running = bridge.overlay.get(run.id)
      expect(running).toMatchObject({ state: 'running' })
      crashedTeamId = running!.teamId
      // Wait until the scheduler has claimed and delivered the assignment: a
      // mid-flight in_progress task is the honest crash surface.
      await vi.waitFor(async () => {
        const snapshot = await treeA.ctx.agentSwarm.domain.snapshot(scopeA, AgentSwarm.TeamId(crashedTeamId), captainSession)
        expect(snapshot.team.tasks[0]).toMatchObject({ status: 'in_progress' })
      }, { timeout: 15_000 })
      return await mountTree(sandbox, { submit: false, workflowBridge: true })
    })()
    try {
      const bridgeB = treeB.ctx.agentSwarm.workflowBridge!
      const recovered = bridgeB.overlay.get(crashedRunId)
      expect(recovered).toBeDefined()
      expect(recovered!.state).toBe('interrupted')
      expect(recovered!.error).toContain('process boundary')
      expect(recovered!.teamId).toBe(crashedTeamId)
      // No re-drive: tree B emitted no workflow events for the recovered run.
      expect(treeB.workflowEvents.filter(event => event.runId === crashedRunId)).toEqual([])
      // The Team aggregate survived intact: readable through the recovering
      // domain by its captain's durable session identity.
      const snapshot = await treeB.ctx.agentSwarm.domain.snapshot(
        scopeA, AgentSwarm.TeamId(crashedTeamId), captainSession,
      )
      expect(snapshot.team.members[0]).toMatchObject({ name: 'wf-agent-1' })
      expect(snapshot.team.tasks[0]).toMatchObject({ status: 'in_progress' })
    } finally {
      for (const fiber of treeB.fibers.toReversed()) await fiber.dispose().catch(() => undefined)
      for (const fiber of treeA.fibers.toReversed()) await fiber.dispose().catch(() => undefined)
    }
  })

  it('validates requests synchronously with the official error surface', { timeout: 60_000 }, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-wf-bridge-'))
    sandboxes.push(sandbox)
    const tree = await mountTree(sandbox, { submit: true, workflowBridge: true })
    try {
      const bridge = tree.ctx.agentSwarm.workflowBridge!
      expect(() => bridge.start({
        script: 'return 1',
        meta: { ...META, extra: 'unknown field' } as unknown as typeof META,
        parent: tree.lead,
      })).toThrow(WorkflowError)

      expect(() => bridge.start({
        script: 'this is not ) valid javascript',
        meta: { ...META },
        parent: tree.lead,
      })).toThrow(WorkflowError)

      expect(() => bridge.start({
        script: 'return 1',
        meta: { ...META },
        maxTotalAgents: 1_000_000,
        parent: tree.lead,
      })).toThrow(WorkflowError)

      expect(() => bridge.start({
        script: 'return 1',
        meta: { ...META },
        subagentProvider: 'no-such-provider',
        parent: tree.lead,
      })).toThrow(WorkflowError)
      // Nothing was published for any rejected request.
      expect(tree.workflowEvents).toEqual([])
    } finally {
      for (const fiber of tree.fibers.toReversed()) await fiber.dispose()
    }
  })

  it('changes nothing by default: no bridge, no overlay domain, no engine takeover', { timeout: 60_000 }, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-wf-bridge-'))
    sandboxes.push(sandbox)
    const tree = await mountTree(sandbox, { submit: true, workflowBridge: false })
    try {
      expect(tree.ctx.agentSwarm.workflowBridge).toBeUndefined()
      // The default scope's official service name is untouched.
      expect((tree.ctx as unknown as Record<string, unknown>).workflowEngine).toBeUndefined()
      // No overlay unit file exists in the storage medium.
      const files = await readdir(join(sandbox, 'storage'))
      expect(files.some(name => name.includes('agent_swarm_workflow'))).toBe(false)
    } finally {
      for (const fiber of tree.fibers.toReversed()) await fiber.dispose()
    }
  })
})
