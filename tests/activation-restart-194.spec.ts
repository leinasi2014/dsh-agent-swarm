/** Startup recovery, not a manual reattach disguised as a restart test. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import { AgentSwarmRuntime } from '../src/runtime/orchestrator-runtime.js'
import { GatedAdapter, mount as mountGated } from './helpers/gated-composition.js'
import {
  mountRestartComposition as mount, disposeRestartComposition as dispose,
  restartTool as tool, restartSnapshot as snapshot, RESTART_SIGNAL as SIGNAL,
  type RestartMounted,
} from './helpers/restart-real-composition.js'

const ROOT = SessionId('restart-194-root')

class ReviewAfterRestart extends GatedAdapter {
  captainRequests = 0
  constructor(private readonly captainId: string, private readonly submitted: { id: string; revision: number; currentAttemptId?: string }) { super() }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.sessionId !== this.captainId) {
      yield* super.stream(options)
      return
    }
    this.captainRequests += 1
    if (this.captainRequests === 1) {
      const id = CallId('restart-194-review')
      const args = JSON.stringify({ task_id: this.submitted.id, expected_revision: this.submitted.revision, attempt_id: this.submitted.currentAttemptId, decision: 'accept' })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'agent_swarm_review_task', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'agent_swarm_review_task', arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Reviewed the durable submission.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Reviewed the durable submission.' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function seedSubmitted(sandbox: string) {
  const initial = new GatedAdapter()
  let first: RestartMounted | undefined
  try {
    first = await mount(sandbox, 0, undefined, undefined, ctx => { ctx.llm.registerAdapter(['mock'], initial) })
    const root = first.ctx.agentLoop.create(ROOT, { provider: 'mock', model: 'mock' }, { cwd: join(sandbox, 'workspace') })
    const created = await tool(first.ctx, root, '194-create', 'agent_swarm_create_managed', { name: 'Restart in-flight', description: 'Continue the submitted DAG.' })
    expect(created.isError).toBe(false)
    const { team_id: teamId, captain_session_id: captainId } = created.value as { team_id: string; captain_session_id: string }
    const captain = first.ctx.agents.get(SessionId(captainId))!
    const added = await tool(first.ctx, captain, '194-add', 'agent_swarm_add_member', { name: 'worker', role: 'Own the exact attempt.' })
    expect(added.isError).toBe(false)
    const memberId = (added.value as { session_id: string }).session_id
    const task = await tool(first.ctx, captain, '194-task', 'agent_swarm_create_task', { subject: 'Before restart', description: 'Submit once.', target_member: 'worker' })
    expect(task.isError).toBe(false)
    initial.open()
    await vi.waitFor(async () => {
      const state = await snapshot(first!.ctx, captain, teamId)
      expect(state.team.tasks[0]).toMatchObject({ status: 'in_progress', ownerSessionId: memberId })
      expect(state.team.attempts[0]?.assignmentPhase).toBe('delivered')
    }, { timeout: 5_000 })
    const running = (await snapshot(first.ctx, captain, teamId)).team.tasks[0]!
    const dependent = await tool(first.ctx, captain, '194-dependent', 'agent_swarm_create_task', { subject: 'After restart', description: 'Wait for original review.', target_member: 'worker', blocked_by: [running.id] })
    expect(dependent.isError).toBe(false)
    const member = first.ctx.agents.get(SessionId(memberId))!
    const submittedResult = await tool(first.ctx, member, '194-submit', 'agent_swarm_submit_task', { task_id: running.id, expected_revision: running.revision, attempt_id: running.currentAttemptId, output: 'Durable submitted result.' })
    expect(submittedResult.isError).toBe(false)
    const submitted = (await snapshot(first.ctx, captain, teamId)).team.tasks[0]!
    expect(submitted.status).toBe('submitted')
    const scope = first.ctx.agentSwarm.scopeOf(captain)
    // Same discovered workspace, but these managed Teams must not wake.
    const domain = first.ctx.agentSwarm.domain
    for (const terminal of ['empty', 'archived', 'completed'] as const) {
      const id = `194-${terminal}-captain`
      const team = await domain.createTeam(scope, id, terminal, 'Must stay dormant.', -1, `managed:${ROOT}:detached:${terminal}`)
      if (terminal === 'archived') await domain.archiveTeam(scope, team.id, id, 'Finished')
      if (terminal === 'completed') {
        const worker = '194-completed-worker'
        await domain.provisionMember(scope, team.id, id, { name: worker, sessionId: worker, role: 'Completed', provider: 'spawn' })
        await domain.settleMember(scope, team.id, worker, { active: true })
        const done = await domain.createTask(scope, team.id, id, { subject: 'Done', description: 'Already accepted.' })
        const claim = await domain.claimTask(scope, team.id, id, done.id, done.revision, worker)
        const submission = await domain.submitTask(scope, team.id, worker, done.id, claim.task.revision, claim.attempt.id, 'Done', [])
        await domain.reviewTask(scope, team.id, id, done.id, submission.revision, claim.attempt.id, 'accept')
      }
    }
    return { teamId, captainId, memberId, submitted, scope }
  } finally { initial.open(); if (first !== undefined) await dispose(first) }
}

it('startup with zero live roots restores the managed Captain, reviews the exact submitted attempt, and drives its dependency', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-activation-194-'))
  let second: RestartMounted | undefined
  let recovered: ReviewAfterRestart | undefined
  try {
    const { teamId, captainId, memberId, submitted, scope } = await seedSubmitted(sandbox)
    recovered = new ReviewAfterRestart(captainId, submitted)
    const resumes: string[] = []
    const follows: Array<{ parent: string; child: string }> = []
    let rootDisposed = 0
    second = await mount(sandbox, 0, undefined, undefined, ctx => {
      expect(ctx.agents.roots()).toEqual([])
      ctx.llm.registerAdapter(['mock'], recovered!)
      const resume = ctx.agents.resume.bind(ctx.agents)
      vi.spyOn(ctx.agents, 'resume').mockImplementation(async options => {
        resumes.push(options.resumeSessionId)
        if (options.resumeSessionId !== ROOT) expect(options.setup).toBeTypeOf('function')
        const handle = await resume(options)
        if (options.resumeSessionId !== ROOT) return handle
        return { agent: handle.agent, dispose: async () => { rootDisposed += 1; await handle.dispose() } }
      })
      const followup = ctx.subagents.followup.bind(ctx.subagents)
      vi.spyOn(ctx.subagents, 'followup').mockImplementation(async (parent, child, content, options) => {
        follows.push({ parent: parent.id, child })
        return await followup(parent, child, content, options)
      })
    })
    // No test call reattaches, prompts, or drives the restarted runtime.
    await vi.waitFor(() => expect(recovered!.captainRequests).toBeGreaterThan(0), { timeout: 5_000 })
    await vi.waitFor(async () => {
      const state = (await second!.ctx.agentSwarm.listTeamAggregates(scope)).find(team => team.id === teamId)!
      expect(state.tasks[0]).toMatchObject({ status: 'completed', currentAttemptId: submitted.currentAttemptId })
      expect(state.tasks[1], JSON.stringify(state.attempts)).toMatchObject({ status: 'in_progress', ownerSessionId: memberId })
      expect(state.members).toHaveLength(1)
    }, { timeout: 5_000 })
    expect(follows.filter(item => item.child === captainId)).toEqual([{ parent: ROOT, child: captainId }])
    expect(follows.some(item => item.parent === captainId && item.child === memberId)).toBe(true)
    expect(resumes.filter(id => id === ROOT)).toHaveLength(1)
    expect(resumes.some(id => id.startsWith('194-empty') || id.startsWith('194-archived') || id.startsWith('194-completed'))).toBe(false)
    const history = await second.ctx.sessionPersistence.inspect(SessionId(memberId), SIGNAL)
    expect(history.events.filter(event => event.type === 'user/message' && JSON.stringify(event.data).includes('Before restart') && JSON.stringify(event.data).includes('Team assignment from captain.'))).toHaveLength(1)
    expect((await second.ctx.agentSwarm.listTeamAggregates(scope)).find(team => team.id === AgentSwarm.TeamId(teamId))?.attempts.find(attempt => attempt.id === submitted.currentAttemptId)?.phase).toBe('accepted')
    await second.ctx.agentSwarm.recoverDormantManagedTeams()
    expect(follows.filter(item => item.child === captainId)).toHaveLength(1)
    await second.fibers.at(-1)!.dispose()
    expect(rootDisposed).toBe(1)
    expect(second.ctx.agents.get(ROOT)).toBeUndefined()
    expect(second.ctx.agents.get(SessionId(captainId))).toBeUndefined()
    expect(second.ctx.agents.get(SessionId(memberId))).toBeUndefined()
  } finally {
    recovered?.open()
    if (second !== undefined) await dispose(second)
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 30_000)

it.each(['root', 'captain'] as const)('fails plugin startup with actionable lineage and preserves durable submission when %s cannot resume', async target => {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-activation-194-error-'))
  try {
    const seeded = await seedSubmitted(sandbox)
    const fault = new Error(`injected ${target} persistence failure`)
    let rootDisposed = 0
    const failure = await mount(sandbox, 0, undefined, undefined, ctx => {
      const resume = ctx.agents.resume.bind(ctx.agents)
      vi.spyOn(ctx.agents, 'resume').mockImplementation(async options => {
        if (target === 'root' && options.resumeSessionId === ROOT) throw fault
        const handle = await resume(options)
        if (options.resumeSessionId !== ROOT) return handle
        return { agent: handle.agent, dispose: async () => { rootDisposed += 1; await handle.dispose() } }
      })
      if (target === 'captain') {
        const inspect = ctx.sessionPersistence.inspect.bind(ctx.sessionPersistence)
        vi.spyOn(ctx.sessionPersistence, 'inspect').mockImplementation(async (id, signal) => {
          if (id === seeded.captainId) throw fault
          return await inspect(id, signal)
        })
      }
    }).then(() => undefined, error => error)
    expect(failure).toMatchObject({
      code: 'TEAM_PARENT_REATTACH_FAILED',
      message: expect.stringContaining(seeded.captainId),
      cause: expect.any(Error),
    })
    for (const identity of [ROOT, seeded.teamId, seeded.captainId]) expect(failure.message).toContain(identity)
    expect(rootDisposed).toBe(target === 'captain' ? 1 : 0)
    // A fresh mount with recovery discovery excluded reads the same authority
    // without any manual child activation or mutation of the failed Team.
    const readback = await mount(sandbox, 0, undefined, undefined, ctx => {
      vi.spyOn(ctx.sessionPersistence, 'list').mockResolvedValue([])
    })
    try {
      const team = (await readback.ctx.agentSwarm.listTeamAggregates(seeded.scope)).find(item => item.id === seeded.teamId)!
      expect(team.tasks[0]).toMatchObject({ status: 'submitted', currentAttemptId: seeded.submitted.currentAttemptId })
      expect(team.members).toHaveLength(1)
    } finally { await dispose(readback) }
  } finally { await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})

it.each(['root', 'captain'] as const)('rejects a %s workspace mismatch before any followup', async target => {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-194-workspace-'))
  let mounted: RestartMounted | undefined
  try {
    const seed = await seedSubmitted(sandbox)
    let followups = 0
    const failure = await mount(sandbox, 0, undefined, undefined, ctx => {
      const list = ctx.sessionPersistence.list.bind(ctx.sessionPersistence)
      vi.spyOn(ctx.sessionPersistence, 'list').mockImplementation(async signal => (await list(signal)).map(header =>
        header.id === (target === 'root' ? ROOT : seed.captainId) ? { ...header, cwd: join(sandbox, 'other-workspace') } : header))
      const followup = ctx.subagents.followup.bind(ctx.subagents)
      vi.spyOn(ctx.subagents, 'followup').mockImplementation(async (...args) => { followups += 1; return await followup(...args) })
    }).then(value => { mounted = value; return undefined }, error => error)
    expect(failure).toMatchObject({ code: 'TEAM_PARENT_REATTACH_FAILED' })
    expect(followups).toBe(0)
  } finally {
    if (mounted !== undefined) await dispose(mounted)
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

it('retains the original typed recovery failure when runtime cleanup also fails', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-194-double-error-'))
  let restore: (() => void) | undefined
  try {
    await seedSubmitted(sandbox)
    const cleanupFailure = new Error('injected cleanup failure')
    const failure = await mount(sandbox, 0, undefined, undefined, ctx => {
      vi.spyOn(ctx.agents, 'resume').mockRejectedValue(new Error('injected root recovery failure'))
      const original = AgentSwarmRuntime.prototype.dispose
      const spy = vi.spyOn(AgentSwarmRuntime.prototype, 'dispose').mockImplementation(async function (this: AgentSwarmRuntime) {
        await original.call(this)
        throw cleanupFailure
      })
      restore = () => spy.mockRestore()
    }).then(() => undefined, error => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.errors).toEqual([expect.objectContaining({ code: 'TEAM_PARENT_REATTACH_FAILED' }), cleanupFailure])
  } finally {
    restore?.()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

async function reviewFixture(sandbox: string, dependent: boolean) {
  const composition = await mountGated(sandbox, 0, '194-review-observer')
  const { ctx, scope, lead } = composition
  const domain = ctx.agentSwarm.domain, teamId = AgentSwarm.TeamId(composition.teamId)
  const owner = '194-review-member'
  await domain.provisionMember(scope, teamId, lead.id, { name: owner, role: 'Review boundary', sessionId: owner, provider: 'spawn' })
  await domain.settleMember(scope, teamId, owner, { active: true })
  const task = await domain.createTask(scope, teamId, lead.id, { subject: 'Review', description: 'Review completion boundary.' })
  const claim = await domain.claimTask(scope, teamId, lead.id, task.id, task.revision, owner)
  const submitted = await domain.submitTask(scope, teamId, owner, task.id, claim.task.revision, claim.attempt.id, 'Submitted', [])
  if (dependent) await domain.createTask(scope, teamId, lead.id, { subject: 'Next', description: 'Dependent.', blockedBy: [task.id] })
  return { composition, input: { taskId: task.id, expectedRevision: submitted.revision, attemptId: claim.attempt.id, decision: 'accept' as const } }
}

it('an actual Scheduler Provider may review during select without awaiting its own queued successor', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-194-reentrant-'))
  const { composition, input } = await reviewFixture(sandbox, true)
  const abort = new AbortController()
  try {
    let reviewed = false
    let passes = 0
    composition.ctx.agentSwarm.registerSchedulerProvider('194-review-observer', {
      select: async () => {
        passes += 1
        if (!reviewed) {
          reviewed = true
          const result = await composition.ctx.agentSwarm.reviewTask({ agent: composition.lead, signal: abort.signal }, input)
          expect(result.task.status).toBe('completed')
        }
        return []
      },
    })
    await composition.ctx.agentSwarm.recoverAgent(composition.lead)
    await vi.waitFor(() => expect(passes).toBe(2), { timeout: 1_000 })
  } finally {
    abort.abort(new Error('test cleanup'))
    composition.adapter.open()
    for (const fiber of composition.fibers.toReversed()) await fiber.dispose()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

it.each(['cancel', 'dispose'] as const)('review admission wait exits on %s while the committed review remains completed', async mode => {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-194-admission-'))
  const { composition, input } = await reviewFixture(sandbox, true)
  const abort = new AbortController()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let entered!: () => void
  const admission = new Promise<void>(resolve => { entered = resolve })
  try {
    composition.ctx.agentSwarm.registerSchedulerProvider('194-review-observer', {
      select: async () => { entered(); await held; return [] },
    })
    const review = composition.ctx.agentSwarm.reviewTask({ agent: composition.lead, signal: abort.signal }, input)
    const rejected = expect(review).rejects.toMatchObject({ code: 'TEAM_REVIEW_ADMISSION_INTERRUPTED' })
    await admission
    const team = (await composition.ctx.agentSwarm.listTeamAggregates(composition.scope))[0]!
    expect(team.tasks[0]?.status).toBe('completed')
    let disposing: Promise<void> | undefined
    if (mode === 'cancel') abort.abort(new Error('caller cancelled'))
    else disposing = composition.ctx.agentSwarm.dispose()
    await rejected
    release()
    await disposing
  } finally {
    release()
    composition.adapter.open()
    for (const fiber of composition.fibers.toReversed()) await fiber.dispose()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

it('does not create an admission pass when a review is invalid or acceptance leaves no ready work', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-194-no-ready-'))
  const { composition, input } = await reviewFixture(sandbox, false)
  try {
    const select = vi.fn(() => [])
    composition.ctx.agentSwarm.registerSchedulerProvider('194-review-observer', { select })
    await expect(composition.ctx.agentSwarm.reviewTask({ agent: composition.lead, signal: SIGNAL }, { ...input, expectedRevision: 0 })).rejects.toMatchObject({ code: 'TEAM_TASK_STALE_REVISION' })
    const result = await composition.ctx.agentSwarm.reviewTask({ agent: composition.lead, signal: SIGNAL }, input)
    expect(result.task.status).toBe('completed')
    expect(select).not.toHaveBeenCalled()
  } finally {
    composition.adapter.open()
    for (const fiber of composition.fibers.toReversed()) await fiber.dispose()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

it('reports a failed scheduling pass without implying the accepted review rolled back', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-194-pass-failed-'))
  const { composition, input } = await reviewFixture(sandbox, true)
  try {
    composition.ctx.agentSwarm.registerSchedulerProvider('194-review-observer', { select: () => { throw new Error('injected Provider failure') } })
    await expect(composition.ctx.agentSwarm.reviewTask({ agent: composition.lead, signal: SIGNAL }, input)).rejects.toMatchObject({
      code: 'TEAM_REVIEW_ADMISSION_FAILED', message: expect.stringContaining('committed as completed'),
    })
    expect((await composition.ctx.agentSwarm.listTeamAggregates(composition.scope))[0]?.tasks[0]?.status).toBe('completed')
  } finally {
    composition.adapter.open()
    for (const fiber of composition.fibers.toReversed()) await fiber.dispose()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

it('reports a readiness read failure after the real review committed without inviting a duplicate review', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-194-readiness-failed-'))
  const { composition, input } = await reviewFixture(sandbox, true)
  try {
    const domain = composition.ctx.agentSwarm.domain
    const review = domain.reviewTask.bind(domain)
    const injected = new Error('injected post-review readiness read failure')
    vi.spyOn(domain, 'reviewTask').mockImplementation(async (...args) => {
      const committed = await review(...args)
      expect(committed.status).toBe('completed')
      vi.spyOn(domain, 'snapshot').mockRejectedValueOnce(injected)
      return committed
    })
    const failure = await composition.ctx.agentSwarm.reviewTask({ agent: composition.lead, signal: SIGNAL }, input).catch(error => error)
    expect((await composition.ctx.agentSwarm.listTeamAggregates(composition.scope))[0]?.tasks[0]?.status).toBe('completed')
    expect(failure).toMatchObject({
      code: 'TEAM_REVIEW_ADMISSION_FAILED',
      message: expect.stringMatching(/committed as completed.*re-read/u),
      cause: injected,
    })
  } finally {
    composition.adapter.open()
    for (const fiber of composition.fibers.toReversed()) await fiber.dispose()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
