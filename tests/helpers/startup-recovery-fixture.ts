import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect } from 'vitest'
import { TeamId } from '../../src/domain/types.js'
import { readPersistedSession } from '../../src/runtime/persisted-session.js'
import { Recording } from './public-chat-real-composition.js'
import { mountRestartComposition as mount, disposeRestartComposition as dispose, restartTool as tool, RESTART_SIGNAL as SIGNAL } from './restart-real-composition.js'

export const ROUTE = { provider: 'exclusion-fixture', model: 'exclusion-model' }
export type SeedTeam = { rootId: SessionId; captainId: SessionId; teamId: TeamId; scope: string }

export async function seed(sandbox: string, prepare?: (ctx: Context, teams: readonly SeedTeam[]) => Promise<void>) {
  const first = await mount(sandbox, 0, undefined, undefined, ctx => { ctx.llm.registerAdapter([ROUTE.provider], new Recording()) })
  const teams: SeedTeam[] = []
  try {
    for (const name of ['excluded', 'other']) {
      const root = (await first.ctx.agents.create({ sessionId: SessionId(`startup-${name}-root`), agentOptions: ROUTE,
        meta: { cwd: join(sandbox, 'workspace') } })).agent
      root.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Prepare existing work.' }] }))
      await root.whenIdle()
      const created = await tool(first.ctx, root, `create-${name}`, 'agent_swarm_create_managed', { name, description: 'Keep the existing pending task.' })
      expect(created.isError, JSON.stringify(created)).toBe(false)
      const ids = created.value as { team_id: string; captain_session_id: string }
      const teamId = TeamId(ids.team_id), captainId = SessionId(ids.captain_session_id), scope = first.ctx.agentSwarm.scopeOf(root)
      await first.ctx.agentSwarm.domain.createTask(scope, teamId, captainId, { subject: 'Pending work', description: 'Resume only when intended.' })
      await first.ctx.agents.get(captainId)?.whenIdle()
      await root.whenIdle()
      teams.push({ rootId: root.id, captainId, teamId, scope })
    }
    await prepare?.(first.ctx, teams)
  } finally { await dispose(first) }
  return teams as [SeedTeam, SeedTeam]
}

export async function storedEvents(ctx: Context, id: SessionId) {
  return (await readPersistedSession(ctx.sessionPersistence, id, SIGNAL)).events
}

export async function queueDebt(ctx: Context, team: SeedTeam, debt: 'work' | 'public' | 'goal') {
  const domain = ctx.agentSwarm.domain
  if (debt === 'work') await domain.submitWorkRequest(team.scope, team.teamId, { kind: 'local-operator' },
    { requestId: 'queued-work', description: 'Keep this real unresolved notice across restart.' })
  if (debt === 'public') await domain.appendPublicMessage(team.scope, team.teamId, {
    formatVersion: 2, author: { kind: 'local-operator' }, requestId: 'queued-public', content: [{ type: 'text', text: 'Keep this undelivered message.' }] })
  if (debt === 'goal') await domain.saveGoal(team.scope, team.teamId, { kind: 'local-operator' }, {
    requestId: 'queued-goal', expectedLifecycleRevision: 0, start: true,
    goal: { text: 'Preserve this goal', acceptanceCriteria: 'Existing debt remains intact', constraints: 'Keep the same trigger', mode: 'finite' } })
}
