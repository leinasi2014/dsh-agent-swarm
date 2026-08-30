/**
 * F3 (M1B): persisted-child provisioning reconciliation across the crash
 * window between child Session persistence and the Team activation commit.
 *
 * Every test composes the real official services a deployment composes —
 * AgentLoop with the in-process spawn provider (real continuable children),
 * JSONL session persistence (real durable child artifacts) and the storage
 * stack harness (real `agent_swarm` Storage Domain aggregate). The crash
 * window is injected by construction, not by process death: committing the
 * `provisioning` record directly, establishing the real child through
 * `ctx.subagents.startContinuable`, letting its initial turn durably
 * checkpoint the accepted prompt, then draining the child so the recovery
 * scan sees exactly the durable facts a killed process leaves behind.
 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import { mountStorageStackOn } from './helpers/storage-stack.js'

const SIGNAL = new AbortController().signal

class ImmediateAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    const text = 'Acknowledged.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class MatrixAdapter extends LlmAdapter {
  calls = 0
  private readonly outcomesBySession = new Map<string, 'completed' | 'failed'>()
  private releaseInitialTurn!: () => void
  private readonly initialTurnGate = new Promise<void>(resolve => { this.releaseInitialTurn = resolve })

  constructor(private readonly outcomes: Array<'completed' | 'failed'>) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override providerRetryPolicy() {
    return {
      mode: 'normal' as const,
      maxRetries: 0,
      retryableCodes: [],
      initialDelayMs: 0,
      maxDelayMs: 0,
      jitterRatio: 0,
    }
  }

  release(): void { this.releaseInitialTurn() }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    const sessionKey = options.sessionId ?? `unidentified-${this.calls}`
    const signal = options.signal ?? new AbortController().signal
    let outcome = this.outcomesBySession.get(sessionKey)
    if (outcome === undefined) {
      outcome = this.outcomes.shift()
      if (outcome === undefined) throw new Error('matrix adapter received an unexpected child session')
      this.outcomesBySession.set(sessionKey, outcome)
    }
    if (!signal.aborted) {
      await Promise.race([
        this.initialTurnGate,
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
      ])
    }
    signal.throwIfAborted()
    if (outcome === 'failed') throw new Error('injected child startup failure')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Initial turn completed.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Initial turn completed.' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** The durable composition under test: one captain lead over real services. */
interface CaptainStack {
  readonly ctx: Context
  readonly lead: ReturnType<Context['agentLoop']['create']>
  readonly teamId: string
}

async function mountCaptain(
  sandbox: string,
  fibers: Fiber[],
  leadId: string,
  teamName: string,
  options: { projections?: boolean; adapter?: LlmAdapter; maxMembers?: number } = {},
): Promise<CaptainStack> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  fibers.push(await ctx.plugin(SqliteSessionPersistence, { path: join(sandbox, 'sessions', 'sessions.db') }))
  await mountStorageStackOn(ctx, join(sandbox, 'storage'))
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
  // The live-preferred `listChildren` evidence rung needs the official
  // projection registry (and with it the subagent projection unit); the
  // fallback test omits it to pin the official inspect-only baseline.
  if (options.projections !== false) fibers.push(await ctx.plugin(SessionProjection))
  fibers.push(await ctx.plugin(SubagentService))
  fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
  fibers.push(await ctx.plugin(AgentSwarm, {
    memberProvider: 'spawn', memberMaxDepth: 1, ...(options.maxMembers === undefined ? {} : { maxMembers: options.maxMembers }),
  }))
  ctx.llm.registerAdapter(['mock'], options.adapter ?? new ImmediateAdapter())
  const lead = ctx.agentLoop.create(
    SessionId(leadId),
    { provider: 'mock', model: 'mock' },
    { cwd: join(sandbox, 'workspace') },
  )
  const created = await ctx.tools.execute({
    signal: SIGNAL,
    callId: CallId('create'),
    name: 'agent_swarm_create',
    arguments: { name: teamName, description: `Prove persisted-child reconciliation for ${leadId}.` },
    agent: lead,
  })
  expect(created.isError).toBe(false)
  return { ctx, lead, teamId: (created.value as { team_id: string }).team_id }
}

