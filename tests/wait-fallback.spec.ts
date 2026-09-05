import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { waitForChange, type WaitSurfaceDeps } from '../src/runtime/wait-surface.js'
import { openStorageStack, type StorageStack } from './helpers/storage-stack.js'

let root: string
let stack: StorageStack
const scope = 'wait-fallback-scope'
const actor = { id: 'wait-captain' } as Agent
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-wait-fallback-'))
  stack = await openStorageStack(root)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await stack.close()
  await rm(root, { recursive: true, force: true })
})

const deps = (): WaitSurfaceDeps => ({
  ctx: stack.ctx, domain: () => stack.port, isClosing: () => false,
  scopeOf: () => scope, ensureReady: async () => {},
})

it('returns the last authorized snapshot when the real wait times out and its final read fails', async () => {
  const team = await stack.port.createTeam(scope, actor.id, 'Timeout fallback', 'Read fault after wait')
  const before = await stack.port.snapshot(scope, team.id, actor.id)
  const timeout = new AbortController()
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const originalWait = stack.store.waitForChange.bind(stack.store)
  vi.spyOn(stack.store, 'waitForChange').mockImplementation((...args) => {
    const result = originalWait(...args)
    entered()
    return result
  })
  vi.spyOn(stack.port, 'snapshot').mockRejectedValueOnce(new Error('injected final read failure'))
  const result = waitForChange(deps(), { agent: actor, signal: new AbortController().signal }, team.revision, 10_000)
  await started
  timeout.abort(new DOMException('deadline', 'TimeoutError'))
  await expect(result).resolves.toEqual({ outcome: 'timed-out', changed: false, snapshot: before })
})

it('preserves a real committed change and propagates unrelated wait errors', async () => {
  const team = await stack.port.createTeam(scope, actor.id, 'Changed wait', 'Do not hide success or errors')
  await stack.port.createTask(scope, team.id, actor.id, { subject: 'Changed', description: 'New revision' })
  const exec = { agent: actor, signal: new AbortController().signal }
  const result = await waitForChange(deps(), exec, team.revision, 10_000)
  expect(result.changed).toBe(true)
  expect(result.snapshot.team.tasks).toHaveLength(1)
  const failure = new Error('primary wait failed')
  vi.spyOn(stack.port, 'waitForChange').mockRejectedValueOnce(failure)
  await expect(waitForChange(deps(), exec, result.snapshot.team.revision, 10_000)).rejects.toBe(failure)
})
