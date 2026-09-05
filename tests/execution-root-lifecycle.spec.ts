/** Real official tool and two-Context regressions for #191 review findings. */
import { mkdtemp, mkdir, readFile, rename, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { expect, it, vi } from 'vitest'
import { AttemptId, TaskId, TeamId } from '../src/domain/types.js'
import { GatedMemberAdapter } from './helpers/modes-composition.js'
import {
  disposeRestartComposition as dispose, mountRestartComposition,
  restartTool as tool, type RestartMounted,
} from './helpers/restart-real-composition.js'

type Mounted = RestartMounted & { adapter: GatedMemberAdapter }

async function mount(sandbox: string): Promise<Mounted> {
  const mounted = await mountRestartComposition(sandbox, 60_000, undefined, join(sandbox, 'roots'))
  mounted.fibers.push(await mounted.ctx.plugin(LocalFileSystem, { cwd: join(sandbox, 'workspace') }))
  mounted.fibers.push(await mounted.ctx.plugin(ToolFs))
  const adapter = new GatedMemberAdapter()
  mounted.ctx.llm.registerAdapter(['mock'], adapter)
  return { ...mounted, adapter }
}

it('fails closed when the lease is revoked after the official guard and before the write body (#191 F1)', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-root-race-'))
  await mkdir(join(sandbox, 'workspace'))
  const mounted = await mount(sandbox)
  const { ctx } = mounted
  try {
    const agent = ctx.agentLoop.create(SessionId('root-race-worker'), { provider: 'mock', model: 'mock' }, { cwd: join(sandbox, 'workspace') })
    const scope = ctx.agentSwarm.scopeOf(agent)
    const roots = ctx.agentSwarm.executionRoots.roots
    const team = TeamId('root-race-team'), task = TaskId('root-race-task'), attempt = AttemptId('root-race-attempt')
    const lease = await roots.acquire(scope, team, task, attempt, String(agent.id))
    let intercepted = false
    ctx.on('tools/execute', async (exec, next) => {
      if (exec.name === 'write' && exec.agent === agent) {
        intercepted = true
        await roots.release(scope, team, task, attempt, 'test lease revoked after guard')
      }
      return await next()
    })
    const result = await tool(ctx, agent, 'stale-write', 'write', { file_path: 'escaped.txt', content: 'must not escape' })
    expect(intercepted).toBe(true)
    expect({ error: result.isError, sharedWrite: existsSync(join(scope, 'escaped.txt')), retainedRoot: existsSync(lease.path) })
      .toEqual({ error: true, sharedWrite: false, retainedRoot: false })
  } finally {
    await dispose(mounted)
    await rm(sandbox, { recursive: true, force: true })
  }
}, 30_000)

