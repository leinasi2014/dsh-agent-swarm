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
 * Mount the real storage composition (hub + json KV backend + domain form)
 * onto an existing Context, for specs that compose it with further official
 * services (persistence, agents, subagents) on one graph. Disposal stays the
 * caller's responsibility.
 */
export async function mountStorageStackOn(ctx: Context, root: string): Promise<void> {
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
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
  /**
   * Opt-in reproduction of issue #193 (transient EPERM on agent_swarm.json).
   * When set to a unit name, that unit's record-write path models the
   * storage-json atomic-rename publish: the first write holds the unit
   * "in flight" across a real async gap, and any SECOND write to the SAME unit
   * that arrives before the first settles is rejected once with code `EPERM` —
   * exactly the overlapping rename() contention a whole-file replacement hits.
   * Deterministic (no reliance on the OS throwing EPERM by luck); unset by
   * default so the existing single-store fault tests are untouched.
   */
  contendUnitName: string | undefined = undefined
  private readonly inFlightWrites = new Map<string, number>()

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
            await this.contended(descriptor.name, async () => {
              let records = tables.get(table)
              if (records === undefined) {
                records = new Map()
                tables.set(table, records)
              }
              records.set(key, this.mutateOnPut === undefined ? value : this.mutateOnPut(table, key, value))
            })
          },
          deleteRecord: async (table, key) => {
            if (this.failNextWrites > 0) {
              this.failNextWrites -= 1
              throw new Error('injected write failure')
            }
            await this.contended(descriptor.name, async () => {
              tables.get(table)?.delete(key)
            })
          },
          setGlobal: async value => {
            if (this.failNextWrites > 0) {
              this.failNextWrites -= 1
              throw new Error('injected write failure')
            }
            await this.contended(descriptor.name, async () => {
              unit.global = value
            })
          },
          close: async () => {},
        }
      },
    }
  }

  async close(): Promise<void> {}

  /**
   * Unit-level write serialization-or-reject for the armed contention unit.
   * When `contendUnitName` matches, the first write is held across a real
   * async gap and a concurrent write to the SAME unit that arrives during that
   * gap is rejected once with a coded `EPERM`; when contention is not armed the
   * write passes straight through unchanged. The shared `inFlightWrites`
   * counter lives on this shared backend, so two independently-opened domain
   * handles over one medium observe each other's in-flight unit writes.
   */
  private async contended<T>(unitName: string, write: () => Promise<T>): Promise<T> {
    if (this.contendUnitName !== unitName) return await write()
    const inFlight = this.inFlightWrites.get(unitName) ?? 0
    if (inFlight > 0) {
      throw Object.assign(new Error(`injected rename contention on ${unitName}`), { code: 'EPERM' })
    }
    this.inFlightWrites.set(unitName, inFlight + 1)
    try {
      // A real async gap: microtasks (the concurrent second writer's job) run
      // before this timer callback, so the second write observes the in-flight
      // mark and this unit write cannot be mistaken for already-settled.
      await new Promise(resolve => setTimeout(resolve, 0))
      return await write()
    } finally {
      const remaining = (this.inFlightWrites.get(unitName) ?? 1) - 1
      if (remaining <= 0) this.inFlightWrites.delete(unitName)
      else this.inFlightWrites.set(unitName, remaining)
    }
  }
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
