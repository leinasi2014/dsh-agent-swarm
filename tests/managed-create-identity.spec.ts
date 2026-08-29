/**
 * Persisted managed-origin reload (target 3 of this feature).
 *
 * The managed `agent_swarm_create_managed` durable key must be
 * MainBrainSessionId + turn (see managed-create-turn-identity.spec.ts for the
 * real turn-scoped assertions). This file covers the RELOAD dimension: after a
 * real store/Session reload the Main Brain re-discovers its persisted managed
 * Team (managed origin durable), and a second logical operation yields an
 * independent Team rather than reusing the whole-workspace singleton.
 *
 * Two entirely separate Cordis Contexts share one real SQLite Session store and
 * one real Storage Domain root. Context A creates the managed Team and is fully
 * disposed. Context B is the "restart": a fresh runtime that resumes the same
 * persisted Main Brain Session.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import {
  disposeRestartComposition as disposeRestart,
  mountRestartComposition as mountRestart,
  restartTool,
  type RestartMounted,
} from './helpers/restart-real-composition.js'

interface ManagedCreated { readonly team_id: string; readonly captain_session_id: string }

function asCreated(value: unknown): ManagedCreated {
  return value as unknown as ManagedCreated
}

/** Plain-stop mock so provisioning Creates do not block on a held LLM gate. */
class PlainStopAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Captain online.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Captain online.' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
    return
  }
}

describe('persisted managed origin survives a store/Session reload', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  it('reloads: the same Main Brain reuses the persisted Team; a second logical operation is independent', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-managed-identity-reload-'))
    roots.push(sandbox)
    let first: RestartMounted | undefined
    let second: RestartMounted | undefined
    const ROOT = SessionId('managed-identity-reload-root')
    try {
      first = await mountRestart(sandbox, 0)
      first.ctx.llm.registerAdapter(['mock'], new PlainStopAdapter())
      const leadA = first.ctx.agentLoop.create(
        ROOT, { provider: 'mock', model: 'mock' }, { cwd: join(sandbox, 'workspace') },
      )
      const createdA = await restartTool(first.ctx, leadA, 'op-reload-X', 'agent_swarm_create_managed', {
        name: 'Reload Team', description: 'Persisted managed origin.',
      })
      expect(createdA.isError).toBe(false)
      const createdValueA = asCreated(createdA.value)
      const firstTeamId = createdValueA.team_id
      const firstCaptainId = createdValueA.captain_session_id
      expect(firstCaptainId).not.toBe(ROOT)

      await disposeRestart(first)
      first = undefined

      // Context B = service restart over the same durable SQLite + Storage roots.
      second = await mountRestart(sandbox, 50)
      second.ctx.llm.registerAdapter(['mock'], new PlainStopAdapter())
      const resumed = await second.ctx.agents.resume({ resumeSessionId: ROOT })
      const leadB = resumed.agent

      // (1) The persisted managed Team is re-discovered after reload: the same
      // Main Brain / operation reuses it rather than duplicating the Captain.
      const createdB = await restartTool(second.ctx, leadB, 'op-reload-X', 'agent_swarm_create_managed', {
        name: 'Reload Team', description: 'Persisted managed origin.',
      })
      expect(createdB.isError).toBe(false)
      const createdValueB = asCreated(createdB.value)
      expect(createdValueB.team_id).toBe(firstTeamId)
      expect(createdValueB.captain_session_id).toBe(firstCaptainId)

      // (2) A genuinely distinct logical operation after reload must provision
      // an INDEPENDENT Team (origin is per-operation, not a whole-workspace
      // singleton). RED against the current "reuse the first active Team".
      const createdC = await restartTool(second.ctx, leadB, 'op-reload-Y', 'agent_swarm_create_managed', {
        name: 'Reload Team Y', description: 'A different operation after reload.',
      })
      expect(createdC.isError).toBe(false)
      const createdValueC = asCreated(createdC.value)
      expect(createdValueC.team_id).not.toBe(firstTeamId)
      expect(createdValueC.captain_session_id).not.toBe(firstCaptainId)

      const scope = second.ctx.agentSwarm.scopeOf(leadB)
      const aggregates = await second.ctx.agentSwarm.listTeamAggregates(scope)
      const active = aggregates.filter(team => team.phase === 'active')
      expect(active).toHaveLength(2)
    } finally {
      if (second !== undefined) await disposeRestart(second).catch(() => undefined)
      if (first !== undefined) await disposeRestart(first).catch(() => undefined)
    }
  })
})
