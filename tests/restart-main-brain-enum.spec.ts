/**
 * Restart recovery of the read-only Main Brain → dedicated Captain → Team
 * enumeration/binding.
 *
 * Regression for the P0: after a service restart the transient in-memory
 * ownedChildren map is empty, so the Main Brain's Team right column lost the
 * root → Captain edge and showed "多个队长·0" / "Target root has no Team
 * binding" even though the Team and its dedicated Captain really existed in the
 * authoritative aggregate. The fix rebuilds ownedChildren from the OFFICIAL
 * persisted Session headers (parentSession) at runtime start — no second
 * authority, no new persistent state, no Agent Loop change.
 *
 * Two entirely separate Cordis Contexts share one real SQLite Session store and
 * one real Storage Domain root. Context A creates the managed Team (so the
 * Captain Session permanently carries parentSession = Main Brain) and is fully
 * disposed. Context B is the "restart": a fresh runtime (empty ownedChildren)
 * that resumes the same persisted Main Brain Session and must again enumerate
 * the Captain-owned Team read-only.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import type { SwarmHostReadProjectionV1, SwarmHostTeamsProjectionV1 } from '../src/host/host-read-types.js'
import {
  disposeRestartComposition as dispose,
  mountRestartComposition as mount,
  restartTool as tool,
  RESTART_SIGNAL as SIGNAL,
  type RestartMounted as Mounted,
} from './helpers/restart-real-composition.js'

/** Stable Main Brain root Session id across the two Contexts (persisted identity). */
const ROOT = SessionId('restart-enum-main-brain')

/** Plain-stop mock so the dedicated Captain's initial turn settles cleanly. */
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

describe('restart recovery of Main Brain → Captain → Team read-only enumeration/binding', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  it('rebuilds ownedChildren from official Session persistence and restores enumeration/binding', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-team-restart-enum-'))
    roots.push(sandbox)
    let first: Mounted | undefined
    let second: Mounted | undefined
    try {
      // Context A: real Main Brain + dedicated Captain + persisted Team.
      first = await mount(sandbox, 0)
      first.ctx.llm.registerAdapter(['mock'], new PlainStopAdapter())
      const leadA = first.ctx.agentLoop.create(
        ROOT, { provider: 'mock', model: 'mock' }, { cwd: join(sandbox, 'workspace') },
      )
      const created = await tool(first.ctx, leadA, 'restart-enum-create', 'agent_swarm_create_managed', {
        name: 'Restart enum team', description: 'Must be visible again after a restart.',
      })
      expect(created.isError).toBe(false)
      const captainId = (created.value as { captain_session_id: string }).captain_session_id
      expect(captainId).not.toBe(ROOT)

      // Full teardown: the dedicated Captain ends cold; Main Brain + Captain both
      // persist. The next process starts with an EMPTY ownedChildren.
      await dispose(first)
      first = undefined

      // Context B = "service restart" over the same durable SQLite + Storage roots.
      second = await mount(sandbox, 50)
      second.ctx.llm.registerAdapter(['mock'], new PlainStopAdapter())
      // The durable parent link lives on the official persisted Session header: the
      // single canonical source the fix rebuilds ownedChildren from after restart.
      const persisted = await second.ctx.sessionPersistence.inspect(SessionId(captainId), SIGNAL)
      expect(persisted.meta.parentSession).toBe(ROOT)
      const resumed = await second.ctx.agents.resume({ resumeSessionId: ROOT })
      const leadB = resumed.agent
      expect(second.ctx.agents.get(ROOT)).toBe(leadB)

      // The fresh runtime rebuilt the transient root→Captain edge from the official
      // persisted Session headers (parentSession) at start. Without the fix this is
      // [] and every read-only enumeration/binding below is empty / NOT_FOUND.
      expect(second.ctx.agentSwarm.managedCaptainSessionsOf(ROOT)).toContain(captainId)

      // R1 enumeration (what feeds the Team right column): the Main Brain is
      // 'main-brain' and can enumerate its Captain-owned Team (was "多个队长·0").
      const scope = second.ctx.agentSwarm.scopeOf(leadB)
      const enumerated = await second.ctx.agents.withInitiator(leadB, () =>
        second!.ctx.agentSwarmHostRead.listTeams(scope)) as SwarmHostTeamsProjectionV1
      expect(enumerated.binding.rootKind).toBe('main-brain')
      expect(enumerated.teams.map(team => team.captainSessionId)).toContain(captainId)

      // R1 binding read: resolves the unique Captain-owned Team instead of failing
      // with SWARM_HOST_BINDING_NOT_FOUND ("Target root has no Team binding").
      const binding = await second.ctx.agents.withInitiator(leadB, () =>
        second!.ctx.agentSwarmHostRead.read({})) as SwarmHostReadProjectionV1
      expect(binding.team.phase).toBe('active')
      expect(binding.binding.rootSessionId).toBe(captainId)
    } finally {
      if (second !== undefined) await dispose(second).catch(() => undefined)
      if (first !== undefined) await dispose(first).catch(() => undefined)
    }
  })
})
