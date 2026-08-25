/**
 * Real-composition tests for the Team bridge job registry (M2-2, issue #76).
 *
 * Tree: AgentLoop + official durable stack + the official workflow context +
 * the swarm plugin with BOTH bridges enabled, in one Cordis tree. The
 * official `@deepseek-ai/dsh-jobs/invariant` companion is composed under the
 * projection's isolated `jobs` scope (with a second invariants service
 * mounted there) so the OFFICIAL checker validates the projected snapshots.
 * Members are real continuable subagents answering the assignment frame with
 * a real `agent_swarm_submit_task` tool call (#75 harness). Lessons 28/29:
 * `vi.waitFor` timeouts are 15s and every case carries an explicit budget of
 * at least 60s.
 */
import { mkdtemp, rm } from 'node:fs/promises'
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
import type { JobSnapshot } from '@deepseek-ai/dsh-jobs'
import * as JobsInvariant from '@deepseek-ai/dsh-jobs/invariant'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as WorkflowInvariant from '@deepseek-ai/dsh-workflow/invariant'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import { deriveTeamJobs } from '../src/runtime/jobs/projection-derive.js'
import { AttemptId, TaskId, TeamId } from '../src/domain/types.js'
import type { TeamState, TeamTask } from '../src/domain/types.js'

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
 * Content-driven member adapter (the #75 harness): a member that received a
 * Team assignment frame answers with one real `agent_swarm_submit_task` tool
 * call; every other turn is plain text (`submit: false` parks the run).
 */
class MemberAdapter extends LlmAdapter {
  private calls = 0

  constructor(private readonly options: { submit: boolean }) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  private userText(options: GenerateOptions): string {
    return options.messages
      .filter(message => message.role === 'user')
      .flatMap(message => message.content
        .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
        .map(block => block.text))
      .join('\n')
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = this.userText(options)
    const assignment = ASSIGNMENT_RE.exec(text)
    if (this.options.submit && assignment !== null) {
      const [, taskId, revision, attemptId] = assignment
      const id = CallId(`jobs-submit-${(this.calls += 1)}`)
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

/** Mount the full official + swarm + both invariant companions tree over one sandbox. */
async function mountTree(sandbox: string, options: {
  submit: boolean
  workflowBridge: boolean
  jobsBridge: boolean
  workflowDisposeGraceMs?: number
  /** Compose the official jobs invariant companion over the projection (default true when jobsBridge). */
  jobsInvariant?: boolean
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
  fibers.push(await ctx.plugin(WorkflowInvariant))
  fibers.push(await ctx.plugin(AgentSwarm, {
    memberProvider: 'spawn',
    memberMaxDepth: 1,
    schedulerProvider: 'priority-ready',
    reviewProvider: 'manual',
    workflowBridge: options.workflowBridge,
    jobsBridge: options.jobsBridge,
    ...(options.workflowDisposeGraceMs === undefined ? {} : { workflowDisposeGraceMs: options.workflowDisposeGraceMs }),
  }))
  if (options.jobsBridge === true && options.jobsInvariant !== false) {
    // The official checker's installer injects ['jobs'], which resolves
    // against the invariants service's OWNER context. A second invariants
    // service cannot be mounted under the bridge context directly (Cordis
    // rejects a same-store duplicate), so the 'invariants' key is isolated
    // there first; and in this tree the companion's namespace plugin mounts
    // without wiring its declared inject, so it is carried through the
    // official `ctx.inject` scoped-context mechanism instead (design note
    // §4.6 — both facts verified empirically).
    const bridgeCtx = ctx.agentSwarm.jobsBridge!.bridgeContext
    const invariantsScope = bridgeCtx.isolate('invariants')
    fibers.push(await invariantsScope.plugin(InvariantRegistry))
    let companionDisposer: (() => void) | undefined
    const carrier = invariantsScope.inject(['invariants'], c => {
      void JobsInvariant.apply(c).then(dispose => { companionDisposer = dispose })
    })
    fibers.push({
      dispose: async () => {
        companionDisposer?.()
        await carrier.dispose()
      },
    } as unknown as Fiber)
  }
  const adapter = new MemberAdapter({ submit: options.submit })
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = ctx.agentLoop.create(
    SessionId(`jobs-lead-${Math.random().toString(36).slice(2, 8)}`),
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
  name: 'jobs-bridge-proof',
  description: 'Prove the job projection agrees with the workflow event face.',
} as const

/** Official snapshot cross-field contract (dsh-jobs/src/invariant.ts:17-43), mirrored for observability. */
function expectOfficialSnapshotShape(snapshot: JobSnapshot): void {
  const id = String(snapshot.id)
  expect(id).toMatch(/^team-task-[1-9][0-9]*$/)
  expect(snapshot.kind).toBe('team-task')
  expect(snapshot.label.length).toBeGreaterThan(0)
  expect(Number.isSafeInteger(snapshot.startedAt)).toBe(true)
  expect(snapshot.startedAt).toBeGreaterThanOrEqual(0)
  expect(snapshot.ownerSession).toBeUndefined()
  const terminal = ['completed', 'killed', 'failed'].includes(snapshot.status)
  expect(terminal).toBe(snapshot.finishedAt !== undefined)
  if (snapshot.finishedAt !== undefined) {
    expect(snapshot.finishedAt).toBeGreaterThanOrEqual(snapshot.startedAt)
  }
}

describe('Team bridge job registry (M2-2, issue #76)', () => {
  const sandboxes: string[] = []

  afterEach(async () => {
    await Promise.all(sandboxes.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  it('projects one Team state change consistently on both official faces and converges with the task', { timeout: 90_000 }, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-jobs-bridge-'))
    sandboxes.push(sandbox)
    const tree = await mountTree(sandbox, { submit: true, workflowBridge: true, jobsBridge: true })
    try {
      const bridge = tree.ctx.agentSwarm.workflowBridge!
      const jobs = tree.ctx.agentSwarm.jobsBridge!
      const completions: JobSnapshot[] = []
      jobs.onJobDone(snapshot => { completions.push(snapshot) })

      const run = bridge.start({
        script: `phase('research')
const out = await agent('Summarize the jobs bridge proof and submit it.')
return { done: true, out }`,
        meta: { ...META },
        parent: tree.lead,
      })

      // Dual-face observation of the SAME state change: the workflow face
      // publishes agent-start while the job face registers the execution.
      const live = await vi.waitFor(() => {
        const registered = jobs.list().filter(job => job.status === 'running')
        const diagnostic = {
          run: bridge.overlay.get(run.id),
          jobs: jobs.list(),
          workflowEvents: tree.workflowEvents.map(event => event.name),
        }
        expect(registered.length, JSON.stringify(diagnostic)).toBeGreaterThanOrEqual(1)
        expect(tree.workflowEvents.some(event => event.name === 'workflow/agent-start')).toBe(true)
        return registered[0]!
      }, { timeout: 15_000 })
      expectOfficialSnapshotShape(live)
      expect(live.finishedAt).toBeUndefined()
      expect(jobs.read(live.id).text).toBe('')

      const settled = await vi.waitFor(() => run.result, { timeout: 15_000 })
      expect(settled).toMatchObject({ stopReason: 'completed' })

      // Terminal convergence + cross-face agreement: agent-end completed ⟺
      // job completed with the task output the workflow returned.
      const terminal = await vi.waitFor(() => {
        const done = jobs.list().find(job => job.id === live.id)
        expect(done?.status).toBe('completed')
        return done!
      }, { timeout: 15_000 })
      expectOfficialSnapshotShape(terminal)
      expect(jobs.read(live.id)).toMatchObject({ text: 'Workflow member output for task-1.' })
      expect(terminal.finishedAt).toBeGreaterThanOrEqual(terminal.startedAt)
      expect(tree.workflowEvents.find(event => event.name === 'workflow/agent-end')!.detail)
        .toMatchObject({ seq: 1, outcome: 'completed' })
      expect(settled.value).toEqual({ done: true, out: 'Workflow member output for task-1.' })

      // First-wins completion: exactly one contained onJobDone notice.
      expect(completions).toHaveLength(1)
      expect(completions[0]).toMatchObject({ id: live.id, status: 'completed' })
      // wait() after settlement returns the terminal snapshot idempotently.
      await expect(jobs.wait(live.id, 1_000)).resolves.toMatchObject({ id: live.id, status: 'completed' })
    } finally {
      for (const fiber of tree.fibers.toReversed()) await fiber.dispose()
    }
  })

  it('maps a cancelled run to killed jobs and refuses the job-face write paths', { timeout: 90_000 }, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-jobs-bridge-'))
    sandboxes.push(sandbox)
    const tree = await mountTree(sandbox, { submit: false, workflowBridge: true, jobsBridge: true, workflowDisposeGraceMs: 1_500 })
    try {
      const bridge = tree.ctx.agentSwarm.workflowBridge!
      const jobs = tree.ctx.agentSwarm.jobsBridge!
      const run = bridge.start({
        script: `const out = await agent('Park forever without submitting.')
return { out }`,
        meta: { ...META },
        parent: tree.lead,
      })

      const live = await vi.waitFor(() => {
        const registered = jobs.list().filter(job => job.status === 'running')
        expect(registered.length).toBeGreaterThanOrEqual(1)
        return registered[0]!
      }, { timeout: 15_000 })

      run.cancel('test cancel')
      const settled = await vi.waitFor(() => run.result, { timeout: 15_000 })
      expect(settled).toMatchObject({ stopReason: 'cancelled' })

      // The authoritative cancelAttempt lands the projection in `killed`
      // (never a fabricated `stopping`, never `failed`).
      const killed = await vi.waitFor(() => {
        const done = jobs.list().find(job => job.id === live.id)
        expect(done?.status).toBe('killed')
        return done!
      }, { timeout: 15_000 })
      expectOfficialSnapshotShape(killed)

      // Read-only red line: both job-face write paths refuse work loudly.
      expect(() => jobs.start({
        kind: 'bash',
        label: 'must refuse',
        run: () => ({ cancel: () => {}, done: Promise.resolve({ status: 'completed' }) }),
      })).toThrow(/read-only projection/)
      expect(() => jobs.kill(live.id)).toThrow(/read-only projection/)
      // The refusal left no record and no state change behind.
      expect(jobs.list().find(job => job.label === 'must refuse')).toBeUndefined()
      expect(jobs.get(live.id).status).toBe('killed')
    } finally {
      for (const fiber of tree.fibers.toReversed()) await fiber.dispose()
    }
  })

  it('rebuilds the identical projection from the durable aggregate after a crash', { timeout: 120_000 }, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-jobs-bridge-'))
    sandboxes.push(sandbox)
    const treeA = await mountTree(sandbox, { submit: false, workflowBridge: true, jobsBridge: true, jobsInvariant: false })
    let crashedJobId = ''
    let crashedStartedAt = 0
    let crashedDetail = ''
    const scopeA = treeA.ctx.agentSwarm.scopeOf(treeA.lead)
    // Crash equivalence (#75 test 3 discipline): durable aggregate stays,
    // tree A is never torn down gracefully, nothing settles the run.
    const treeB = await (async () => {
      const bridge = treeA.ctx.agentSwarm.workflowBridge!
      const run = bridge.start({
        script: `await agent('Park forever; the process is about to disappear.')`,
        meta: { ...META },
        parent: treeA.lead,
      })
      const live = await vi.waitFor(() => {
        const registered = treeA.ctx.agentSwarm.jobsBridge!.list().filter(job => job.status === 'running')
        expect(registered.length).toBeGreaterThanOrEqual(1)
        return registered[0]!
      }, { timeout: 15_000 })
      crashedJobId = live.id
      crashedStartedAt = live.startedAt
      crashedDetail = live.detail ?? ''
      void run
      return await mountTree(sandbox, { submit: false, workflowBridge: true, jobsBridge: true, jobsInvariant: false })
    })()
    try {
      const jobsB = treeB.ctx.agentSwarm.jobsBridge!
      const completionsB: JobSnapshot[] = []
      jobsB.onJobDone((snapshot: JobSnapshot) => { completionsB.push(snapshot) })

      // Explicit scope seed = the crash-recovery entry point.
      await jobsB.watchScope(scopeA)
      const rebuilt = await vi.waitFor(() => {
        expect(jobsB.list().length).toBeGreaterThanOrEqual(1)
        return jobsB.list().find(job => job.status === 'running')!
      }, { timeout: 15_000 })
      // Deterministic re-derivation: same correlation, same startedAt
      // (from the durable attempt record, not the wall clock).
      expect(rebuilt.detail).toBe(crashedDetail)
      expect(rebuilt.startedAt).toBe(crashedStartedAt)
      expect(crashedJobId).toMatch(/^team-task-/)
      expectOfficialSnapshotShape(rebuilt)
      // A rebuilt live record is not a settlement: no fabricated onJobDone,
      // and the read-only face still refuses writes on the recovered tree.
      expect(completionsB).toHaveLength(0)
      expect(() => jobsB.kill(rebuilt.id)).toThrow(/read-only projection/)
    } finally {
      for (const fiber of treeB.fibers.toReversed()) await fiber.dispose().catch(() => undefined)
      for (const fiber of treeA.fibers.toReversed()) await fiber.dispose().catch(() => undefined)
    }
  })

  it('changes nothing by default: no projection service, no default-scope takeover', { timeout: 60_000 }, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-jobs-bridge-'))
    sandboxes.push(sandbox)
    const tree = await mountTree(sandbox, { submit: true, workflowBridge: false, jobsBridge: false })
    try {
      expect(tree.ctx.agentSwarm.jobsBridge).toBeUndefined()
      expect(tree.ctx.agentSwarm.workflowBridge).toBeUndefined()
      // Neither official service name in the default scope is taken over.
      expect((tree.ctx as unknown as Record<string, unknown>).jobs).toBeUndefined()
      expect((tree.ctx as unknown as Record<string, unknown>).workflowEngine).toBeUndefined()
    } finally {
      for (const fiber of tree.fibers.toReversed()) await fiber.dispose()
    }
  })
})

describe('job projection mapping table (pure derivation, issue #76 §2.1)', () => {
  const now = 1_000

  /** One attempt fixture seed (brands are applied by {@link teamOf}). */
  type AttemptSeed = { id: string; taskId: string } & Partial<Omit<TeamState['attempts'][number], 'id' | 'taskId'>>

  function taskOf(overrides: { id: string } & Partial<Omit<TeamTask, 'id'>>): TeamTask {
    const { id, ...rest } = overrides
    return {
      revision: 1,
      subject: `subject of ${id}`,
      description: 'fixture',
      acceptanceCriteria: [],
      status: 'pending',
      blockedBy: [],
      writeScopes: [],
      priority: 0,
      createdAt: now,
      updatedAt: now,
      ...rest,
      id: TaskId(id),
    }
  }

  function teamOf(tasks: TeamTask[], attempts: AttemptSeed[]): TeamState {
    return {
      schemaVersion: 1,
      id: TeamId('team-1'),
      revision: 1,
      name: 'fixture team',
      description: 'fixture',
      captainSessionId: 'captain',
      phase: 'active',
      members: [],
      tasks,
      attempts: attempts.map((attempt, index) => {
        const { id, taskId, ...rest } = attempt
        return {
          generation: index + 1,
          memberSessionId: 'member-1',
          phase: 'running',
          assignmentPhase: 'delivered',
          evidence: [],
          createdAt: now + index,
          updatedAt: now + index,
          ...rest,
          id: AttemptId(id),
          taskId: TaskId(taskId),
        } satisfies TeamState['attempts'][number]
      }),
      messages: [],
      memory: [],
      usageCursors: {},
      nextTaskNumber: tasks.length + 1,
      nextMemoryNumber: 1,
      budget: { usedTokens: 0, usedRequests: 0, usedRetries: 0 },
      createdAt: now,
      updatedAt: now,
    }
  }

  it('projects no job for never-claimed pending work', () => {
    const derived = deriveTeamJobs(teamOf([taskOf({ id: 'task-1' })], []))
    expect(derived).toEqual([])
  })

  it('projects one running job across claim, submit, verify, in-place retry and review-reject requeue', () => {
    const task = taskOf({ id: 'task-1', status: 'in_progress', currentAttemptId: AttemptId('a-2'), ownerSessionId: 'member-1' })
    const attempts: AttemptSeed[] = [
      { id: 'a-1', taskId: 'task-1', phase: 'stale' as const, createdAt: now },
      { id: 'a-2', taskId: 'task-1', phase: 'running' as const },
    ]
    const [job] = deriveTeamJobs(teamOf([task], attempts))
    expect(job).toMatchObject({ taskId: 'task-1', status: 'running', label: 'subject of task-1', startedAt: now })
    expect(job!.finishedAt).toBeUndefined()

    const submitted = deriveTeamJobs(teamOf([{ ...task, status: 'submitted' }], [
      { ...attempts[0]! },
      { id: 'a-2', taskId: 'task-1', phase: 'submitted' },
    ]))
    expect(submitted[0]).toMatchObject({ status: 'running' })

    // Review reject requeues the task to pending WITH attempts: same job, still live.
    const rejected = deriveTeamJobs(teamOf([{ ...task, status: 'pending' }], [
      { ...attempts[0]! },
      { id: 'a-2', taskId: 'task-1', phase: 'rejected', diagnostic: 'insufficient evidence' },
    ]))
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatchObject({ status: 'running' })
  })

  it('maps task terminal states onto official job outcomes', () => {
    const completed = deriveTeamJobs(teamOf([
      taskOf({ id: 'task-1', status: 'completed', currentAttemptId: AttemptId('a-1'), output: 'final output', updatedAt: now + 5 }),
    ], [{ id: 'a-1', taskId: 'task-1', phase: 'accepted' }]))
    expect(completed[0]).toMatchObject({ status: 'completed', output: 'final output', finishedAt: now + 5 })

    const failed = deriveTeamJobs(teamOf([
      taskOf({ id: 'task-1', status: 'failed', updatedAt: now + 5 }),
    ], [{ id: 'a-1', taskId: 'task-1', phase: 'rejected', diagnostic: 'budget exhausted' }]))
    expect(failed[0]).toMatchObject({ status: 'failed', finishedAt: now + 5 })
    expect(failed[0]!.detail).toContain('budget exhausted')

    // Cancelled during execution → killed; cancelled before any claim → no job.
    const killed = deriveTeamJobs(teamOf([
      taskOf({ id: 'task-1', status: 'cancelled', updatedAt: now + 5 }),
    ], [{ id: 'a-1', taskId: 'task-1', phase: 'cancelled', diagnostic: 'workflow run cancelled' }]))
    expect(killed[0]).toMatchObject({ status: 'killed', finishedAt: now + 5 })
    expect(killed[0]!.detail).toContain('workflow run cancelled')
    expect(deriveTeamJobs(teamOf([taskOf({ id: 'task-2', status: 'cancelled' })], []))).toEqual([])
  })

  it('orders records by the task board and keeps the correlation readable', () => {
    const derived = deriveTeamJobs(teamOf([
      taskOf({ id: 'task-2', status: 'in_progress', currentAttemptId: AttemptId('a-1') }),
      taskOf({ id: 'task-1', status: 'pending' }),
    ], [{ id: 'a-1', taskId: 'task-2' }]))
    expect(derived.map(record => record.taskId)).toEqual(['task-2'])
    expect(derived[0]!.detail).toBe('task task-2 (attempt a-1)')
  })
})
