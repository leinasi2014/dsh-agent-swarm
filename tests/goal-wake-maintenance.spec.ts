/** Goal scheduling releases official maintenance before waiting for its own input claim. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { childIsMaintained, withLiveChild } from '../src/runtime/continuable-child.js'
import { framePredicate } from '../src/runtime/frame-visibility.js'
import { messageFrame } from '../src/runtime/prompts.js'
import { readPersistedSession } from '../src/runtime/persisted-session.js'
import * as providers from '../src/runtime/providers.js'
import { SchedulingPass } from '../src/runtime/scheduling.js'
import { addPublicMembers, createTeam, Recording, setup } from './helpers/public-chat-real-composition.js'
import { RESTART_SIGNAL as SIGNAL } from './helpers/restart-real-composition.js'

it.each(['new', 'pending', 'ordinary', 'concurrent', 'obsolete'] as const)('releases cold Captain maintenance before its claim (%s)', async mode => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-goal-wake-maintenance-'))
  const adapter = new Recording(), f = await setup(sandbox, adapter)
  let release!: () => void, off: (() => void) | undefined, offPending: (() => void) | undefined, wake: Promise<void> | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  try {
    const { root, captain, teamId, scope } = await createTeam(f, sandbox)
    const members = mode === 'ordinary' ? await addPublicMembers(f, root, captain.id) : []
    await vi.waitFor(() => expect(f.ctx.agents.get(captain.id)).toBeUndefined())
    const domain = f.ctx.agentSwarm.domain
    const ordinary = mode === 'ordinary' ? await domain.queueMessage(scope, teamId, members[0]!, 'captain',
      'An ordinary member message already pending for the same Captain.', 'wakeup') : undefined
    await domain.saveGoal(scope, teamId, { kind: 'local-operator' }, {
      requestId: 'maintenance-goal', expectedLifecycleRevision: 0, start: true,
      tokenBudget: { expectedTokenLimit: null, tokenLimit: 100 },
      goal: { text: 'Coordinate after a cold wake.', acceptanceCriteria: 'One real coordination input.', constraints: '', mode: 'finite' },
    })
    const read = async () => (await domain.snapshot(scope, teamId, captain.id)).team
    const notice = (await read()).messages.find(message => message.kind === 'goal-coordination-notice')!
    const frame = messageFrame(notice), matches = framePredicate(frame)
    const messages = ordinary === undefined ? [notice] : [notice, ordinary]
    if (mode === 'pending' || ordinary !== undefined) {
      // Recreate the real pending-input crash window through the official inbox,
      // with the original Team message identity. No synthetic Session events.
      let inserted = false
      offPending = f.ctx.on('agent/inbox/inserted', ({ agent, message }) => {
        if (inserted || agent.id !== captain.id || !message.content.some(part => part.type === 'text'
          && part.text.startsWith('Agent Swarm transport maintenance v1: '))) return
        inserted = true
        agent.inject(createUserMessage({ source: { kind: 'plugin', plugin: 'dsh-agent-swarm' },
          content: [{ type: 'text', text: messageFrame(ordinary ?? notice) }] }))
      })
    }
    let entered = false
    off = f.ctx.on('agent/pre-step', async (proposal, next) => {
      const decision = await next()
      if (proposal.agent.id === captain.id && proposal.messages.some(matches)) { entered = true; await gate }
      return decision
    })
    wake = f.ctx.agentSwarm.goals.wake(scope, teamId)
    if (mode === 'concurrent') wake = Promise.all([wake, f.ctx.agentSwarm.goals.wake(scope, teamId)]).then(() => {})
    void wake.catch(() => {})
    // The real pre-step cannot be reached while maintenance is waiting for itself.
    await vi.waitFor(() => expect(entered).toBe(true), { timeout: 1_000 })
    for (const message of messages) expect((await read()).messages.find(row => row.id === message.id)?.phase).toBe('queued')
    expect(adapter.requests.some(request => request.sessionId === captain.id
      && request.messages.some(message => message.role === 'user'
        && message.content.some(part => part.type === 'text' && part.text === frame)))).toBe(false)
    if (mode === 'obsolete') await domain.markMessageObsolete(scope, teamId, notice.id, 'Replaced while the original input was still being assembled.')
    release(); await wake
    await vi.waitFor(async () => {
      for (const message of messages) expect((await read()).messages.find(row => row.id === message.id)?.phase)
        .toBe(mode === 'obsolete' ? 'obsolete' : 'delivered')
    })
    await f.ctx.agents.get(captain.id)?.whenIdle()
    const stored = await readPersistedSession(f.ctx.sessionPersistence, captain.id, SIGNAL)
    for (const message of messages) {
      const exact = framePredicate(messageFrame(message))
      expect(stored.events.filter(event => event.type === 'user/message' && exact(event.data))).toHaveLength(1)
      expect(stored.events.flatMap(event => event.type === 'agent/inbox/spliced' ? event.data.inserted : []).filter(exact)).toHaveLength(1)
    }
  } finally {
    release(); off?.(); offPending?.(); await wake?.catch(() => {}); await f.close()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 15_000)

it('reports task creation as committed when its scheduling admission fails', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-created-admission-failure-'))
  const f = await setup(sandbox, new Recording())
  try {
    const { root, captain, teamId, scope } = await createTeam(f, sandbox)
    await withLiveChild(f.ctx, root, captain.id, SIGNAL, async (live, signal) => {
      const failure = new Error('Post-commit scheduling failed')
      const pass = vi.spyOn(SchedulingPass.prototype, 'run').mockRejectedValue(failure)
      try {
        await expect(f.ctx.agentSwarm.createTask({ agent: live, signal }, { subject: 'Keep the committed task', description: 'Admission can be retried.' }))
          .rejects.toMatchObject({ code: 'TEAM_TASK_CREATE_ADMISSION_FAILED', message: expect.stringContaining('committed at revision 1'), cause: failure })
        const team = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
        expect(team.tasks).toHaveLength(1)
        expect(team.tasks[0]).toMatchObject({ subject: 'Keep the committed task', status: 'pending', revision: 1 })
      } finally { pass.mockRestore() }
    })
  } finally {
    await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 15_000)

it.each(['assigned', 'open-claim'] as const)('revokes %s admission when the actual Captain maintenance is cancelled during Provider selection', async assignmentMode => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-goal-provider-cancel-'))
  const adapter = new Recording(), provider = providers.priorityReadyScheduler()
  let release!: () => void, armed = false, entered = false, wake: Promise<void> | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  const controlled = vi.spyOn(providers, 'priorityReadyScheduler').mockReturnValue({ select: async input => {
    if (armed) { entered = true; await gate }
    return await provider.select(input)
  } })
  const f = await setup(sandbox, adapter)
  try {
    const { root, captain, teamId, scope } = await createTeam(f, sandbox)
    const members = await addPublicMembers(f, root, captain.id)
    await vi.waitFor(() => expect(f.ctx.agents.get(captain.id)).toBeUndefined())
    const domain = f.ctx.agentSwarm.domain
    const task = await domain.createTask(scope, teamId, captain.id, { subject: 'Do not start cancelled admission', description: 'The selector is interrupted.',
      ...(assignmentMode === 'open-claim' ? { assignmentMode } : {}) })
    await domain.saveGoal(scope, teamId, { kind: 'local-operator' }, { requestId: 'cancel-provider-goal', expectedLifecycleRevision: 0, start: true,
      goal: { text: 'Admit only under the live maintenance lease.', acceptanceCriteria: 'No new work after cancellation.', constraints: '', mode: 'finite' } })
    const before = adapter.requests.filter(request => members.includes(request.sessionId as never)).length
    armed = true; wake = f.ctx.agentSwarm.goals.wake(scope, teamId); void wake.catch(() => {})
    await vi.waitFor(() => expect(entered).toBe(true))
    const active = f.ctx.agents.get(captain.id)!
    expect(childIsMaintained(active)).toBe(true)
    f.ctx.subagents.interrupt(captain.id, { kind: 'ancestor', agent: root })
    // Exact identity alone cannot authorize work after its maintenance lease is cancelled.
    expect(f.ctx.agents.get(captain.id)).toBe(active)
    release(); await expect(wake).rejects.toBeDefined()
    const after = (await domain.snapshot(scope, teamId, captain.id)).team
    expect(after.tasks.find(row => row.id === task.id)).toMatchObject({ status: 'pending', revision: task.revision })
    expect(after.attempts).toEqual([])
    expect(after.messages.filter(message => message.kind === 'open-claim-notice')).toEqual([])
    expect(adapter.requests.filter(request => members.includes(request.sessionId as never))).toHaveLength(before)
  } finally {
    armed = false; release(); await wake?.catch(() => {}); await f.close(); controlled.mockRestore()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 15_000)

it('cancels an actual maintenance admission before mailbox dispatch and retries the original debt', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-goal-wake-cancel-'))
  const f = await setup(sandbox, new Recording())
  let release!: () => void, wake: Promise<void> | undefined, restore = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  try {
    const { root, captain, teamId, scope } = await createTeam(f, sandbox)
    await vi.waitFor(() => expect(f.ctx.agents.get(captain.id)).toBeUndefined())
    const domain = f.ctx.agentSwarm.domain
    await domain.saveGoal(scope, teamId, { kind: 'local-operator' }, { requestId: 'cancel-maintenance-goal', expectedLifecycleRevision: 0,
      start: true, tokenBudget: { expectedTokenLimit: null, tokenLimit: 100 },
      goal: { text: 'Retry one interrupted admission.', acceptanceCriteria: 'One original notice.', constraints: '', mode: 'finite' } })
    const original = (await domain.snapshot(scope, teamId, captain.id)).team.messages.find(message => message.kind === 'goal-coordination-notice')!
    const snapshot = domain.snapshot.bind(domain)
    let entered = false
    const spy = vi.spyOn(domain, 'snapshot').mockImplementation(async (...args) => {
      const value = await snapshot(...args), active = f.ctx.agents.get(captain.id)
      if (!entered && active !== undefined && childIsMaintained(active)) { entered = true; await gate }
      return value
    })
    restore = () => spy.mockRestore()
    wake = f.ctx.agentSwarm.goals.wake(scope, teamId); void wake.catch(() => {})
    await vi.waitFor(() => expect(entered).toBe(true))
    f.ctx.subagents.interrupt(captain.id, { kind: 'ancestor', agent: root })
    release(); await expect(wake).rejects.toBeDefined(); restore()
    expect((await snapshot(scope, teamId, captain.id)).team.messages.find(message => message.id === original.id)?.phase).toBe('queued')
    const matches = framePredicate(messageFrame(original))
    const before = await readPersistedSession(f.ctx.sessionPersistence, captain.id, SIGNAL)
    expect(before.events.flatMap(event => event.type === 'agent/inbox/spliced' ? event.data.inserted : []).filter(matches)).toHaveLength(0)
    await f.ctx.agentSwarm.goals.wake(scope, teamId)
    expect((await snapshot(scope, teamId, captain.id)).team.messages.find(message => message.id === original.id)?.phase).toBe('delivered')
    const after = await readPersistedSession(f.ctx.sessionPersistence, captain.id, SIGNAL)
    expect(after.events.filter(event => event.type === 'user/message' && matches(event.data))).toHaveLength(1)
  } finally {
    release(); restore(); await wake?.catch(() => {}); await f.close()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 15_000)
