/** Real Loader/Connection/HTTP composition with webServer outside the root Context.
 * Business input is deliberately invalid: this isolates route/auth/lifecycle from Team execution.
 */
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Loader, { type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it, vi } from 'vitest'
import { mountAgentSwarmPublicRpc } from '../src/rpc/public-rpc-service.js'

const require = createRequire(import.meta.url)
const yaml = createRequire(require.resolve('@deepseek-ai/cordis-plugin-include'))('js-yaml') as {
  load(text: string, options: { schema: unknown }): unknown
}
async function bundle(): Promise<PatchOptions[]> {
  return yaml.load(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), { schema: entryListSchema }) as PatchOptions[]
}

// Official 0.1.5-rc.2 packages/bundle/web-app/cordis.patch.yml connection row.
// webRuntime supplies trustedHosts in that Profile; retain both its dependency and resolved config.
const officialConnection: EntryOptions = {
  id: 'connection', name: '@deepseek-ai/dsh-client-connection', inject: ['webRuntime'],
  config: { trustedHosts: ['deployment.example'] },
}
interface Route {
  kind: 'exact' | 'prefix'
  path: string
  handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>
}

async function mounted() {
  const ctx = new Context(), routes = new Map<string, Route>(), fibers: Fiber[] = []
  let record: CredentialRecord | undefined
  // Only persistence is in memory. The real official BrowserAuth creates and verifies the cookie.
  ctx.provide('credentials', {
    async modifyRecord(_key: unknown, mutate: (value: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
      const next = await mutate(record)
      if (next !== undefined) record = next
      return record
    },
  } as CredentialProvider)
  ctx.provide('webRuntime', { trustedHosts: ['deployment.example'] })
  ctx.provide('agentSwarmHostRead', {} as never)
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (path === '/') { ctx.connection.authorizeIndex(req, res); return }
    const route = [...routes.values()].find(row => path === row.path || row.kind === 'prefix' && path.startsWith(row.path + '/'))
    if (route === undefined) { res.writeHead(405).end(); return }
    void Promise.resolve(route.handler(req, res)).catch(() => { res.writeHead(500).end() })
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('HTTP listener did not bind')
  const base = `http://127.0.0.1:${address.port}`
  const close = async () => {
    for (const fiber of fibers.toReversed()) await fiber.dispose()
    await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve() }) })
  }
  try {
    // Providing this at ctx.root masks the Connection provider's missing webServer inject.
    fibers.push(await ctx.plugin({ name: 'scoped-webserver', apply(owner) {
      owner.provide('webServer', { host: '127.0.0.1', port: address.port, register(route: Route) {
        const key = `${route.kind}:${route.path}`
        if (routes.has(key)) throw new Error(`duplicate route ${key}`)
        routes.set(key, route)
        return () => { routes.delete(key) }
      } } as never)
    } }))
    fibers.push(await ctx.plugin(Loader))
    ctx.loader.builtins['@deepseek-ai/dsh-client-connection'] = Connection
    const patched = applyEntryPatches([officialConnection], await bundle(), message => { throw new Error(message) })
    const row = patched.find(entry => entry.id === 'connection')!
    await ctx.loader.root.update([row])
    await ctx.loader.await()
    const mount = async () => {
      const fiber = await ctx.plugin({ name: 'public-rpc-consumer', apply(owner) {
        // Invalid requests are rejected before any Team read/runtime operation.
        mountAgentSwarmPublicRpc(owner, {} as never)
      } })
      fibers.push(fiber)
      return fiber
    }
    return { ctx, routes, base, mount, close }
  } catch (error) { await close(); throw error }
}

describe('public RPC Bundle composition', () => {
  it('mounts the shipped public route through the scoped official provider, authenticates, unloads and remounts', async () => {
    const f = await mounted()
    try {
      const consumer = await f.mount()
      await vi.waitFor(() => { expect(f.routes.has('prefix:/swarm-public')).toBe(true) })
      const post = (headers: Record<string, string> = {}) => fetch(`${f.base}/swarm-public/v3/history`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ type: 'client-request', rpcId: 'composition-read', method: 'v3/history', payload: {} }),
      })
      expect((await post()).status).toBe(401)
      const exchange = await fetch(f.ctx.connection.authenticatedUrl(f.base), { redirect: 'manual' })
      expect(exchange.status).toBe(303)
      const cookie = exchange.headers.get('set-cookie')!.split(';', 1)[0]!
      expect((await post({ cookie, origin: 'https://untrusted.invalid' })).status).toBe(403)
      const response = await post({ cookie, origin: f.base })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ type: 'server-response', rpcId: 'composition-read',
        result: { ok: false, error: { code: 'SWARM_RPC_INVALID_REQUEST' } } })
      await consumer.dispose()
      expect(f.routes.has('prefix:/swarm-public')).toBe(false)
      expect(f.routes.has('prefix:/api')).toBe(true)
      expect((await post({ cookie })).status).toBe(405)
      await f.mount()
      await vi.waitFor(() => { expect(f.routes.has('prefix:/swarm-public')).toBe(true) })
      expect((await post({ cookie })).status).toBe(200)
    } finally { await f.close() }
  })

  it('preserves the existing Web dependency and configuration without creating a second Connection', async () => {
    const result = applyEntryPatches([officialConnection], await bundle(), message => { throw new Error(message) })
    const connection = result.filter(row => row.id === 'connection')
    expect(connection).toHaveLength(1)
    expect(connection[0]).toEqual({ ...officialConnection, inject: ['webRuntime', 'webServer'] })
    expect(officialConnection.inject).toEqual(['webRuntime'])
  })

  it('does not add Connection to a non-Web composition and skips a differently named connection row', async () => {
    for (const entries of [[], [{ id: 'connection', name: 'other-transport', inject: ['otherService'] }]]) {
      const warnings: string[] = []
      const result = applyEntryPatches(entries, await bundle(), message => { warnings.push(message) })
      expect(result.filter(row => row.id === 'connection')).toEqual(entries)
      expect(result.find(row => row.id === 'agent-swarm')).toMatchObject({ group: true, disabled: false })
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toMatch(/not found|name mismatch/)
    }
  })
})
