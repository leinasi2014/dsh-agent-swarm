/** Browser-safe R2 client has no import/mount I/O and owns physical abort. */
import { describe, expect, it, vi } from 'vitest'
import { SwarmReadClient } from '../src/client/index.js'

describe('R2 browser client', () => {
  it('does no work before a request and sends only the versioned JSON envelope', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      schemaVersion: 1, ok: true, value: { protocol: 'dsh-agent-swarm/read-rpc' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const mount = new SwarmReadClient(fetcher).mount()
    expect(fetcher).not.toHaveBeenCalled()
    await expect(mount.request({ schemaVersion: 1, method: 'capabilities' })).resolves.toMatchObject({ ok: true })
    expect(fetcher).toHaveBeenCalledWith('/swarm/v1', expect.objectContaining({ method: 'POST' }))
  })

  it('aborts admitted work on unmount and forbids later requests', async () => {
    let observedSignal: AbortSignal | undefined
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      observedSignal = init?.signal ?? undefined
      observedSignal?.addEventListener('abort', () => reject(observedSignal?.reason), { once: true })
    }))
    const mount = new SwarmReadClient(fetcher).mount()
    const pending = mount.request({ schemaVersion: 1, method: 'capabilities' })
    mount.dispose()
    await expect(pending).rejects.toBeDefined()
    expect(observedSignal?.aborted).toBe(true)
    await expect(mount.request({ schemaVersion: 1, method: 'capabilities' })).rejects.toThrow('disposed')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
