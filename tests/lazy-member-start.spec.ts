import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assignmentPrompt } from '../src/runtime/prompts.js'
import * as AgentSwarm from '../src/index.js'
import { addMember, mount, snapshotOf, toolCall } from './helpers/gated-composition.js'

describe('lazy member materialization', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  })

  it('defaults omitted legacy configuration to lazy start and delivers the assignment before model execution', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-lazy-member-'))
    roots.push(sandbox)
    const composition = await mount(sandbox, 60_000, 'priority-ready', { useProductLazyDefault: true })
    const { ctx, adapter, lead } = composition
    try {
      const memberId = await addMember(composition, 'lazy-worker')
      expect(adapter.requests).toHaveLength(0)
      expect(ctx.agents.get(SessionId(memberId))).toBeUndefined()
      expect((await snapshotOf(composition)).team.members[0]?.phase).toBe('provisioning')

      // A declared lazy member is already an addressable durable mailbox
      // target even though it has no live Session yet. The message stays
      // queued and must not bootstrap an unassigned model turn; the first
      // assignment below remains the member's first user frame.
      const queued = await toolCall(ctx, lead, 'lazy-message-before-assignment', 'agent_swarm_send_message', {
        target: 'lazy-worker', content: 'Context queued before your first assignment.', delivery: 'wakeup',
      })
      expect(queued).toMatchObject({ isError: false, value: { phase: 'queued' } })
      expect(adapter.requests).toHaveLength(0)
      expect((await snapshotOf(composition)).team.messages).toMatchObject([{
        targetSessionId: memberId,
        phase: 'queued',
      }])

      const wait = await toolCall(ctx, lead, 'lazy-wait', 'agent_swarm_wait', {
        after_revision: (await snapshotOf(composition)).team.revision,
        timeout_seconds: 10,
      })
      expect(wait).toMatchObject({ isError: false, value: { changed: false, no_progress: { reason: 'no-active-peer' } } })

      const created = await toolCall(ctx, lead, 'lazy-task', 'agent_swarm_create_task', {
        subject: 'First real work', description: 'The assignment must be the first user prompt.',
      })
      expect(created.isError).toBe(false)

      await vi.waitFor(async () => {
        expect(adapter.requests.length).toBeGreaterThanOrEqual(1)
        expect(ctx.agents.get(SessionId(memberId))?.status).toBe('running')
        const snapshot = await snapshotOf(composition)
        expect(snapshot.team.members[0]?.phase).toBe('active')
        const task = snapshot.team.tasks[0]!
        const attempt = snapshot.team.attempts.find(candidate => candidate.id === task.currentAttemptId)!
        expect(attempt.assignmentPhase).toBe('delivered')
      }, { timeout: 15_000 })

      const snapshot = await snapshotOf(composition)
      const task = snapshot.team.tasks[0]!
      const attempt = snapshot.team.attempts.find(candidate => candidate.id === task.currentAttemptId)!
      const stored = await ctx.sessionPersistence.inspect(SessionId(memberId))
      const userMessages = stored.events.slice(stored.meta.seedLength ?? 0)
        .filter(event => event.type === 'user/message')
      expect(userMessages[0]?.data.content).toEqual([
        { type: 'text', text: assignmentPrompt(snapshot.team, task, attempt.id) },
      ])
      expect(JSON.stringify(userMessages[0])).not.toContain('Context queued before your first assignment.')
      expect(JSON.stringify(userMessages)).not.toContain('Wait for a task assignment')

      adapter.open()
      await vi.waitFor(async () => {
        const settled = await snapshotOf(composition)
        expect(settled.team.messages[0]?.phase).toBe('delivered')
        const replay = await ctx.sessionPersistence.inspect(SessionId(memberId))
        const modelVisible = replay.events.slice(replay.meta.seedLength ?? 0)
          .filter(event => event.type === 'user/message')
        expect(JSON.stringify(modelVisible.slice(1))).toContain('Context queued before your first assignment.')
      }, { timeout: 15_000 })
    } finally {
      adapter.open()
      for (const fiber of composition.fibers.toReversed()) await fiber.dispose()
    }
  }, 20_000)

  it('keeps eager legacy startup available only through explicit false', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-eager-member-'))
    roots.push(sandbox)
    const composition = await mount(sandbox, 60_000, 'priority-ready', { lazyMemberStart: false })
    const { ctx, adapter } = composition
    try {
      const memberId = await addMember(composition, 'eager-worker')
      await vi.waitFor(async () => {
        expect(adapter.requests.length).toBeGreaterThanOrEqual(1)
        expect((await snapshotOf(composition)).team.members[0]?.phase).toBe('active')
      }, { timeout: 15_000 })
      const stored = await ctx.sessionPersistence.inspect(SessionId(memberId))
      const userMessages = stored.events.slice(stored.meta.seedLength ?? 0)
        .filter(event => event.type === 'user/message')
      expect(JSON.stringify(userMessages[0])).toContain('Wait for a task assignment')
    } finally {
      adapter.open()
      for (const fiber of composition.fibers.toReversed()) await fiber.dispose()
    }
  }, 20_000)

  it('keeps an unassigned declared member schedulable across plugin reload', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-lazy-reload-'))
    roots.push(sandbox)
    const composition = await mount(sandbox, 60_000, 'priority-ready', { lazyMemberStart: true })
    const { ctx, adapter, lead } = composition
    try {
      const memberId = await addMember(composition, 'reload-worker')
      expect(adapter.requests).toHaveLength(0)
      await composition.pluginFiber.dispose()
      const reloaded = await ctx.plugin(AgentSwarm, {
        memberProvider: 'spawn', memberMaxDepth: 1, strandedAfterMs: 60_000, lazyMemberStart: true,
      })
      composition.fibers.push(reloaded)

      const afterReload = await snapshotOf(composition)
      expect(afterReload.team.members[0]).toMatchObject({ sessionId: memberId, phase: 'provisioning' })
      expect(ctx.agents.get(SessionId(memberId))).toBeUndefined()

      const created = await toolCall(ctx, lead, 'reload-task', 'agent_swarm_create_task', {
        subject: 'First work after reload', description: 'Materialize the dormant declaration exactly once.',
      })
      expect(created.isError).toBe(false)
      await vi.waitFor(async () => {
        const snapshot = await snapshotOf(composition)
        const task = snapshot.team.tasks[0]!
        const attempt = snapshot.team.attempts.find(candidate => candidate.id === task.currentAttemptId)!
        expect(snapshot.team.members[0]?.phase).toBe('active')
        expect(attempt.assignmentPhase).toBe('delivered')
        expect(ctx.agents.get(SessionId(memberId))?.status).toBe('running')
      }, { timeout: 15_000 })
    } finally {
      adapter.open()
      for (const fiber of composition.fibers.toReversed()) await fiber.dispose()
    }
  }, 25_000)

  it('rejects an unknown deny tool before a lazy declaration occupies the roster', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-lazy-preflight-'))
    roots.push(sandbox)
    const composition = await mount(sandbox, 60_000, 'priority-ready', { lazyMemberStart: true })
    try {
      const rejected = await toolCall(composition.ctx, composition.lead, 'bad-deny', 'agent_swarm_add_member', {
        name: 'bad-worker', role: 'Must not occupy the roster.', deny_tools: ['not_a_real_dsh_tool'],
      })
      expect(rejected).toMatchObject({ isError: true, error: { info: { code: 'TEAM_INPUT_INVALID' } } })
      expect((await snapshotOf(composition)).team.members).toHaveLength(0)
    } finally {
      for (const fiber of composition.fibers.toReversed()) await fiber.dispose()
    }
  })

  it('cancels queued mail when a lazy declaration settles failed or recovery retires it', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-lazy-mail-failure-'))
    roots.push(sandbox)
    const composition = await mount(sandbox, 60_000, 'priority-ready', { lazyMemberStart: true })
    const { ctx, lead } = composition
    try {
      const firstId = await addMember(composition, 'failed-worker')
      const secondId = await addMember(composition, 'recovered-worker')
      for (const target of ['failed-worker', 'recovered-worker']) {
        const sent = await toolCall(ctx, lead, `queue-${target}`, 'agent_swarm_send_message', {
          target, content: `Queued for ${target}.`, delivery: 'wakeup',
        })
        expect(sent).toMatchObject({ isError: false, value: { phase: 'queued' } })
      }

      const before = await snapshotOf(composition)
      const scope = ctx.agentSwarm.scopeOf(lead)
      await ctx.agentSwarm.domain.settleMember(
        scope, before.team.id, firstId, { active: false, error: 'provisioning failed' },
      )
      await ctx.agentSwarm.domain.recoverProvisioningMembers(
        scope, before.team.id, lead.id, 'runtime recovery retired provisioning',
      )

      const after = await ctx.agentSwarm.domain.snapshot(scope, before.team.id, lead.id)
      expect(after.team.members.find(member => member.sessionId === firstId)?.phase).toBe('failed')
      expect(after.team.members.find(member => member.sessionId === secondId)?.phase).toBe('failed')
      expect(after.team.messages).toHaveLength(2)
      expect(after.team.messages.every(message => message.phase === 'cancelled')).toBe(true)
      expect(after.pendingMessageIds).toHaveLength(0)
    } finally {
      for (const fiber of composition.fibers.toReversed()) await fiber.dispose()
    }
  })
})
