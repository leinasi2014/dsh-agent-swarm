/**
 * Startup-rollback of the sibling member-private-memory service (2026-08-26).
 *
 * When the human-interaction assembly of `apply` fails (here: a pre-seeded
 * `agentSwarmHumanControl` provide conflict makes the human-domain `ctx.provide`
 * throw), the `closePrivateMemory` branch must release the sibling service and its
 * `agent_swarm_member_private_memory` domain in the correct reverse order — the
 * provided `ctx.agentSwarmPrivateMemory` is unprovided and the domain name is freed
 * so a fresh open succeeds. Otherwise the sibling leak would surface only under this
 * apply-failure path (docs/04 §8p).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { afterEach, describe, expect, it } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import { mountStorageStackOn } from './helpers/storage-stack.js'

class PassiveAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async * stream(): AsyncIterable<StreamChunk> {
    const text = 'Acknowledged.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('member private memory startup rollback', () => {
  const roots: string[] = []
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  it('releases the sibling private-memory service and domain on a human-assembly apply failure', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-private-memory-rollback-'))
    roots.push(sandbox)
    const ctx = new Context()
    const fibers: Fiber[] = []
    await mountAgentLoopTestDependencies(ctx)
    fibers.push(await ctx.plugin(SqliteSessionPersistence, { path: join(sandbox, 'sessions', 'sessions.db') }))
    await mountStorageStackOn(ctx, join(sandbox, 'storage'))
    fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
    fibers.push(await ctx.plugin(SubagentService))
    fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
    ctx.llm.registerAdapter(['mock'], new PassiveAdapter())
    const conflictDisposer = ctx.reflect.provide('agentSwarmHumanControl', {})
    try {
      // The plugin opens the private-memory domain + service first, then reaches
      // the human-assembly provide that now conflicts; `apply` must reject and the
      // human catch must run `closePrivateMemory`.
      await expect(ctx.plugin(AgentSwarm, { memberProvider: 'spawn', memberMaxDepth: 1 })).rejects.toThrow()
      expect(ctx.get('agentSwarmPrivateMemory')).toBeUndefined()
      const reopened = await ctx.storageDomain.open(AgentSwarm.privateMemoryDomainSpec)
      expect(reopened).toBeDefined()
      await reopened.close()
    } finally {
      await conflictDisposer()
      for (const fiber of fibers.toReversed()) await fiber.dispose()
    }
  }, 45_000)
})
