/**
 * Shared test harness: composes the REAL official storage stack (hub +
 * json KV backend + domain form) and opens the `agent_swarm` domain, so the
 * port conformance, migration and composition suites exercise the same
 * services a deployment composes. `FaultableBackend` provides a KV facet
 * with injected write failures and stored-value mutation for durability and
 * read-back fault injection.
 */

import { Context, type Fiber } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { KvFacet, KvUnit, KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { TeamDomainPort } from '../../src/domain/team-domain-port.js'
import { StorageDomainTeamStore } from '../../src/storage/storage-domain-team-store.js'
import { teamDomainSpec } from '../../src/storage/team-spec.js'
import { TeamDomain } from '../../src/domain/team-domain.js'

/** One opened storage composition over the real official plugins. */
export interface StorageStack {
  readonly ctx: Context
  readonly domain: Domain<typeof teamDomainSpec>
  readonly store: StorageDomainTeamStore
  readonly port: TeamDomainPort
  /** Tear the whole composition down in reverse mount order. */
  close(): Promise<void>
}

async function openOn(ctx: Context, fibers: Fiber[], now: () => number): Promise<StorageStack> {
  let opened: StorageStack | undefined
  try {
    const domain = await ctx.storageDomain.open(teamDomainSpec)
    const store = new StorageDomainTeamStore(ctx, domain, now)
    const port = new TeamDomain(store, undefined, now)
    opened = {
      ctx,
      domain,
      store,
      port,
      async close() {
        await store.close()
        await domain.close()
        for (const fiber of fibers.toReversed()) await fiber.dispose()
      },
    }
    return opened
  } catch (error) {
    // A failed open must not leak the half-mounted composition.
    for (const fiber of fibers.toReversed()) await fiber.dispose()
    throw error
  }
}

/**
 * Mount hub + json backend + domain form on a fresh Context and open the
 * team domain. `root` is the json backend unit root (use a temp dir).
 */
export async function openStorageStack(
  root: string,
  now: () => number = Date.now,
): Promise<StorageStack> {
  const ctx = new Context()
  const fibers: Fiber[] = []
  fibers.push(await ctx.plugin(Storage))
  fibers.push(await ctx.plugin(StorageJson, { root }))
  fibers.push(await ctx.plugin(StorageDomain, { backend: 'json' }))
  return await openOn(ctx, fibers, now)
}

/** Unit-file path of the `agent_swarm` domain under a json backend root. */
export function unitFilePath(root: string): string {
  return `${root.replace(/[\\/]+$/, '')}/agent_swarm.json`
}

/**
 * In-memory KV backend with fault injection: `failNextWrites` rejects that
 * many subsequent write primitives without touching the medium;
 * `mutateOnPut` transforms one stored record after durability, simulating a
 * medium that does not round-trip the exact value.
 */
export class FaultableBackend implements StorageBackend {
  readonly kv: KvFacet
  failNextWrites = 0
  mutateOnPut: ((table: string, key: string, value: unknown) => unknown) | undefined

  constructor(private readonly media = new Map<string, { tables: Map<string, Map<string, unknown>>; global: unknown }>()) {
    this.kv = {
      open: async (descriptor: KvUnitDescriptor): Promise<KvUnit> => {
        let unit = this.media.get(descriptor.name)
        if (unit === undefined) {
          unit = { tables: new Map(), global: null }
          this.media.set(descriptor.name, unit)
        }
        const tables = unit.tables
        return {
          loadAll: async () => {
            const snapshot: Record<string, Record<string, unknown>> = {}
            for (const table of descriptor.tables) {
              snapshot[table] = Object.fromEntries(tables.get(table) ?? [])
            }
            return { tables: snapshot, global: unit?.global ?? null }
          },
          putRecord: async (table, key, value) => {
            if (this.failNextWrites > 0) {
              this.failNextWrites -= 1
              throw new Error('injected write failure')
            }
            let records = tables.get(table)
            if (records === undefined) {
              records = new Map()
              tables.set(table, records)
            }
            records.set(key, this.mutateOnPut === undefined ? value : this.mutateOnPut(table, key, value))
          },
          deleteRecord: async (table, key) => {
            if (this.failNextWrites > 0) {
              this.failNextWrites -= 1
              throw new Error('injected write failure')
            }
            tables.get(table)?.delete(key)
          },
          setGlobal: async value => {
            if (this.failNextWrites > 0) {
              this.failNextWrites -= 1
              throw new Error('injected write failure')
            }
            unit.global = value
          },
          close: async () => {},
        }
      },
    }
  }

  async close(): Promise<void> {}
}

/** Open a store over a fault-injecting in-memory backend on a fresh Context. */
export async function openFaultableStack(
  backend: FaultableBackend,
  now: () => number = Date.now,
): Promise<StorageStack> {
  const ctx = new Context()
  const fibers: Fiber[] = []
  fibers.push(await ctx.plugin(Storage))
  ctx.storage.backend.register('faultable', backend)
  ctx.provide(storageBackendServiceKey('faultable'), backend)
  fibers.push(await ctx.plugin(StorageDomain, { backend: 'faultable' }))
  return await openOn(ctx, fibers, now)
}
