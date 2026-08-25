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

  it('does not call a model until the first assignment and delivers that frame before model execution', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-lazy-member-'))
    roots.push(sandbox)
    const composition = await mount(sandbox, 60_000, 'priority-ready', { lazyMemberStart: true })
    const { ctx, adapter, lead } = composition
    try {
      const memberId = await addMember(composition, 'lazy-worker')
      expect(adapter.requests).toHaveLength(0)
      expect(ctx.agents.get(SessionId(memberId))).toBeUndefined()
      expect((await snapshotOf(composition)).team.members[0]?.phase).toBe('provisioning')
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
      expect(JSON.stringify(userMessages)).not.toContain('Wait for a task assignment')
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
})