/**
 * Inject the kill -9 half-window: commit the provisioning record, establish
 * the real continuable child, let its initial turn durably checkpoint the
 * accepted prompt, then drain the child so the recovery scan sees exactly a
 * reloaded process's cold durable facts.
 */
async function injectCrashWindow(
  stack: CaptainStack,
  input: { name: string; role: string; recordProvider: string },
): Promise<SessionId> {
  const scope = stack.ctx.agentSwarm.scopeOf(stack.lead)
  const teamId = AgentSwarm.TeamId(stack.teamId)
  const childId = SessionId(randomUUID())
  await stack.ctx.agentSwarm.domain.provisionMember(scope, teamId, stack.lead.id, {
    name: input.name,
    role: input.role,
    sessionId: childId,
    provider: input.recordProvider,
  })
  await stack.ctx.subagents.startContinuable({
    provider: 'spawn',
    label: `agent-swarm:${teamId}:${input.name}`,
    childId,
    request: {
      prompt: [{ type: 'text', text: `You joined Team "${stack.teamId}". Wait for a task assignment.` }],
      parent: stack.lead,
      maxDepth: 1,
    },
    signal: SIGNAL,
  })
  await vi.waitFor(async () => {
    const stored = await stack.ctx.sessionPersistence.inspect(childId, SIGNAL)
    expect(stored.events.some(event => event.type === 'user/message' && event.data.source.kind === 'user')).toBe(true)
  }, { timeout: 5_000 })
  stack.ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: stack.lead })
  await stack.ctx.subagents.drainContinuableChildren(stack.lead, [childId])
  await vi.waitFor(() => {
    expect(stack.ctx.agents.get(childId)).toBeUndefined()
  }, { timeout: 5_000 })
  return childId
}

