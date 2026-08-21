/**
 * Model-facing jobs reader tests (M3 gate, issue #93): `agent_swarm_list_jobs`
 * over the real composition with the #76 TeamJobProjection mounted. The tool
 * reads ONLY projected snapshots — its rows must agree with the authoritative
 * task board exactly where #76's derivation says they do (a claimed task is
 * one running job naming the fencing attempt; unclaimed pending work projects
 * nothing; an accepted submission settles the job completed) — and the same
 * jsonOutput contract as `agent_swarm_list_tasks` holds (one compact JSON text
 * block, full canonical output schema, kind/status filters, cursor/limit 1-100
 * with next_cursor chaining, structured bounds errors).
 *
 * Without the bridge the projection object does not exist (no service, no
 * records, no second store), so the honest form is the structured
 * `TEAM_JOBS_BRIDGE_DISABLED` error naming the enabling config — never an
 * empty list (that would assert "no jobs" where the statement is "no
 * projection") and never a domain fallback (that would bypass the projection
 * consistency contract owned by #76's dual-face tests). Input validation
 * still precedes the capability check.
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
  snapshotOf,
  toolCall,
  type Composition,
} from './helpers/gated-composition.js'

interface JobRow {
  readonly job_id: string
  readonly kind: string
  readonly label: string
  readonly status: 'running' | 'completed' | 'failed' | 'killed'
  readonly detail?: string
  readonly started_at: number
  readonly finished_at?: number
}

interface JobListValue {
  readonly jobs: JobRow[]
  readonly next_cursor?: number
}

async function listJobs(
  composition: Composition,
  callId: string,
  args: Record<string, unknown> = {},
) {
  return await toolCall(composition.ctx, composition.lead, callId, 'agent_swarm_list_jobs', args)
}

async function listedJobs(
  composition: Composition,
  callId: string,
  args: Record<string, unknown> = {},
): Promise<JobListValue> {
  const listed = await listJobs(composition, callId, args)
  if (listed.isError) throw new Error(`list_jobs failed: ${JSON.stringify(listed.error)}`)
  return listed.value as unknown as JobListValue
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

describe('agent_swarm_list_jobs over the TeamJobProjection (issue #93)', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  /**
   * The projection read path over the bridge-enabled composition: the tool's
   * rows agree with the authoritative task board (a claimed task is one
   * running job naming the fencing attempt; pending-unclaimed work projects
   * nothing; an accepted submission settles completed with the durable
   * finish), the compact single-JSON-block render holds, and the filters and
   * cursor pagination behave exactly like the list_tasks precedent.
   */
  it('lists projected jobs consistent with the task board, with filters, pagination and bounds', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-jobs-reader-'))
    roots.push(sandbox)
    const composition = await mount(sandbox, 60_000, 'priority-ready', { jobsBridge: true })
    const { ctx, fibers, adapter, pluginFiber, lead } = composition
    try {
      // One held-running member keeps every ready task unassigned, so board
      // expectations stay deterministic before the explicit claims below.
      const memberId = await addMember(composition, 'worker-a')
      let memberAgent: Agent | undefined
      await vi.waitFor(() => {
        memberAgent = ctx.agents.get(SessionId(memberId))
        expect(memberAgent?.status).toBe('running')
      }, { timeout: 5_000 })
      if (memberAgent === undefined) throw new Error('member Agent disappeared before the first claim')

      await createTask(composition, 'task-alpha', { subject: 'Alpha', description: 'First task, will be claimed.' })
      await createTask(composition, 'task-beta', {
        subject: 'Beta', description: 'Blocked on Alpha.', blocked_by: ['task-1'],
      })
      await createTask(composition, 'task-gamma', { subject: 'Gamma', description: 'Third task, stays pending.' })

      // Board consistency precondition: pending-unclaimed work projects no
      // job — the empty list here is the derivation contract, not a lie.
      expect((await listedJobs(composition, 'list-empty')).jobs).toEqual([])

      // A claim seats one attempt: exactly one running row, correlated to the
      // fencing attempt the board holds.
      const claimable = (await snapshotOf(composition)).team.tasks[0]!
      const claimed = await toolCall(ctx, memberAgent, 'claim-alpha', 'agent_swarm_claim_task', {
        task_id: claimable.id, expected_revision: claimable.revision,
      })
      expect(claimed.isError).toBe(false)
      const live = await vi.waitFor(async () => {
        const rows = (await listedJobs(composition, 'list-live')).jobs
        expect(rows).toHaveLength(1)
        return rows[0]!
      }, { timeout: 15_000 })
      const claimedSnapshot = (await snapshotOf(composition)).team.tasks[0]!
      expect(live.job_id).toMatch(/^team-task-[1-9][0-9]*$/)
      expect(live).toMatchObject({ kind: 'team-task', label: 'Alpha', status: 'running' })
      expect(Number.isSafeInteger(live.started_at)).toBe(true)
      expect(live.detail).toBe(`task task-1 (attempt ${claimedSnapshot.currentAttemptId})`)
      expect(live.finished_at).toBeUndefined()
      // task-2 (blocked) and task-3 (ready, unclaimed) stay board-only.
      expect(live.detail).not.toContain('task-2')
      expect(live.detail).not.toContain('task-3')

      // Compact-output contract (official jsonOutput pattern): the model sees
      // exactly one text block with the canonical JSON value.
      const rendered = await listJobs(composition, 'list-rendered')
      expect(rendered.isError).toBe(false)
      expect(rendered.content).toEqual([{ type: 'text', text: JSON.stringify(rendered.value) }])

      // An accepted submission settles the row completed from the durable
      // aggregate fields (finished_at lands, started_at never moves).
      const submitted = await toolCall(ctx, memberAgent, 'submit-alpha', 'agent_swarm_submit_task', {
        task_id: 'task-1',
        expected_revision: claimedSnapshot.revision,
        attempt_id: claimedSnapshot.currentAttemptId,
        output: 'Jobs-reader evidence.',
      })
      expect(submitted.isError).toBe(false)
      const reviewed = await toolCall(ctx, lead, 'review-alpha', 'agent_swarm_review_task', {
        task_id: 'task-1',
        expected_revision: (submitted.value as { revision: number }).revision,
        attempt_id: claimedSnapshot.currentAttemptId,
        decision: 'accept',
      })
      expect(reviewed.isError).toBe(false)
      const settled = await vi.waitFor(async () => {
        const rows = (await listedJobs(composition, 'list-settled', { status: 'completed' })).jobs
        expect(rows).toHaveLength(1)
        return rows[0]!
      }, { timeout: 15_000 })
      expect(settled).toMatchObject({ job_id: live.job_id, status: 'completed' })
      expect(settled.finished_at).toBeGreaterThanOrEqual(settled.started_at)

      // A second claim grows the visible set: projection order follows the
      // task board, so pagination walks completed-then-running deterministically.
      const second = (await snapshotOf(composition)).team.tasks[1]!
      const reclaimed = await toolCall(ctx, memberAgent, 'claim-beta', 'agent_swarm_claim_task', {
        task_id: second.id, expected_revision: second.revision,
      })
      expect(reclaimed.isError).toBe(false)
      const both = await vi.waitFor(async () => {
        const rows = (await listedJobs(composition, 'list-both')).jobs
        expect(rows).toHaveLength(2)
        return rows
      }, { timeout: 15_000 })
      expect(both.map(row => row.status)).toEqual(['completed', 'running'])
      expect(both[1]!.detail).toContain('task task-2')

      // Kind and status filters.
      expect((await listedJobs(composition, 'filter-kind', { kind: 'team-task' })).jobs).toHaveLength(2)
      expect((await listedJobs(composition, 'filter-kind-unknown', { kind: 'bash' })).jobs).toEqual([])
      expect((await listedJobs(composition, 'filter-running', { status: 'running' })).jobs.map(row => row.label))
        .toEqual(['Beta'])
      expect((await listedJobs(composition, 'filter-completed', { status: 'completed' })).jobs.map(row => row.label))
        .toEqual(['Alpha'])
      expect((await listedJobs(composition, 'filter-failed', { status: 'failed' })).jobs).toEqual([])

      // Cursor pagination with next_cursor chaining.
      const page1 = await listedJobs(composition, 'page-1', { limit: 1 })
      expect(page1.jobs.map(row => row.label)).toEqual(['Alpha'])
      expect(page1.next_cursor).toBe(1)
      const page2 = await listedJobs(composition, 'page-2', { cursor: 1, limit: 1 })
      expect(page2.jobs.map(row => row.label)).toEqual(['Beta'])
      expect(page2.next_cursor).toBeUndefined()
      expect((await listedJobs(composition, 'page-past-end', { cursor: 5 })).jobs).toEqual([])
      expect((await listedJobs(composition, 'page-combined', { status: 'running', limit: 1 })).next_cursor).toBeUndefined()

      // Bounds are enforced with the structured input-validation error (the
      // schema itself already rejects non-integer cursor/limit values).
      for (const args of [{ limit: 0 }, { limit: 101 }, { cursor: -1 }]) {
        const rejected = await listJobs(composition, `bounds-${JSON.stringify(args)}`, args)
        expect(rejected).toMatchObject({ isError: true, error: { info: { code: 'TEAM_INPUT_INVALID' } } })
      }

      await pluginFiber.dispose()
    } finally {
      adapter.open()
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  }, 20_000)

  /**
   * Without `jobsBridge` the projection is not mounted at all (no service, no
   * records — #76's no-second-store discipline), so the structured
   * `TEAM_JOBS_BRIDGE_DISABLED` error naming the enabling config is the honest
   * answer; input validation still runs first.
   */
  it('fails loud with TEAM_JOBS_BRIDGE_DISABLED when the projection is not mounted', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-jobs-reader-off-'))
    roots.push(sandbox)
    const composition = await mount(sandbox, 60_000)
    const { ctx, fibers, adapter, pluginFiber } = composition
    try {
      expect(ctx.agentSwarm.jobsBridge).toBeUndefined()
      const disabled = await listJobs(composition, 'list-disabled')
      expect(disabled).toMatchObject({ isError: true, error: { info: { code: 'TEAM_JOBS_BRIDGE_DISABLED' } } })
      expect(disabled.error?.message).toContain('jobsBridge')

      // Validation precedence: the bounds check fires before the capability
      // check, keeping the read surface's input contract config-independent.
      const rejected = await listJobs(composition, 'bounds-disabled', { limit: 0 })
      expect(rejected).toMatchObject({ isError: true, error: { info: { code: 'TEAM_INPUT_INVALID' } } })

      await pluginFiber.dispose()
    } finally {
      adapter.open()
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  }, 20_000)
})
