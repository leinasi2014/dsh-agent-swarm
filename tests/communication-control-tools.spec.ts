import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { expect, it } from 'vitest'
import { mountNodeComposition, setUpTeam, SIGNAL } from './helpers/node-composition.js'
import { TeamId } from '../src/index.js'
import { assertServiceableConfig } from '../src/plugin/config.js'
import { assertSwarmReadRpcValue } from '../src/rpc/read-rpc-artifact.js'

it('uses the real Captain tool/CAS and publishes the canonical effective policy to Host reads', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'communication-tools-'))
  const composition = await mountNodeComposition(sandbox)
  try {
    const { ctx, lead, domain, scope } = composition
    const teamId = TeamId(await setUpTeam(composition, ['alpha', 'beta']))
    const snapshot = async () => (await domain.snapshot(scope, teamId, lead.id)).team
    const tool = (agent: Agent, name: string, args: Record<string, unknown>) => ctx.tools.execute({ agent, name, arguments: args, signal: SIGNAL, callId: ToolCallId(crypto.randomUUID()) })
    const before = await snapshot()
    expect(ctx.agentSwarmHostRead.projectAuthorizedTeam(before, scope).communication)
      .toEqual({ intensity: 'active', source: 'plugin', peerWakeupsPerMinute: 12, windowSeconds: 60 })
    const changed = await tool(lead, 'agent_swarm_set_communication', { expected_revision: before.revision, intensity: 'quiet' })
    expect(changed).toMatchObject({ isError: false, value: { intensity: 'quiet', source: 'team', peer_wakeups_per_minute: 1, window_seconds: 60 } })
    const current = await snapshot()
    const projection = ctx.agentSwarmHostRead.projectAuthorizedTeam(current, scope)
    expect(projection.communication)
      .toEqual({ intensity: 'quiet', source: 'team', peerWakeupsPerMinute: 1, windowSeconds: 60 })
    expect(() => assertSwarmReadRpcValue('snapshot', projection)).not.toThrow()
    expect(() => assertSwarmReadRpcValue('snapshot', { ...projection, communication: { ...projection.communication, intensity: 'unlimited' } })).toThrow()
    const alpha = ctx.agents.get(SessionId(current.members.find(member => member.name === 'alpha')!.sessionId))!
    expect(alpha).toBeDefined()
    const denied = await tool(alpha, 'agent_swarm_set_communication', { expected_revision: current.revision, intensity: 'active' })
    expect(denied).toMatchObject({ isError: true, error: { message: 'tool "agent_swarm_set_communication" is denied by the Team tool policy (fail closed)' } })
    expect(await snapshot()).toEqual(current)
    const first = await tool(alpha, 'agent_swarm_send_message', { target: 'beta', content: 'First coordination', delivery: 'wakeup' })
    expect(first).toMatchObject({ isError: false, value: { delivery: 'wakeup', communication_limited: false } })
    const second = await tool(alpha, 'agent_swarm_send_message', { target: 'beta', content: 'Further coordination', delivery: 'wakeup' })
    expect(second).toMatchObject({ isError: false, value: { delivery: 'quiet', communication_limited: true } })
    expect((await snapshot()).messages).toHaveLength(2)
    const reset = await tool(lead, 'agent_swarm_set_communication', { expected_revision: (await snapshot()).revision, intensity: 'inherit' })
    expect(reset).toMatchObject({ isError: false, value: { intensity: 'active', source: 'plugin' } })
    expect(await snapshot()).not.toHaveProperty('communicationIntensity')
  } finally {
    composition.adapter.open()
    for (const fiber of composition.fibers.toReversed()) await fiber.dispose()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 25_000)

it('rejects invalid plugin intensity before activation while accepting every documented level', () => {
  for (const communicationIntensity of ['quiet', 'balanced', 'active'] as const) expect(() => assertServiceableConfig({ communicationIntensity })).not.toThrow()
  expect(() => assertServiceableConfig({ communicationIntensity: 'unlimited' as 'active' })).toThrow()
})
