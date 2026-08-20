#!/usr/bin/env node
/**
 * Explicit one-way migration of pre-M1A workspace FileTeamStore state into
 * the authoritative `agent_swarm` Storage Domain (ADR-0007, M1A).
 *
 * Offline operator tool: it never registers Team tools, never starts the
 * runtime, never dual-writes, and never modifies the legacy source files —
 * they remain rollback evidence next to the durable migration receipts.
 *
 * Usage:
 *   node scripts/migrate-legacy-team-store.mjs \
 *     --state-root <workspace>/.dsh-agent-swarm \
 *     --storage-root <absolute path outside team workspaces> \
 *     [--scope <canonical workspace path, default: parent of --state-root>] \
 *     [--team team-<id>] [--backend json]
 *
 * Requires `pnpm build` first (imports the built plugin entry).
 */

import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import {
  StorageDomainTeamStore,
  TeamId,
  migrateLegacyTeamStore,
  teamDomainSpec,
} from '../lib/index.mjs'

function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`--${name} requires a value`)
  }
  return value
}

const stateRoot = arg('state-root')
const storageRoot = arg('storage-root')
const scopeArg = arg('scope')
const teamArg = arg('team')
const backend = arg('backend') ?? 'json'

if (stateRoot === undefined) throw new Error('--state-root is required (legacy workspace state root, e.g. <workspace>/.dsh-agent-swarm)')
if (storageRoot === undefined) throw new Error('--storage-root is required (Storage backend root, an absolute path OUTSIDE every team workspace)')
if (backend !== 'json') throw new Error(`unsupported backend "${backend}"; this CLI composes the official json KV backend`)

const scope = resolve(scopeArg ?? resolve(stateRoot, '..'))

const ctx = new Context()
const fibers = []
try {
  fibers.push(await ctx.plugin(Storage))
  fibers.push(await ctx.plugin(StorageJson, { root: resolve(storageRoot) }))
  fibers.push(await ctx.plugin(StorageDomain, { backend: 'json' }))
  const domain = await ctx.storageDomain.open(teamDomainSpec)
  const store = new StorageDomainTeamStore(ctx, domain)
  try {
    const report = await migrateLegacyTeamStore({
      store,
      scope,
      stateRoot: resolve(stateRoot),
      ...(teamArg === undefined ? {} : { onlyTeamId: TeamId(teamArg) }),
    })
    console.log(`agent-swarm migration: scope=${report.scope} stateRoot=${report.stateRoot}`)
    for (const outcome of report.outcomes) {
      console.log(`  ${outcome.teamId}: ${outcome.status} (revision ${outcome.revision})`)
    }
    if (report.outcomes.length === 0) console.log('  no legacy teams found under the state root')
    console.log('Legacy source files were not modified; migration receipts are retained in the storage domain.')
  } finally {
    await store.close()
    await domain.close()
  }
} catch (error) {
  console.error(`agent-swarm migration failed: ${error instanceof Error ? error.stack : String(error)}`)
  process.exitCode = 1
} finally {
  for (const fiber of fibers.reverse()) await fiber.dispose()
}
