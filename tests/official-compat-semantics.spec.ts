/**
 * M1C official-compat semantics (issue #19), runtime half: the waitForChange
 * contract, quiet (F13) inactive-delivery semantics and the captain-only
 * keepInbox interrupt.
 *
 * All tests compose the real official services a deployment composes —
 * AgentLoop with the in-process spawn provider (real continuable members),
 * SQLite session persistence and the storage stack harness — so quiet
 * acceptance, interrupt convergence and wait wakeups are evidenced against
 * actual Agent inbox/turn machinery, never a mock.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import { messageFrame } from '../src/runtime/prompts.js'
import { afterSchedulingPass, GatedAdapter } from './helpers/gated-composition.js'
import { mountStorageStackOn } from './helpers/storage-stack.js'

const SIGNAL = new AbortController().signal

function carriesFrame(message: UserMessage, frame: string): boolean {
  return message.content.some(block => block.type === 'text' && block.text === frame)
}

/** Count model-visible copies of one frame: history rows plus pending inbox projections. */
function acceptedFrames(events: readonly SessionEvent[], frame: string): number {
  let count = 0
  for (const event of events) {
    if (event.type === 'user/message' && carriesFrame(event.data, frame)) count += 1
  }
  const inbox: Record<'next-turn' | 'next-step', UserMessage[]> = { 'next-turn': [], 'next-step': [] }
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue
    inbox[event.data.target].splice(event.data.start, event.data.removedCount ?? 0, ...event.data.inserted)
  }
  for (const message of [...inbox['next-turn'], ...inbox['next-step']]) {
    if (carriesFrame(message, frame)) count += 1
  }
  return count
}

async function toolCall(ctx: Context, agent: Agent, callId: string, name: string, args: unknown) {
  return await ctx.tools.execute({ signal: SIGNAL, callId: CallId(callId), name, arguments: args, agent })
}

interface Composition {
  ctx: Context
  fibers: Fiber[]
  adapter: GatedAdapter
  pluginFiber: Fiber
  lead: Agent
}