describe('persisted-child provisioning reconciliation (F3)', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  /**
   * Crash-window equivalence argument (kill -9 half-window injection):
   *
   * A process killed after `startContinuable` durably established the child
   * and its initial prompt was accepted, but before the activation's
   * `settleMember(active)` commit, leaves exactly three durable facts: (1)
   * the authoritative aggregate still records phase "provisioning" for the
   * child's session id; (2) the child Session log proves the official four
   * factors — `parentSession` is the captain, the folded descriptor is
   * continuable, its provider matches the record, and a user-source message
   * was durably accepted; (3) after the reload no child is live until
   * something resumes it. This test reproduces those facts without killing
   * the process: the direct `provisionMember` commit is (1) byte-identical
   * to the uncommitted activation window; the real `startContinuable` plus
   * the turn checkpoint establishes (2); draining the child after the claim
   * makes the target cold, exactly like a reloaded process (3). The recovery
   * then enters through the same `recoverAgent` entry the real reload uses.
   */
  it('scenario 6: crash after the child persisted but before the team activation commit re-activates the orphan as a member', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-provision-activate-'))
    roots.push(sandbox)
    const fibers: Fiber[] = []

    try {
      const stack = await mountCaptain(sandbox, fibers, 'reconcile-activate-lead', 'Reconciliation team')
      const idle = vi.spyOn(stack.ctx.agentSwarm, 'observeAgentIdle').mockImplementation(() => {})
      const childId = await injectCrashWindow(stack, {
        name: 'orphan-worker',
        role: 'Survive the crash between child persistence and activation.',
        recordProvider: 'spawn',
      })
      const drain = vi.spyOn(stack.ctx.subagents, 'drainContinuableChildren')

      await stack.ctx.agentSwarm.recoverAgent(stack.lead)

      const snapshot = await stack.ctx.agentSwarm.domain.snapshot(
        stack.ctx.agentSwarm.scopeOf(stack.lead), AgentSwarm.TeamId(stack.teamId), stack.lead.id,
      )
      expect(snapshot.team.members[0]).toMatchObject({ sessionId: childId, phase: 'active' })
      // The persisted child is a roster member again — no orphan remains.
      expect(await stack.ctx.agentSwarm.domain.findMembership(stack.ctx.agentSwarm.scopeOf(stack.lead), childId))
        .toMatchObject({ role: 'member', name: 'orphan-worker' })
      // Activation never recycles the child: no reconciliation drain ran.
      expect(drain).not.toHaveBeenCalled()
      idle.mockRestore()
      drain.mockRestore()
    } finally {
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  }, 20_000)

  /**
   * The determinate mismatch half of the same crash window: the provisioning
   * record names a provider the persisted child's descriptor does not carry,
   * so recovery must settle the record failed and explicitly drain the
   * orphan child instead of activating a member it cannot account for.
   */
  it('scenario 6: a persisted child that fails the four-factor check settles failed and is explicitly drained', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-provision-drain-'))
    roots.push(sandbox)
    const fibers: Fiber[] = []

    try {
      const stack = await mountCaptain(sandbox, fibers, 'reconcile-drain-lead', 'Mismatch team')
      const idle = vi.spyOn(stack.ctx.agentSwarm, 'observeAgentIdle').mockImplementation(() => {})
      const childId = await injectCrashWindow(stack, {
        name: 'mismatched-worker',
        role: 'Fail the provider factor of the reconciliation check.',
        recordProvider: 'retired-provider',
      })
      const drain = vi.spyOn(stack.ctx.subagents, 'drainContinuableChildren')

      await stack.ctx.agentSwarm.recoverAgent(stack.lead)

      const snapshot = await stack.ctx.agentSwarm.domain.snapshot(
        stack.ctx.agentSwarm.scopeOf(stack.lead), AgentSwarm.TeamId(stack.teamId), stack.lead.id,
      )
      const member = snapshot.team.members[0]!
      expect(member.phase).toBe('failed')
      expect(member.error).toContain('is not the provisioned provider "retired-provider"')
      // The failed record is not a membership and the orphan was explicitly drained.
      expect(await stack.ctx.agentSwarm.domain.findMembership(stack.ctx.agentSwarm.scopeOf(stack.lead), childId)).toBeUndefined()
      expect(drain).toHaveBeenCalledTimes(1)
      expect(drain.mock.calls[0]?.[1]).toEqual([childId])
      idle.mockRestore()
      drain.mockRestore()
    } finally {
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  }, 20_000)

  /**
   * Evidence that cannot be verified must not guess: with the persistence
   * inspection down, recovery keeps the pre-F3 settlement (the record goes
   * failed with the interrupted-provisioning diagnostic) and neither
   * activates the member nor drains a child it could not classify.
   */
  it('keeps the pre-reconciliation failed settlement when the persisted child cannot be verified', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-provision-unknown-'))
    roots.push(sandbox)
    const fibers: Fiber[] = []

    try {
      const stack = await mountCaptain(sandbox, fibers, 'reconcile-unknown-lead', 'Uncertain team')
      const idle = vi.spyOn(stack.ctx.agentSwarm, 'observeAgentIdle').mockImplementation(() => {})
      const childId = await injectCrashWindow(stack, {
        name: 'unverifiable-worker',
        role: 'Stay unsettled in the active sense when persistence is down.',
        recordProvider: 'spawn',
      })
      const inspect = vi.spyOn(stack.ctx.sessionPersistence, 'inspect')
        .mockRejectedValue(new Error('persistence unavailable during recovery'))
      const drain = vi.spyOn(stack.ctx.subagents, 'drainContinuableChildren')

      await stack.ctx.agentSwarm.recoverAgent(stack.lead)

      const snapshot = await stack.ctx.agentSwarm.domain.snapshot(
        stack.ctx.agentSwarm.scopeOf(stack.lead), AgentSwarm.TeamId(stack.teamId), stack.lead.id,
      )
      const member = snapshot.team.members[0]!
      expect(member.sessionId).toBe(childId)
      expect(member.phase).toBe('failed')
      expect(member.error).toContain('member provisioning did not commit before runtime recovery')
      expect(member.error).toContain('could not verify the persisted child')
      expect(await stack.ctx.agentSwarm.domain.findMembership(stack.ctx.agentSwarm.scopeOf(stack.lead), childId)).toBeUndefined()
      expect(drain).not.toHaveBeenCalled()
      idle.mockRestore()
      inspect.mockRestore()
      drain.mockRestore()
    } finally {
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  }, 20_000)

  /**
   * Minimal-composition contract: without the optional `sessionProjections`
   * registry the live-preferred enumeration rung is unavailable, and the
   * reconciliation must still reach the official inspect-only verdict instead
   * of silently regressing every record to the pre-F3 bulk failure.
   */
  it('activates the persisted orphan without the sessionProjections registry through inspect-only evidence', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-provision-bare-'))
    roots.push(sandbox)
    const fibers: Fiber[] = []

    try {
      const stack = await mountCaptain(sandbox, fibers, 'reconcile-bare-lead', 'Bare team', { projections: false })
      const idle = vi.spyOn(stack.ctx.agentSwarm, 'observeAgentIdle').mockImplementation(() => {})
      const childId = await injectCrashWindow(stack, {
        name: 'bare-worker',
        role: 'Reconcile over persisted inspection alone.',
        recordProvider: 'spawn',
      })
      const drain = vi.spyOn(stack.ctx.subagents, 'drainContinuableChildren')

      await stack.ctx.agentSwarm.recoverAgent(stack.lead)

      const snapshot = await stack.ctx.agentSwarm.domain.snapshot(
        stack.ctx.agentSwarm.scopeOf(stack.lead), AgentSwarm.TeamId(stack.teamId), stack.lead.id,
      )
      expect(snapshot.team.members[0]).toMatchObject({ sessionId: childId, phase: 'active' })
      expect(await stack.ctx.agentSwarm.domain.findMembership(stack.ctx.agentSwarm.scopeOf(stack.lead), childId))
        .toMatchObject({ role: 'member', name: 'bare-worker' })
      expect(drain).not.toHaveBeenCalled()
      idle.mockRestore()
      drain.mockRestore()
    } finally {
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  }, 20_000)

  /**
   * F15: the runtime requests a delegation-depth cap for every member, so a
   * provider without the `depthLimit` capability is incompatible up front.
   * The preflight must reject at `addMember` — before any provisioning record
   * commits and before the continuation manager is reached — instead of
   * surfacing late at child start.
   */
  it('preflights the provider depthLimit capability before committing provisioning (F15)', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-provision-depth-'))
    roots.push(sandbox)
    const fibers: Fiber[] = []

    try {
      const stack = await mountCaptain(sandbox, fibers, 'depth-preflight-lead', 'Depth preflight team')
      const prepare = vi.fn(() => Promise.resolve({}))
      const unregister = stack.ctx.subagents.registerProvider({
        name: 'no-depth',
        capabilities: { outputSchema: false, depthLimit: false, toolFilter: true, persona: true },
        inheritsParentContext: false,
        start: () => Promise.reject(new Error('one-shot start must never run here')),
        prepareContinuable: prepare,
      })

      const rejected = await stack.ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('depth-add'),
        name: 'agent_swarm_add_member',
        arguments: { name: 'shallow-worker', role: 'Exercise the depthLimit preflight.', provider: 'no-depth' },
        agent: stack.lead,
      })
      expect(rejected).toMatchObject({
        isError: true,
        error: { info: { code: 'TEAM_MEMBER_PROVIDER_INCOMPATIBLE' } },
      })
      expect((rejected.error as { message: string }).message).toContain('depthLimit')

      const snapshot = await stack.ctx.agentSwarm.domain.snapshot(
        stack.ctx.agentSwarm.scopeOf(stack.lead), AgentSwarm.TeamId(stack.teamId), stack.lead.id,
      )
      expect(snapshot.team.members).toHaveLength(0)
      expect(prepare).not.toHaveBeenCalled()
      unregister()
    } finally {
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  }, 20_000)

  it('issue #47: a post-activation accounting failure keeps the committed active member and never drains the live child', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-provision-p1-'))
    roots.push(sandbox)
    const fibers: Fiber[] = []

    try {
      const stack = await mountCaptain(sandbox, fibers, 'p1-rollback-lead', 'P1 rollback team')
      const domain = stack.ctx.agentSwarm.domain
      // Inject exactly the trigger chain from the audit: the durable active
      // settlement commits first, then the post-activation usage write
      // fails (the upstream .dsh-mkdir ENOENT path seen in CI).
      const batch = vi.spyOn(domain, 'recordSessionUsageBatch')
        .mockRejectedValueOnce(new Error('injected: ENOENT .dsh-mkdir-xxx'))
      const drain = vi.spyOn(stack.ctx.subagents, 'drainContinuableChildren')

      const added = await stack.ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('p1-add'),
        name: 'agent_swarm_add_member',
        arguments: { name: 'p1-worker', role: 'Survive a post-activation accounting failure.' },
        agent: stack.lead,
      })
      expect(added.isError).toBe(false)
      expect((added.value as { phase: string }).phase).toBe('active')
      await vi.waitFor(() => expect(batch).toHaveBeenCalled(), { timeout: 5_000 })

      const snapshot = await domain.snapshot(
        stack.ctx.agentSwarm.scopeOf(stack.lead), AgentSwarm.TeamId(stack.teamId), stack.lead.id,
      )
      const member = snapshot.team.members[0]!
      expect(member).toMatchObject({ name: 'p1-worker', phase: 'active' })
      // The live child was NOT drained by the accounting failure and stays
      // owned by the captain (no orphan, no contradictory cold child).
      // Issue #112 backend note: under the sqlite persistence backend the
      // official continuable-child quiescent teardown (idle + settled →
      // Activation dispose, cold-resumable) retires the member Agent sooner
      // than the jsonl backend's flush latency did, so registry residency at
      // this instant is a backend timing artifact. The backend-agnostic
      // #47 evidence: our drain never ran (above) and the child session is
      // durably persisted with its initial join turn complete — kept, never
      // lost, and cold-resumable.
      expect(drain).not.toHaveBeenCalled()
      const persisted = await stack.ctx.sessionPersistence.inspect(SessionId(member.sessionId))
      expect(persisted.events.some(event => event.type === 'turn/end')).toBe(true)

      // Retry semantics stay coherent: the occupied name is taken (lifetime
      // rule), a fresh name provisions normally.
      const sameName = await stack.ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('p1-retry-same'),
        name: 'agent_swarm_add_member',
        arguments: { name: 'p1-worker', role: 'Must be rejected.' },
        agent: stack.lead,
      })
      expect(sameName).toMatchObject({ isError: true, error: { info: { code: 'TEAM_MEMBER_NAME_TAKEN' } } })
      const fresh = await stack.ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('p1-retry-fresh'),
        name: 'agent_swarm_add_member',
        arguments: { name: 'p1-worker-2', role: 'System stays healthy.' },
        agent: stack.lead,
      })
      expect(fresh.isError).toBe(false)
      expect((fresh.value as { phase: string }).phase).toBe('active')

      batch.mockRestore()
      drain.mockRestore()
    } finally {
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  }, 20_000)

  it('settles five concurrent initial-turn batches atomically: failures never project active, successes activate, and mixed results remain revision-coherent', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-provision-matrix-'))
    roots.push(sandbox)
    const fibers: Fiber[] = []

    try {
      const adapter = new MatrixAdapter([
        'failed', 'failed', 'failed', 'failed', 'failed',
        'completed', 'completed', 'completed', 'completed', 'completed',
        'completed', 'failed', 'completed', 'failed', 'completed',
      ])
      const stack = await mountCaptain(sandbox, fibers, 'matrix-lead', 'Concurrent matrix team', { adapter, maxMembers: 20 })
      const addFive = async (prefix: string) => await Promise.all(
        Array.from({ length: 5 }, (_, index) => stack.ctx.tools.execute({
          signal: SIGNAL,
          callId: CallId(`${prefix}-${index}`),
          name: 'agent_swarm_add_member',
          arguments: { name: `${prefix}-worker-${index}`, role: `Exercise ${prefix} child startup settlement.` },
          agent: stack.lead,
        })),
      )

      const pendingFailures = addFive('failure'); await vi.waitFor(() => expect(adapter.calls).toBe(5), { timeout: 5_000 }); adapter.release()
      const failures = await pendingFailures
      expect(failures).toHaveLength(5)
      for (const result of failures) expect(result).toMatchObject({ isError: false, value: { phase: 'active' } })
      await vi.waitFor(async () => expect((await stack.ctx.agentSwarm.domain.snapshot(stack.ctx.agentSwarm.scopeOf(stack.lead), AgentSwarm.TeamId(stack.teamId), stack.lead.id)).team.members.every(member => member.phase === 'failed')).toBe(true), { timeout: 5_000 })
      const afterFailures = await stack.ctx.agentSwarm.domain.snapshot(
        stack.ctx.agentSwarm.scopeOf(stack.lead), AgentSwarm.TeamId(stack.teamId), stack.lead.id,
      )
      expect(afterFailures.team.members).toHaveLength(5)
      expect(afterFailures.team.members.map(member => member.phase)).toEqual(['failed', 'failed', 'failed', 'failed', 'failed'])
      expect(afterFailures.team.revision).toBeGreaterThanOrEqual(16)
      const failedProfiles = await stack.ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('failure-profiles'),
        name: 'agent_swarm_list_members',
        arguments: { phase: 'failed' },
        agent: stack.lead,
      })
      expect(failedProfiles).toMatchObject({
        isError: false,
        value: { members: Array.from({ length: 5 }, () => expect.objectContaining({ phase: 'failed', profile_state: 'unavailable', profile_reason: 'startup_failed' })) },
      })

      const successes = await addFive('success')
      expect(successes.every(result => !result.isError)).toBe(true)
      expect(successes.every(result => (result.value as { phase: string }).phase === 'active')).toBe(true)
      await vi.waitFor(async () => expect((await stack.ctx.agentSwarm.domain.snapshot(stack.ctx.agentSwarm.scopeOf(stack.lead), AgentSwarm.TeamId(stack.teamId), stack.lead.id)).team.members.slice(5).every(member => member.phase === 'active')).toBe(true), { timeout: 5_000 })
      const afterSuccesses = await stack.ctx.agentSwarm.domain.snapshot(
        stack.ctx.agentSwarm.scopeOf(stack.lead), AgentSwarm.TeamId(stack.teamId), stack.lead.id,
      )
      expect(afterSuccesses.team.members.slice(5).every(member => member.phase === 'active')).toBe(true)
      expect(afterSuccesses.team.revision).toBeGreaterThanOrEqual(21)

      const mixed = await addFive('mixed')
      expect(mixed.every(result => !result.isError)).toBe(true)
      await vi.waitFor(async () => expect((await stack.ctx.agentSwarm.domain.snapshot(stack.ctx.agentSwarm.scopeOf(stack.lead), AgentSwarm.TeamId(stack.teamId), stack.lead.id)).team.members.every(member => member.phase !== 'provisioning')).toBe(true), { timeout: 5_000 })
      const settled = await stack.ctx.agentSwarm.domain.snapshot(
        stack.ctx.agentSwarm.scopeOf(stack.lead), AgentSwarm.TeamId(stack.teamId), stack.lead.id,
      )
      expect(settled.team.members).toHaveLength(15)
      expect(settled.team.members.filter(member => member.phase === 'failed').length).toBeGreaterThan(5)
      expect(settled.team.members.filter(member => member.phase === 'active').length).toBeGreaterThan(5)
      expect(settled.team.revision).toBeGreaterThanOrEqual(afterSuccesses.team.revision + 10)

      const reused = await stack.ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('failure-name-reuse'),
        name: 'agent_swarm_add_member',
        arguments: { name: 'failure-worker-0', role: 'This must remain fenced after a failed start.' },
        agent: stack.lead,
      })
      expect(reused).toMatchObject({ isError: true, error: { info: { code: 'TEAM_MEMBER_NAME_TAKEN' } } })
      expect((reused.error as { message: string }).message).toContain('choose an unused member name or create a new Team')
    } finally {
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  }, 60_000)

  it('disposal settles an admitted but uncompleted child as failed before listeners and the aggregate are released', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-provision-dispose-'))
    roots.push(sandbox)
    const fibers: Fiber[] = []

    try {
      const adapter = new MatrixAdapter(['completed']); const stack = await mountCaptain(sandbox, fibers, 'dispose-lead', 'Disposal settlement team', { adapter })
      const domain = stack.ctx.agentSwarm.domain
      const settled = vi.spyOn(domain, 'settleMember')
      const pending = stack.ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('dispose-add'),
        name: 'agent_swarm_add_member',
        arguments: { name: 'dispose-worker', role: 'Remain non-active when the owning runtime closes.' },
        agent: stack.lead,
      })
      await vi.waitFor(() => expect(adapter.calls).toBe(1), { timeout: 5_000 })

      const pluginFiber = fibers.pop()!
      const result = await pending
      expect(result).toMatchObject({ isError: false, value: { phase: 'active' } })
      await pluginFiber.dispose()
      expect(settled).toHaveBeenCalledWith(
        expect.anything(), expect.anything(), expect.anything(),
        expect.objectContaining({ active: false, error: expect.stringContaining('aborted') }),
      )
      settled.mockRestore()
    } finally {
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  }, 20_000)
})