it.each([true, false])('cold-resumed member retains work and fences IO with existing root=%s (#191 F2)', async existingRoot => {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-root-cold-'))
  await mkdir(join(sandbox, 'workspace'))
  const captainId = SessionId('root-cold-captain')
  let first: Mounted | undefined
  let second: Mounted | undefined
  try {
    first = await mount(sandbox)
    const lead = first.ctx.agentLoop.create(captainId, { provider: 'mock', model: 'mock' }, { cwd: join(sandbox, 'workspace') })
    const created = await tool(first.ctx, lead, 'create', 'agent_swarm_create', { name: 'Cold root', description: 'Retain and restore unsubmitted work.' })
    expect(created.isError).toBe(false)
    const teamId = TeamId((created.value as { team_id: string }).team_id)
    const added = await tool(first.ctx, lead, 'add', 'agent_swarm_add_member', { name: 'worker', role: 'work' })
    expect(added.isError).toBe(false)
    const childId = SessionId((added.value as { session_id: string }).session_id)
    const child = first.ctx.agents.get(childId)!
    expect(child).toBeDefined()
    const createdTask = await tool(first.ctx, lead, 'task', 'agent_swarm_create_task', { subject: 'Work', description: 'Keep work across restart.' })
    expect(createdTask.isError).toBe(false)
    const taskId = TaskId((createdTask.value as { task_id: string }).task_id)
    const scope = first.ctx.agentSwarm.scopeOf(lead)
    first.adapter.open()
    const claim = await vi.waitFor(async () => {
      const snapshot = await first!.ctx.agentSwarm.domain.snapshot(scope, teamId, lead.id)
      const task = snapshot.team.tasks.find(candidate => candidate.id === taskId)!
      const attempt = snapshot.team.attempts.find(candidate => candidate.id === task.currentAttemptId)
      expect(attempt?.assignmentPhase).toBe('delivered')
      const lease = first!.ctx.agentSwarm.executionRoots.roots.leaseOf(scope, teamId, taskId, attempt!.id)
      expect(lease).toBeDefined()
      return { attempt: attempt!, root: lease!.path }
    }, { timeout: 10_000 })
    const root = claim.root
    const currentChild = first.ctx.agents.get(childId)!
    const written = await tool(first.ctx, currentChild, 'before', 'write', { file_path: 'work.txt', content: 'before restart' })
    expect(written.isError).toBe(false)
    expect(await readFile(join(root, 'work.txt'), 'utf8')).toBe('before restart')
    await first.ctx.subagents.drainContinuableChildren(lead, [childId])
    expect(first.ctx.agents.get(childId)).toBeUndefined()
    await dispose(first)
    first = undefined
    expect(existsSync(join(root, 'work.txt')), 'shutdown must retain unfinished output').toBe(true)
    if (!existingRoot) await rename(root, `${root}-retained`)

    second = await mount(sandbox)
    const resumed = await second.ctx.agents.resume({ resumeSessionId: captainId })
    try {
      let recovered: Agent | undefined
      const stop = second.ctx.on('agent/created', ({ agent }) => { if (agent.id === childId) recovered = agent })
      try {
        const woke = await tool(second.ctx, resumed.agent, 'wake', 'agent_swarm_send_message', { target: 'worker', content: 'Continue the existing attempt.', delivery: 'wakeup' })
        expect(woke.isError).toBe(false)
        await vi.waitFor(() => expect(recovered).toBeDefined())
        expect(second.ctx.agents.get(childId)).toBe(recovered)
        const restored = await second.ctx.agentSwarm.domain.snapshot(scope, teamId, resumed.agent.id)
        expect(restored.team.tasks.find(task => task.id === taskId)).toMatchObject({ currentAttemptId: claim.attempt.id, ownerSessionId: childId })
        expect(restored.team.attempts.find(attempt => attempt.id === claim.attempt.id)).toMatchObject({ phase: 'running' })
        const edited = existingRoot
          ? await tool(second.ctx, recovered!, 'after', 'edit', { file_path: 'work.txt', old_string: 'before restart', new_string: 'after restart' })
          : await tool(second.ctx, recovered!, 'missing', 'write', { file_path: 'work.txt', content: 'must not escape' })
        expect(edited.isError, JSON.stringify(edited)).toBe(!existingRoot)
        expect(existsSync(join(scope, 'work.txt'))).toBe(false)
        const lease = second.ctx.agentSwarm.executionRoots.roots.leaseOf(scope, teamId, taskId, claim.attempt.id)
        if (existingRoot) {
          expect(await readFile(join(root, 'work.txt'), 'utf8')).toBe('after restart')
          expect(lease?.path).toBe(root)
        } else {
          expect(lease).toBeUndefined()
          expect(existsSync(root)).toBe(false)
          expect(await readFile(join(`${root}-retained`, 'work.txt'), 'utf8')).toBe('before restart')
        }
      } finally { stop() }
    } finally { await resumed.dispose() }
  } finally {
    if (first !== undefined) await dispose(first)
    if (second !== undefined) await dispose(second)
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 30_000)
