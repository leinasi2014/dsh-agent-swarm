/** Public tools retry a bounded stale read, preserving the Domain CAS and request identity. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { withLiveChild } from '../src/runtime/continuable-child.js'
import { Recording, setup, createTeam } from './helpers/public-chat-real-composition.js'
import { RESTART_SIGNAL as SIGNAL, restartTool } from './helpers/restart-real-composition.js'

it.each([1, 3, 'archive'] as const)('keeps original public identity across %s concurrent Team commits', async collisions => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-public-contention-'))
  const f = await setup(sandbox, new Recording())
  try {
    const { root, captain, teamId, scope } = await createTeam(f, sandbox)
    const domain = f.ctx.agentSwarm.domain, append = domain.appendPublicMessage.bind(domain)
    let attempts = 0
    const identities: unknown[] = []
    domain.appendPublicMessage = async (currentScope, currentTeam, input) => {
      attempts++
      identities.push({ currentScope, currentTeam, requestId: input.requestId, author: input.author,
        captain: input.expectedCaptainSessionId, content: 'content' in input ? input.content : input.text })
      if (collisions === 'archive') await domain.archiveTeam(scope, teamId, captain.id, 'withdraw append authority')
      else if (attempts <= collisions) {
        const current = (await domain.snapshot(scope, teamId, captain.id)).team
        await domain.setCaptainProfile(scope, teamId, captain.id, current.revision, { displayName: `competing commit ${attempts}` })
      }
      return await append(currentScope, currentTeam, input)
    }
    try {
      const result = await withLiveChild(f.ctx, root, captain.id, SIGNAL,
        async child => await restartTool(f.ctx, child, 'one-public-model-call', 'agent_swarm_public_post', { request_id: 'stable-public-id', text: 'Public progress.' }))
      expect(attempts).toBe(collisions === 'archive' ? 1 : collisions === 1 ? 2 : 3)
      for (const identity of identities) expect(identity).toEqual(identities[0])
      const after = (await f.ctx.agentSwarm.listTeamAggregates(scope)).find(team => team.id === teamId)!
      if (collisions === 1) {
        expect(result.isError, JSON.stringify(result)).toBe(false)
        expect(after.publicChat!.messages).toHaveLength(1)
        expect(after.publicChat!.messages[0]).toMatchObject({ requestId: 'stable-public-id', text: 'Public progress.', author: { sessionId: captain.id } })
      } else {
        expect(result.isError).toBe(true)
        expect(JSON.stringify(result)).toContain(collisions === 'archive' ? 'TEAM_ARCHIVED' : 'TEAM_REVISION_CONFLICT')
        expect(after.publicChat?.messages ?? []).toEqual([])
      }
    } finally { domain.appendPublicMessage = append }
  } finally { await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 15_000)
