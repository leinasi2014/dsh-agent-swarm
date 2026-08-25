/**
 * M1C tool-layer model experience (issue #15, official `tool-agent-team`
 * patterns in docs/02 §7.1): the `agent_swarm_wait` no-progress
 * short-circuit when no other member can produce a change, the filtered and
 * cursor-paginated `agent_swarm_list_tasks` read path, and the fixed-size
 * `agent_swarm_status` counters whose task rows moved to the list tool.
 *
 * All tests compose the real official services (AgentLoop with the
 * in-process spawn provider, JSONL persistence, the storage stack harness)
 * so liveness-dependent short-circuiting is evidenced against actual Agent
 * status, never a mock.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addMember,
  mount,
  settleCaptain,
  snapshotOf,
  toolCall,
  type Composition,
} from './helpers/gated-composition.js'

interface TaskRow {
  readonly task_id: string
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: string
  readonly ready: boolean
  readonly blocked_by: string[]
  readonly owner?: string
  readonly attempt_id?: string
  readonly stranded?: string
}

interface TaskListValue {
  readonly tasks: TaskRow[]
  readonly next_cursor?: number
}

interface WaitValue {
  readonly changed: boolean
  readonly no_progress?: { readonly reason: string; readonly message: string }
  readonly revision: number
  readonly ready_task_ids: string[]
  readonly queued_messages: number
}

async function createTask(composition: Composition, callId: string, input: {
  subject: string
  description: string
  blocked_by?: string[]
}): Promise<void> {
  const created = await toolCall(composition.ctx, composition.lead, callId, 'agent_swarm_create_task', {
    subject: input.subject,
    description: input.description,
    ...(input.blocked_by === undefined ? {} : { blocked_by: input.blocked_by }),
  })
  if (created.isError) throw new Error(`create_task failed: ${JSON.stringify(created.error)}`)
}

async function listTasks(
  composition: Composition,
  callId: string,
  args: Record<string, unknown> = {},
): Promise<TaskListValue> {
  const listed = await toolCall(composition.ctx, composition.lead, callId, 'agent_swarm_list_tasks', args)
  if (listed.isError) throw new Error(`list_tasks failed: ${JSON.stringify(listed.error)}`)
  return listed.value as unknown as TaskListValue
}

async function waitTool(composition: Composition, callId: string, args: Record<string, unknown>) {
  return await toolCall(composition.ctx, composition.lead, callId, 'agent_swarm_wait', args)
}

describe('tool-layer model experience over the real composition (issue #15)', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  /**
   * The wait short-circuit (official `wait_agent` parity): with no other
   * member running or provisioning — neither an empty roster nor a live but
   * merely idle member — `agent_swarm_wait` returns `no_progress`
   * immediately instead of parking the timeout, and the authoritative
   * window validation still precedes the shortcut.
   */
  it('short-circuits wait to no_progress without an active peer while validating the window first', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-wait-noprogress-'))
    roots.push(sandbox)
    const composition = await mount(sandbox, 60_000)
    const { ctx, fibers, adapter, pluginFiber, lead } = composition
    try {
      // Determinism: idle edges must not drive assignment behind the test.
      const idle = vi.spyOn(ctx.agentSwarm, 'observeAgentIdle').mockImplementation(() => {})
      await createTask(composition, 'task-1', { subject: 'Ready work', description: 'One ready unowned task.' })
      const current = await snapshotOf(composition)

      // Empty roster: immediate no_progress with the current cursor state.
      const startedAt = Date.now()
      const first = await waitTool(composition, 'wait-empty', {
        after_revision: current.team.revision, timeout_ms: 3_600_000,
      })
      expect(first.isError).toBe(false)
      expect(Date.now() - startedAt).toBeLessThan(2_000)
      const firstValue = first.value as unknown as WaitValue
      expect(firstValue.changed).toBe(false)
      expect(firstValue.no_progress).toMatchObject({ reason: 'no-active-peer' })
      expect(firstValue.no_progress?.message).toContain('agent_swarm_send_message')
      expect(firstValue.revision).toBe(current.team.revision)
      expect(firstValue.ready_task_ids).toEqual(['task-1'])
      expect(firstValue.queued_messages).toBe(0)
      // Compact-output contract (official jsonOutput pattern): the model
      // sees exactly one text block with the canonical JSON value.
      expect(first.content).toEqual([{ type: 'text', text: JSON.stringify(firstValue) }])

      // A live but merely idle member is not an active peer either. The
      // spawn provider auto-settles an empty-inbox child, so one wakeup
      // message is parked behind the running turn first (pending next-turn
      // work keeps the Activation resident); the keepInbox interrupt then
      // converges the member live-and-idle without consuming it. Issue #52:
      // the parked frame is still pending, so the send reports `queued` —
      // wakeup acknowledgement requires the claimed, model-visible form.
      const memberId = await addMember(composition, 'idle-worker')
      await vi.waitFor(() => {
        expect(ctx.agents.get(SessionId(memberId))?.status).toBe('running')
      }, { timeout: 5_000 })
      const parked = await toolCall(ctx, lead, 'park-wakeup', 'agent_swarm_send_message', {
        target: 'idle-worker', content: 'Parked work while the captain waits.', delivery: 'wakeup',
      })
      expect(parked.isError).toBe(false)
      expect((parked.value as { phase: string }).phase).toBe('queued')
      const interrupted = await ctx.agentSwarm.interruptMember(
        { agent: lead, signal: AbortSignal.timeout(30_000) }, 'idle-worker',
      )
      expect(interrupted.previousStatus).toBe('running')
      await vi.waitFor(() => {
        const member = ctx.agents.get(SessionId(memberId))
        expect(member).toBeDefined()
        expect(member?.status).toBe('idle')
      }, { timeout: 5_000 })
      await settleCaptain(adapter, lead)
      const settled = await snapshotOf(composition)
      expect(ctx.agents.get(SessionId(memberId))?.status).toBe('idle')
      const second = await waitTool(composition, 'wait-idle', {
        after_revision: settled.team.revision, timeout_ms: 3_600_000,
      })
      expect(second.isError).toBe(false)
      expect((second.value as unknown as WaitValue).no_progress).toMatchObject({ reason: 'no-active-peer' })

      // The shortcut never swallows an already-committed revision: a behind
      // cursor still resolves changed=true through the level-triggered wait
      // even with no active peer.
      const behind = await waitTool(composition, 'wait-behind', { after_revision: 0, timeout_ms: 3_600_000 })
      expect(behind.isError).toBe(false)
      const behindValue = behind.value as unknown as WaitValue
      expect(behindValue.changed).toBe(true)
      expect(behindValue.revision).toBeGreaterThan(0)
      expect(behindValue.no_progress).toBeUndefined()

      // The authoritative window validation precedes the shortcut.
      for (const timeoutMs of [9_999, 3_600_001, 5_000.5]) {
        const rejected = await waitTool(composition, `wait-invalid-${timeoutMs}`, {
          after_revision: settled.team.revision, timeout_ms: timeoutMs,
        })
        expect(rejected).toMatchObject({ isError: true, error: { info: { code: 'TEAM_INVALID_TIMEOUT' } } })
      }

      idle.mockRestore()
      await pluginFiber.dispose()
    } finally {
      adapter.open()
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  }, 20_000)

  /**
   * A genuinely running peer disables the short-circuit: the wait parks on
   * the authoritative cursor and wakes as soon as a revision commits.
   */
  it('waits for a committed revision while another member is running', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-wait-active-'))
    roots.push(sandbox)
    const composition = await mount(sandbox, 60_000)
    const { ctx, fibers, adapter, pluginFiber } = composition
    try {
      const idle = vi.spyOn(ctx.agentSwarm, 'observeAgentIdle').mockImplementation(() => {})
      const memberId = await addMember(composition, 'busy-worker')
      await vi.waitFor(() => {
        expect(ctx.agents.get(SessionId(memberId))?.status).toBe('running')
      }, { timeout: 5_000 })

      const before = await snapshotOf(composition)
      const waiting = waitTool(composition, 'wait-peer', {
        after_revision: before.team.revision, timeout_ms: 3_600_000,
      })
      await createTask(composition, 'task-wake', { subject: 'Wake the waiter', description: 'One committed revision edge.' })
      const woken = await waiting
      expect(woken.isError).toBe(false)
      const value = woken.value as unknown as WaitValue
      expect(value.changed).toBe(true)
      expect(value.revision).toBeGreaterThan(before.team.revision)
      expect(value.no_progress).toBeUndefined()

      idle.mockRestore()
      await pluginFiber.dispose()
    } finally {
      adapter.open()
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  }, 20_000)

  /**
   * The filtered, paginated task list (official `team_task_list` parity) and
   * the fixed-size status counters: list rows carry owner names, attempts
   * and stranded hints instead of an unbounded summary, pagination is
   * cursor/limit bounded (1-100, default 50) and `agent_swarm_status`
   * returns counters only — never the retained arrays the caller did not
   * request.
   */
  it('lists tasks with filters, cursor pagination and bounded rows while status stays fixed-size', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-list-tasks-'))
    roots.push(sandbox)
    const composition = await mount(sandbox, 60_000)
    const { ctx, fibers, adapter, pluginFiber, lead } = composition
    try {
      // One running member keeps every ready task unassigned, so filter
      // expectations stay deterministic before the explicit claim below.
      const memberId = await addMember(composition, 'worker-a')
      let memberAgent: Agent | undefined
      await vi.waitFor(() => {
        memberAgent = ctx.agents.get(SessionId(memberId))
        expect(memberAgent?.status).toBe('running')
      }, { timeout: 5_000 })
      if (memberAgent === undefined) throw new Error('member Agent disappeared before the claim')

      await createTask(composition, 'task-alpha', { subject: 'Alpha', description: 'First task, will be claimed.' })
      await createTask(composition, 'task-beta', {
        subject: 'Beta', description: 'Blocked on Alpha.', blocked_by: ['task-1'],
      })
      await createTask(composition, 'task-gamma', { subject: 'Gamma', description: 'Third task, stays ready.' })

      // Default listing: creation order, complete compact rows, no page left.
      const all = await listTasks(composition, 'list-all')
      expect(all.tasks.map(row => row.task_id)).toEqual(['task-1', 'task-2', 'task-3'])
      expect(all.next_cursor).toBeUndefined()
      expect(all.tasks[0]).toMatchObject({
        task_id: 'task-1', subject: 'Alpha', status: 'pending', ready: true, blocked_by: [],
      })
      expect(all.tasks[1]).toMatchObject({ ready: false, blocked_by: ['task-1'] })
      for (const row of all.tasks) {
        expect(row.owner).toBeUndefined()
        expect(row.attempt_id).toBeUndefined()
        expect(row.stranded).toBeUndefined()
      }

      // Status, owner and readiness filters.
      expect((await listTasks(composition, 'list-pending', { status: 'pending' })).tasks.map(row => row.task_id))
        .toEqual(['task-1', 'task-2', 'task-3'])
      expect((await listTasks(composition, 'list-inprogress', { status: 'in_progress' })).tasks).toEqual([])
      expect((await listTasks(composition, 'list-unowned', { owner: 'unowned' })).tasks).toHaveLength(3)
      expect((await listTasks(composition, 'list-worker-a', { owner: 'worker-a' })).tasks).toEqual([])
      expect((await listTasks(composition, 'list-ready', { ready: true })).tasks.map(row => row.task_id))
        .toEqual(['task-1', 'task-3'])
      expect((await listTasks(composition, 'list-not-ready', { ready: false })).tasks.map(row => row.task_id))
        .toEqual(['task-2'])

      // Cursor pagination with next_cursor chaining.
      const page1 = await listTasks(composition, 'list-page-1', { limit: 2 })
      expect(page1.tasks.map(row => row.task_id)).toEqual(['task-1', 'task-2'])
      expect(page1.next_cursor).toBe(2)
      const page2 = await listTasks(composition, 'list-page-2', { cursor: 2, limit: 2 })
      expect(page2.tasks.map(row => row.task_id)).toEqual(['task-3'])
      expect(page2.next_cursor).toBeUndefined()
      expect((await listTasks(composition, 'list-past-end', { cursor: 3 })).tasks).toEqual([])
      expect((await listTasks(composition, 'list-combined', { status: 'pending', ready: true, limit: 1 })).next_cursor).toBe(1)

      // Bounds are enforced with the structured input-validation error (the
      // schema itself already rejects non-integer cursor/limit values).
      for (const args of [{ limit: 0 }, { limit: 101 }, { cursor: -1 }]) {
        const rejected = await toolCall(ctx, lead, `list-invalid-${JSON.stringify(args)}`, 'agent_swarm_list_tasks', args)
        expect(rejected).toMatchObject({ isError: true, error: { info: { code: 'TEAM_INPUT_INVALID' } } })
      }

      // Status stays fixed-size counters: no retained arrays, no task rows.
      const status = await toolCall(ctx, lead, 'status-slim', 'agent_swarm_status', {})
      expect(status.isError).toBe(false)
      const statusValue = status.value as Record<string, unknown>
      expect(statusValue.ready_tasks).toBe(2)
      expect(statusValue.tasks).toBe(3)
      expect(statusValue.completed_tasks).toBe(0)
      expect(Object.keys(statusValue)).not.toContain('ready_task_ids')
      expect(Object.keys(statusValue)).not.toContain('task_summary')
      expect(status.content).toEqual([{ type: 'text', text: JSON.stringify(statusValue) }])

      // Ownership, attempts and completion flow through the rows.
      const claimable = (await snapshotOf(composition)).team.tasks[0]!
      const claimed = await toolCall(ctx, memberAgent, 'claim', 'agent_swarm_claim_task', {
        task_id: claimable.id, expected_revision: claimable.revision,
      })
      expect(claimed.isError).toBe(false)
      const claimedRow = (await listTasks(composition, 'list-owned', { owner: 'worker-a' })).tasks[0]!
      expect(claimedRow).toMatchObject({ task_id: 'task-1', status: 'in_progress', owner: 'worker-a', ready: false })
      expect(claimedRow.attempt_id).toBeDefined()
      expect((await listTasks(composition, 'list-unowned-2', { owner: 'unowned' })).tasks.map(row => row.task_id))
        .toEqual(['task-2', 'task-3'])
      expect((await listTasks(composition, 'list-ready-2', { ready: true })).tasks.map(row => row.task_id))
        .toEqual(['task-3'])

      const claimedSnapshot = (await snapshotOf(composition)).team.tasks[0]!
      await ctx.agentSwarm.domain.acknowledgeAssignment(
        composition.scope, (await snapshotOf(composition)).team.id, claimedSnapshot.id, claimedSnapshot.currentAttemptId!,
      )
      const submitted = await toolCall(ctx, memberAgent, 'submit', 'agent_swarm_submit_task', {
        task_id: 'task-1',
        expected_revision: claimedSnapshot.revision,
        attempt_id: claimedSnapshot.currentAttemptId,
        output: 'List-row evidence.',
      })
      expect(submitted.isError).toBe(false)
      const reviewed = await toolCall(ctx, lead, 'review', 'agent_swarm_review_task', {
        task_id: 'task-1',
        expected_revision: (submitted.value as { revision: number }).revision,
        attempt_id: claimedSnapshot.currentAttemptId,
        decision: 'accept',
      })
      expect(reviewed.isError).toBe(false)

      const completedRows = (await listTasks(composition, 'list-completed', { status: 'completed' })).tasks
      expect(completedRows).toHaveLength(1)
      expect(completedRows[0]).toMatchObject({ task_id: 'task-1', status: 'completed', owner: 'worker-a' })
      const counters = await toolCall(ctx, lead, 'status-counters', 'agent_swarm_status', {})
      expect((counters.value as Record<string, unknown>).completed_tasks).toBe(1)

      await pluginFiber.dispose()
    } finally {
      adapter.open()
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  }, 20_000)
})
