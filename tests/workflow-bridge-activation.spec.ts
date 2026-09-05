import type { KvUnit } from '@deepseek-ai/dsh-storage'
import { afterEach, expect, it, vi } from 'vitest'
import { TeamBridgeWorkflowEngine } from '../src/runtime/workflow/team-bridge-engine.js'
import { WorkflowRunOverlayStore, workflowOverlayDomainSpec } from '../src/storage/workflow-run-overlay.js'
import { FaultableBackend, openFaultableStack } from './helpers/storage-stack.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
  vi.restoreAllMocks()
})

async function mount() {
  const backend = new FaultableBackend()
  const stack = await openFaultableStack(backend)
  cleanup.push(() => stack.close())
  const opened: Array<{ unit: KvUnit; closed: boolean }> = []
  const open = backend.kv.open.bind(backend.kv)
  vi.spyOn(backend.kv, 'open').mockImplementation(async descriptor => {
    const unit = await open(descriptor)
    const record = { unit, closed: false }
    opened.push(record)
    return { ...unit, close: async () => { await unit.close(); record.closed = true } }
  })
  const domain = await stack.ctx.storageDomain.open(workflowOverlayDomainSpec)
  const store = new WorkflowRunOverlayStore(stack.ctx, domain)
  await store.put({ schemaVersion: 1, runId: 'run-187', teamId: 'team-187', scope: '/workflow-proof',
    meta: { name: 'recovery', description: 'Recover a durable running record' },
    state: 'running', agentsStarted: 0, createdAt: 1, updatedAt: 1 })
  store.close()
  await domain.close()
  const engine = new TeamBridgeWorkflowEngine(stack.ctx.isolate('workflowEngine'), {} as never, { maxTotalAgents: 8, disposeGraceMs: 1000 })
  cleanup.push(() => engine.dispose())
  return { ...stack, backend, engine, opened }
}

it('closes the actual opened unit after recovery write failure and retries the same domain', async () => {
  const { ctx, backend, engine, opened } = await mount()
  backend.failNextWrites = 1
  await expect(engine.activate()).rejects.toThrow('injected write failure')
  expect(opened.at(-1)?.closed).toBe(true)
  expect(() => engine.overlay).toThrow('not activated')
  const reopened = await ctx.storageDomain.open(workflowOverlayDomainSpec)
  expect(reopened.table('runs').get('run-187')?.state).toBe('running')
  await reopened.close()
  await engine.activate()
  expect(engine.overlay.get('run-187')?.state).toBe('interrupted')
  await engine.dispose()
  await engine.dispose()
  expect(opened.every(record => record.closed)).toBe(true)
})

it('drains an activation already opening a domain when disposal starts', async () => {
  const { engine, backend, opened } = await mount()
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const opening = new Promise<void>(resolve => { entered = resolve })
  const open = vi.mocked(backend.kv.open).getMockImplementation()!
  vi.mocked(backend.kv.open).mockImplementationOnce(async descriptor => {
    const unit = await open(descriptor)
    entered()
    await gate
    return unit
  })
  const activation = engine.activate()
  const observed = activation.catch(error => error)
  await opening
  const disposal = engine.dispose()
  release()
  await disposal
  await observed
  expect(opened.at(-1)?.closed).toBe(true)
  expect(() => engine.overlay).toThrow('not activated')
})

it('preserves recovery and cleanup errors while still closing the domain', async () => {
  const { backend, engine, opened } = await mount()
  backend.failNextWrites = 1
  const cleanupFailure = new Error('store close failed')
  vi.spyOn(WorkflowRunOverlayStore.prototype, 'close').mockImplementationOnce(() => { throw cleanupFailure })
  const failure = await engine.activate().catch(error => error)
  expect(failure).toBeInstanceOf(AggregateError)
  expect(failure.cause.message).toBe('injected write failure')
  expect(failure.errors).toEqual([failure.cause, cleanupFailure])
  expect(opened.at(-1)?.closed).toBe(true)
})
