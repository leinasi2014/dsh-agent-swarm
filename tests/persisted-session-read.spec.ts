import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { expect, it, vi } from 'vitest'
import { readPersistedSession } from '../src/runtime/persisted-session.js'

it.each(['success', 'read-error', 'abort'] as const)('closes a real read handle once on %s without taking the existing writer lease', async outcome => {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-read-handle-'))
  const ctx = new Context()
  const store = await ctx.plugin(SessionStore)
  const backend = await ctx.plugin(JsonlSessionPersistence, { root: directory, compression: 'none' })
  const id = SessionId('read-handle-owner')
  const writer = await ctx.sessionPersistence.create({ version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false })
  const abort = new AbortController()
  const failure = new Error('read failed after opening')
  let close: ReturnType<typeof vi.spyOn> | undefined
  const open = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
  const opened = vi.spyOn(ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args)
    close = vi.spyOn(handle, 'close')
    if (outcome === 'read-error') vi.spyOn(handle, 'read').mockRejectedValueOnce(failure)
    if (outcome === 'abort') abort.abort(failure)
    return handle
  })
  try {
    await writer.flush()
    const reading = readPersistedSession(ctx.sessionPersistence, id, abort.signal)
    if (outcome === 'success') await expect(reading).resolves.toMatchObject({ meta: { id }, events: [], inheritedEventCount: 0 })
    else await expect(reading).rejects.toBe(failure)
    expect(opened).toHaveBeenCalledExactlyOnceWith(id, 'read', { signal: abort.signal })
    expect(close).toHaveBeenCalledOnce()
    // The original owner remains usable after the observer has closed.
    await expect(writer.flush()).resolves.toBeUndefined()
  } finally {
    opened.mockRestore()
    await writer.close(); await backend.dispose(); await store.dispose()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