/** Mount the real composition and create one captain over a fresh sandbox. */
async function mount(sandbox: string): Promise<Composition> {
  const ctx = new Context()
  const fibers: Fiber[] = []
  const adapter = new GatedAdapter()
  await mountAgentLoopTestDependencies(ctx)
  fibers.push(await ctx.plugin(SqliteSessionPersistence, { path: join(sandbox, 'sessions', 'sessions.db') }))
  await mountStorageStackOn(ctx, join(sandbox, 'storage'))
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
  fibers.push(await ctx.plugin(SubagentService))
  fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
  const pluginFiber = await ctx.plugin(AgentSwarm, { memberProvider: 'spawn', memberMaxDepth: 1 })
  fibers.push(pluginFiber)
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = ctx.agentLoop.create(
    SessionId(`compat-lead-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    { provider: 'mock', model: 'mock' },
    { cwd: join(sandbox, 'workspace') },
  )
  return { ctx, fibers, adapter, pluginFiber, lead }
}

async function createTeam(ctx: Context, lead: Composition['lead'], callId: string): Promise<string> {
  const created = await toolCall(ctx, lead, callId, 'agent_swarm_create', {
    name: 'Compat team', description: 'Prove the issue #19 official-compat semantics over real services.',
  })
  if (created.isError) throw new Error(`create failed: ${JSON.stringify(created.error)}`)
  return (created.value as { team_id: string }).team_id
}

async function addMember(ctx: Context, lead: Composition['lead'], name: string): Promise<string> {
  const added = await toolCall(ctx, lead, `add-${name}`, 'agent_swarm_add_member', {
    name, role: 'Exercise the official compatibility semantics.',
  })
  if (added.isError) throw new Error(`add_member failed: ${JSON.stringify(added.error)}`)
  return (added.value as { session_id: string }).session_id
}

describe('official compatibility semantics over the real composition (issue #19)', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  /**
   * F13 / scenario 20 quiet half: an inactive target's quiet message stays
   * durably queued — the send path and the reload-recovery rescan both refuse
   * to cold-resume the member — while a wakeup message to the same cold
   * member cold-resumes it through `subagents.followup` and delivers.
   */
  it('scenario 20: quiet mail never cold-wakes an inactive member while wakeup cold-resumes and delivers', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-quiet-'))
    roots.push(sandbox)
    const { ctx, fibers, adapter, pluginFiber, lead } = await mount(sandbox)
    try {
      const teamId = await createTeam(ctx, lead, 'create')
      const memberId = await addMember(ctx, lead, 'sleepy-worker')
      // Determinism: only the explicit sends and rescans below deliver mail.
      const idle = vi.spyOn(ctx.agentSwarm, 'observeAgentIdle').mockImplementation(() => {})
      const followupFrames: string[] = []
      const followup = ctx.subagents.followup.bind(ctx.subagents)
      const followupSpy = vi.spyOn(ctx.subagents, 'followup').mockImplementation(async (parent, childId, content, options) => {
        for (const block of content) {
          if (block.type === 'text') followupFrames.push(block.text)
        }
        return await followup(parent, childId, content, options)
      })

      // Settle the initial member turn; the spawn provider auto-settles an
      // idle continuable child with an empty inbox and wakes the captain with
      // the settlement notice, so release that captain turn too. Then make
      // the member inactive exactly like a reloaded process whose members
      // have not resumed: cancel + drain (a settled child is a no-op).
      await adapter.waitForRequests(1)
      adapter.open()
      await adapter.waitForRequests(2)
      expect(lead.status).toBe('running')
      adapter.open()
      await lead.whenIdle()
      ctx.subagents.interrupt(SessionId(memberId), { kind: 'ancestor', agent: lead })
      await ctx.subagents.drainContinuableChildren(lead, [SessionId(memberId)])
      expect(ctx.agents.get(SessionId(memberId))).toBeUndefined()

      // Quiet send to the inactive member: durable queue, no cold resume.
      const quiet = await toolCall(ctx, lead, 'send-quiet', 'agent_swarm_send_message', {
        target: 'sleepy-worker', content: 'Quiet fact for the next turn.', delivery: 'quiet',
      })
      expect(quiet.isError).toBe(false)
      expect((quiet.value as { phase: string }).phase).toBe('queued')
      const scope = ctx.agentSwarm.scopeOf(lead)
      const quietMessage = (await ctx.agentSwarm.domain.snapshot(scope, AgentSwarm.TeamId(teamId), lead.id))
        .team.messages.find(candidate => candidate.content === 'Quiet fact for the next turn.')
      expect(quietMessage?.phase).toBe('queued')
      const quietFrame = messageFrame(quietMessage!)

      // The reload-recovery rescan skips the inactive target's quiet mail.
      await afterSchedulingPass(() => ctx.agentSwarm.recoverAgent(lead), teamId)
      // scenario-evidence: 20
      expect(ctx.agents.get(SessionId(memberId))).toBeUndefined()
      expect((await ctx.agentSwarm.domain.snapshot(scope, AgentSwarm.TeamId(teamId), lead.id))
        .team.messages.find(candidate => candidate.id === quietMessage?.id)?.phase).toBe('queued')
      expect(followupFrames.filter(text => text === quietFrame)).toHaveLength(0)

      // Wakeup to the same cold member cold-resumes and delivers it; the
      // resumed turn is held so the member stays deterministically live.
      const wakeup = await toolCall(ctx, lead, 'send-wakeup', 'agent_swarm_send_message', {
        target: 'sleepy-worker', content: 'Wake up and run one turn.', delivery: 'wakeup',
      })
      expect(wakeup.isError).toBe(false)
      expect((wakeup.value as { phase: string }).phase).toBe('delivered')
      expect(ctx.agents.get(SessionId(memberId))?.status).toBe('running')
      const wakeupMessage = (await ctx.agentSwarm.domain.snapshot(scope, AgentSwarm.TeamId(teamId), lead.id))
        .team.messages.find(candidate => candidate.content === 'Wake up and run one turn.')
      const wakeupFrame = messageFrame(wakeupMessage!)
      expect(followupFrames.filter(text => text === wakeupFrame)).toHaveLength(1)

      // Now live again, the quiet message delivers on the next rescan without
      // a second followup: exactly one model-visible copy of each frame. (The
      // captain is idle here, so recoverAgent runs the reload-recovery pass.)
      await afterSchedulingPass(() => ctx.agentSwarm.recoverAgent(lead), teamId)
      expect((await ctx.agentSwarm.domain.snapshot(scope, AgentSwarm.TeamId(teamId), lead.id))
        .team.messages.find(candidate => candidate.id === quietMessage?.id)?.phase).toBe('delivered')
      adapter.open()
      const stored = await ctx.sessionPersistence.inspect(SessionId(memberId), SIGNAL)
      expect(acceptedFrames(stored.events, quietFrame)).toBe(1)
      expect(acceptedFrames(stored.events, wakeupFrame)).toBe(1)
      expect(followupFrames.filter(text => text === quietFrame)).toHaveLength(0)

      idle.mockRestore()
      followupSpy.mockRestore()
      await pluginFiber.dispose()
    } finally {
      adapter.open()
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  }, 20_000)

  /**
   * Quiet to a LIVE member delivers without waking it (official `inject`
   * parity): the member is mid-turn on the held initial request, the quiet
   * message lands in its durable next-step inbox, and no second model turn,
   * followup or cold-resume happens.
   */
  it('delivers quiet mail to a live member without starting a turn', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-quiet-live-'))
    roots.push(sandbox)
    const { ctx, fibers, adapter, pluginFiber, lead } = await mount(sandbox)
    try {
      await createTeam(ctx, lead, 'create')
      const memberId = await addMember(ctx, lead, 'busy-worker')
      const idle = vi.spyOn(ctx.agentSwarm, 'observeAgentIdle').mockImplementation(() => {})
      const followupFrames: string[] = []
      const followup = ctx.subagents.followup.bind(ctx.subagents)
      const followupSpy = vi.spyOn(ctx.subagents, 'followup').mockImplementation(async (parent, childId, content, options) => {
        for (const block of content) {
          if (block.type === 'text') followupFrames.push(block.text)
        }
        return await followup(parent, childId, content, options)
      })

      // The member is live and running on its gated initial turn.
      await adapter.waitForRequests(1)
      expect(adapter.requests.length).toBe(1)
      expect(ctx.agents.get(SessionId(memberId))?.status).toBe('running')

      const sent = await toolCall(ctx, lead, 'send-quiet', 'agent_swarm_send_message', {
        target: 'busy-worker', content: 'Context you may claim at a later step boundary.', delivery: 'quiet',
      })
      expect(sent.isError).toBe(false)
      expect((sent.value as { phase: string }).phase).toBe('delivered')

      // No turn was started: no new model request, still running, no followup.
      expect(adapter.requests.length).toBe(1)
      expect(ctx.agents.get(SessionId(memberId))?.status).toBe('running')
      expect(followupFrames).toHaveLength(0)

      // The frame is durably accepted exactly once (pending next-step inbox).
      const scope = ctx.agentSwarm.scopeOf(lead)
      const message = (await ctx.agentSwarm.domain.snapshot(scope, (await ctx.agentSwarm.domain.requireMembership(scope, lead.id)).team.id, lead.id))
        .team.messages.find(candidate => candidate.content === 'Context you may claim at a later step boundary.')
      const frame = messageFrame(message!)
      const stored = await ctx.sessionPersistence.inspect(SessionId(memberId), SIGNAL)
      expect(acceptedFrames(stored.events, frame)).toBe(1)

      idle.mockRestore()
      followupSpy.mockRestore()
      await pluginFiber.dispose()
    } finally {
      adapter.open()
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  }, 20_000)

  /**
   * Captain-only keepInbox interrupt: cancels the member's current turn
   * through `ctx.subagents.interrupt(kind: 'ancestor')` while the roster row,
   * task ownership, attempts and durable mail all survive untouched, and a
   * later wakeup resumes the member (unlike removeMember's drain).
   */
  it('interrupts one member turn keepInbox without releasing ownership or mail', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-interrupt-'))
    roots.push(sandbox)
    const { ctx, fibers, adapter, pluginFiber, lead } = await mount(sandbox)
    try {
      const teamId = await createTeam(ctx, lead, 'create')
      const memberId = await addMember(ctx, lead, 'runaway-worker')

      // The member is RUNNING on its gated initial turn. Live-status
      // scheduling (issue #12) defers the new task until the member frees,
      // so the gate opens and the resulting idle edge assigns it; the
      // member then runs the assignment turn (held again).
      const task = await toolCall(ctx, lead, 'task', 'agent_swarm_create_task', {
        subject: 'Interrupt proof', description: 'Ownership must survive the captain interrupt.',
      })
      expect(task.isError).toBe(false)
      const scope = ctx.agentSwarm.scopeOf(lead)
      adapter.open()
      await vi.waitFor(async () => {
        const snapshot = await ctx.agentSwarm.domain.snapshot(scope, AgentSwarm.TeamId(teamId), lead.id)
        expect(snapshot.team.tasks[0]?.ownerSessionId).toBe(memberId)
        expect(snapshot.team.tasks[0]?.status).toBe('in_progress')
      }, { timeout: 5_000 })
      await adapter.waitForRequests(3)
      expect(ctx.agents.get(SessionId(memberId))?.status).toBe('running')
      // Park a wakeup message behind the running assignment turn: pending
      // next-turn work keeps the Activation resident across the upcoming
      // keepInbox interrupt (an empty inbox would let the spawn provider
      // auto-settle the member cold; the durable facts would survive
      // either way, but this pins the live-resume variant). Issue #52: the
      // parked frame is still pending, so the send reports `queued` —
      // wakeup acknowledgement requires the claimed, model-visible form
      // (the quiet send below still acknowledges on inbox acceptance).
      const parked = await toolCall(ctx, lead, 'send-parked', 'agent_swarm_send_message', {
        target: 'runaway-worker', content: 'Parked wakeup kept across the interrupt.', delivery: 'wakeup',
      })
      expect(parked.isError).toBe(false)
      expect((parked.value as { phase: string }).phase).toBe('queued')
      const quiet = await toolCall(ctx, lead, 'send-quiet', 'agent_swarm_send_message', {
        target: 'runaway-worker', content: 'Quiet context kept across the interrupt.', delivery: 'quiet',
      })
      expect(quiet.isError).toBe(false)
      expect((quiet.value as { phase: string }).phase).toBe('delivered')
      // Three held turns so far: the member's initial turn, the captain's
      // settlement notice for it, and the member's assignment turn.
      expect(adapter.requests.length).toBe(3)

      // Trusted Host/Human interrupt remains available without model evidence.
      const interrupted = await ctx.agentSwarm.interruptMember({ agent: lead, signal: SIGNAL }, 'runaway-worker')
      expect(interrupted).toMatchObject({ name: 'runaway-worker', previousStatus: 'running' })

      // The cancelled turn converges to idle without draining the member:
      // the parked assignment keeps the Activation waiting, no new turn runs.
      const interruptedMember = ctx.agents.get(SessionId(memberId))!
      await interruptedMember.whenIdle()
      expect(interruptedMember.status).toBe('idle')
      expect(adapter.requests.length).toBe(3)

      // Authorization and target validation on the host API.
      const memberAgent = ctx.agents.get(SessionId(memberId))
      expect(memberAgent).toBeDefined()
      if (memberAgent === undefined) throw new Error('member Agent disappeared before the authorization checks')
      await expect(ctx.agentSwarm.interruptMember({ agent: memberAgent, signal: SIGNAL }, 'runaway-worker'))
        .rejects.toMatchObject({ code: 'TEAM_CAPTAIN_REQUIRED' })
      await expect(ctx.agentSwarm.interruptMember({ agent: lead, signal: SIGNAL }, 'Captain'))
        .rejects.toMatchObject({ code: 'TEAM_INVALID_TARGET' })
      await expect(ctx.agentSwarm.interruptMember({ agent: lead, signal: SIGNAL }, 'ghost-worker'))
        .rejects.toMatchObject({ code: 'TEAM_MEMBER_NOT_FOUND' })

      // keepInbox: roster, task ownership, attempts and mail all survive.
      const after = await ctx.agentSwarm.domain.snapshot(scope, AgentSwarm.TeamId(teamId), lead.id)
      expect(after.team.members.find(member => member.sessionId === memberId)?.phase).toBe('active')
      expect(after.team.tasks[0]).toMatchObject({ status: 'in_progress', ownerSessionId: memberId })
      const quietRow = after.team.messages.find(candidate => candidate.content === 'Quiet context kept across the interrupt.')
      expect(quietRow?.phase).toBe('delivered')
      const stored = await ctx.sessionPersistence.inspect(SessionId(memberId), SIGNAL)
      const quietFrame = messageFrame(quietRow!)
      expect(acceptedFrames(stored.events, quietFrame)).toBe(1)
      expect(JSON.stringify(stored.events)).toContain('Interrupt proof')

      // The member was interrupted, not drained: a wakeup resumes it.
      const wakeup = await toolCall(ctx, lead, 'send-wakeup', 'agent_swarm_send_message', {
        target: 'runaway-worker', content: 'Resume your parked work.', delivery: 'wakeup',
      })
      expect(wakeup.isError).toBe(false)
      await adapter.waitForRequests(4)
      expect(adapter.requests.length).toBeGreaterThan(3)
      expect(ctx.agents.get(SessionId(memberId))).toBeDefined()

      await pluginFiber.dispose()
    } finally {
      adapter.open()
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  }, 20_000)

  /** waitForChange contract: official window, timeout shape and structured abort. */
  it('enforces the 10s-1h wait window, the timeout shape and structured TEAM_WAIT_ABORTED cancellation', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-wait-'))
    roots.push(sandbox)
    const { ctx, fibers, adapter, pluginFiber, lead } = await mount(sandbox)
    try {
      const teamId = await createTeam(ctx, lead, 'create')
      const idle = vi.spyOn(ctx.agentSwarm, 'observeAgentIdle').mockImplementation(() => {})

      // Window boundaries (official TEAM_INVALID_TIMEOUT parity).
      for (const timeoutMs of [9_999, 3_600_001, 5_000.5]) {
        const rejected = await toolCall(ctx, lead, `wait-${timeoutMs}`, 'agent_swarm_wait', {
          after_revision: 1, timeout_ms: timeoutMs,
        })
        expect(rejected).toMatchObject({ isError: true, error: { info: { code: 'TEAM_INVALID_TIMEOUT' } } })
      }

      // Early wake: the 1h cap is admitted and a committed change resolves
      // the wait with the superseding snapshot.
      const before = await ctx.agentSwarm.domain.snapshot(ctx.agentSwarm.scopeOf(lead), AgentSwarm.TeamId(teamId), lead.id)
      const waiting = ctx.agentSwarm.waitForChange({ agent: lead, signal: SIGNAL }, before.team.revision, 3_600_000)
      await toolCall(ctx, lead, 'task', 'agent_swarm_create_task', {
        subject: 'Wake the waiter', description: 'One committed revision edge.',
      })
      const woken = await waiting
      expect(woken.changed).toBe(true)
      expect(woken.outcome).toBe('changed')
      expect(woken.snapshot.team.revision).toBeGreaterThan(before.team.revision)

      // Structured cancellation: caller abort rejects with TEAM_WAIT_ABORTED.
      const controller = new AbortController()
      const aborting = ctx.agentSwarm.waitForChange({ agent: lead, signal: controller.signal }, woken.snapshot.team.revision, 10_000)
      setTimeout(() => controller.abort(new Error('caller cancelled')), 100)
      await expect(aborting).rejects.toMatchObject({ code: 'TEAM_WAIT_ABORTED' })

      // Timeout shape: a current cursor with no further change returns the
      // unchanged snapshot with changed=false after the 10s floor.
      const current = await ctx.agentSwarm.domain.snapshot(ctx.agentSwarm.scopeOf(lead), AgentSwarm.TeamId(teamId), lead.id)
      const startedAt = Date.now()
      const timedOut = await ctx.agentSwarm.waitForChange({ agent: lead, signal: SIGNAL }, current.team.revision, 10_000)
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(9_000)
      expect(timedOut.changed).toBe(false)
      expect(timedOut.outcome).toBe('timed-out')
      expect(timedOut.snapshot.team.revision).toBe(current.team.revision)
      expect(timedOut.snapshot.readyTaskIds).toEqual(['task-1'])

      idle.mockRestore()
      await pluginFiber.dispose()
    } finally {
      adapter.open()
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  }, 30_000)
})
