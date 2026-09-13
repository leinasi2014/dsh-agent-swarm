/** Real official inbox and maintenance boundaries around cold child transport. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { queueHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
import { expect, it, vi } from 'vitest'
import { installChildOperationRecovery, withLiveChild } from '../src/runtime/continuable-child.js'
import { readPersistedSession } from '../src/runtime/persisted-session.js'
import { Recording, setup, createTeam } from './helpers/public-chat-real-composition.js'
import { RESTART_SIGNAL as SIGNAL } from './helpers/restart-real-composition.js'

it.each(['complete', 'cancel'] as const)('keeps real input queued during cold maintenance and releases its wake on %s', async outcome => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-child-maintenance-')), adapter = new Recording()
  const f = await setup(sandbox, adapter)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  try {
    const { root, captain } = await createTeam(f, sandbox)
    await f.ctx.subagents.drainContinuableChildren(root, [captain.id])
    expect(f.ctx.agents.get(captain.id) === undefined).toBe(true)
    const before = adapter.requests.filter(request => request.sessionId === captain.id).length
    const controller = new AbortController()
    let active: Agent | undefined
    const pending = withLiveChild(f.ctx, root, captain.id, controller.signal, async (child, signal) => {
      active = child
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        void gate.then(resolve).finally(() => signal.removeEventListener('abort', abort))
      })
      signal.throwIfAborted()
      return 'maintained'
    })
    void pending.catch(() => {})
    await vi.waitFor(() => expect(active).toBeDefined())
    await queueHostSubagentPrompt(f.ctx.subagents, root, captain.id, [{ type: 'text', text: 'REAL INPUT AFTER MAINTENANCE' }],
      { kind: 'user' }, SIGNAL)
    expect(adapter.requests.filter(request => request.sessionId === captain.id)).toHaveLength(before)
    expect(active!.inbox.nextTurn.some(message => message.content.some(part => part.type === 'text' && part.text === 'REAL INPUT AFTER MAINTENANCE'))).toBe(true)
    if (outcome === 'cancel') {
      controller.abort(new Error('cancel only this transport operation'))
      await expect(pending).rejects.toThrow('cancel only this transport operation')
    } else { release(); expect(await pending).toBe('maintained') }
    await active!.whenIdle()
    // Assert a scalar: formatting a live Cordis Agent probes undeclared injections
    // and masks the actual lifecycle failure on a busy CI runner.
    await vi.waitFor(() => expect(f.ctx.agents.get(captain.id) === undefined).toBe(true), { timeout: 5_000 })
    const requests = adapter.requests.filter(request => request.sessionId === captain.id).slice(before)
    expect(requests).toHaveLength(1)
    expect(JSON.stringify(requests)).toContain('REAL INPUT AFTER MAINTENANCE')
    expect(JSON.stringify(requests)).not.toContain('Agent Swarm transport maintenance v1:')
    const stored = await readPersistedSession(f.ctx.sessionPersistence, captain.id, SIGNAL)
    expect(stored.events.filter(event => event.type === 'user/message' && event.data.content.some(part => part.type === 'text'
      && part.text === 'REAL INPUT AFTER MAINTENANCE'))).toHaveLength(1)
  } finally { release(); await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 15_000)

it('settles the caller when both maintenance admission and marker cleanup fail', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-child-failed-maintenance-')), adapter = new Recording()
  const f = await setup(sandbox, adapter)
  let off: (() => void) | undefined
  try {
    const { root, captain } = await createTeam(f, sandbox)
    await f.ctx.subagents.drainContinuableChildren(root, [captain.id])
    expect(f.ctx.agents.get(captain.id) === undefined).toBe(true)
    const before = adapter.requests.filter(request => request.sessionId === captain.id).length
    off = f.ctx.on('agent/session-start', ({ agent }) => {
      if (agent.id !== captain.id) return
      vi.spyOn(agent, 'runMaintenance').mockImplementationOnce(() => { throw new Error('maintenance already occupied') })
      vi.spyOn(agent.inbox, 'remove').mockImplementationOnce(() => { throw new Error('marker persistence failed') })
    })
    const callback = vi.fn()
    await expect(withLiveChild(f.ctx, root, captain.id, SIGNAL, callback)).rejects.toMatchObject({
      message: 'child transport maintenance and marker cleanup failed',
      errors: [expect.objectContaining({ message: 'maintenance already occupied' }), expect.objectContaining({ message: 'marker persistence failed' })],
    })
    expect(callback).not.toHaveBeenCalled()
    await f.ctx.agents.get(captain.id)?.whenIdle()
    expect(adapter.requests.filter(request => request.sessionId === captain.id)).toHaveLength(before)
  } finally { off?.(); await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 10_000)

it('removes only complete plugin transport markers and preserves lookalike user input', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-child-orphan-'))
  const f = await setup(sandbox, new Recording())
  try {
    const { root, captain } = await createTeam(f, sandbox)
    await f.ctx.subagents.drainContinuableChildren(root, [captain.id])
    expect(f.ctx.agents.get(captain.id) === undefined).toBe(true)
    await withLiveChild(f.ctx, root, captain.id, SIGNAL, async child => {
      const text = 'Agent Swarm transport maintenance v1: 00000000-0000-4000-8000-000000000001'
      const orphan = createUserMessage({ source: { kind: 'plugin', plugin: 'dsh-agent-swarm' }, content: [{ type: 'text', text }] })
      const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
      const malformed = createUserMessage({ source: { kind: 'plugin', plugin: 'dsh-agent-swarm' }, content: [{ type: 'text', text: text + ' trailing input' }] })
      for (const message of [orphan, user, malformed]) child.inject(message)
      const dispose = installChildOperationRecovery(f.ctx)
      try { expect(child.inbox.nextStep.map(message => message.id)).toEqual([user.id, malformed.id]) }
      finally { dispose() }
    })
  } finally { await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 10_000)
