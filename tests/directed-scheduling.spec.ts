import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import { priorityReadyScheduler, type TeamSchedulerProvider } from '../src/runtime/providers.js'
import { SchedulingPass } from '../src/runtime/scheduling.js'
import { mount, snapshotOf, type Composition } from './helpers/gated-composition.js'

describe('directed-member scheduling', () => {
  const roots: string[] = []
  afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))) })

  it('holds a busy target without fallback, gives generic work to the idle member, then assigns the target exactly once', async () => {
    const composition = await compositionAt(roots, 'directed-scheduling-')
    try {
      const live = new Map<string, { status: 'idle' | 'running' }>([['alpha', { status: 'running' }], ['beta', { status: 'idle' }]])
      const fixture = await activeFixture(composition, false)
      const followups: string[] = []
      const pass = schedulingPass(composition, priorityReadyScheduler(), live, followups)
      const domain = composition.ctx.agentSwarm.domain
      const directed = await domain.createTask(composition.scope, AgentSwarm.TeamId(composition.teamId), composition.lead.id, { subject: 'Only alpha', description: 'No fallback.', targetMemberSessionId: fixture.alphaId })
      const generic = await domain.createTask(composition.scope, AgentSwarm.TeamId(composition.teamId), composition.lead.id, { subject: 'Generic beta', description: 'Idle member may work.' })

      await pass.run(composition.scope, AgentSwarm.TeamId(composition.teamId), composition.lead)
      const first = await snapshotOf(composition)
      expect(first.team.tasks.find(task => task.id === directed.id)).toMatchObject({ status: 'pending', targetMemberSessionId: fixture.alphaId })
      expect(first.team.attempts.filter(attempt => attempt.taskId === directed.id)).toHaveLength(0)
      const genericTask = first.team.tasks.find(task => task.id === generic.id)!
      expect(genericTask).toMatchObject({ status: 'in_progress', ownerSessionId: fixture.betaId })
      expect(followups).toHaveLength(1)

      await domain.acknowledgeAssignment(composition.scope, AgentSwarm.TeamId(composition.teamId), genericTask.id, genericTask.currentAttemptId!)
      live.set('alpha', { status: 'idle' })
      await pass.run(composition.scope, AgentSwarm.TeamId(composition.teamId), composition.lead)
      const second = await snapshotOf(composition)
      expect(second.team.tasks.find(task => task.id === directed.id)).toMatchObject({ status: 'in_progress', ownerSessionId: fixture.alphaId })
      expect(second.team.attempts.filter(attempt => attempt.taskId === directed.id)).toEqual([expect.objectContaining({ memberSessionId: fixture.alphaId })])
      expect(followups).toHaveLength(2)
    } finally { await dispose(composition) }
  })

  it.each([
    ['a generic task preempting a ready directed task', ({ genericId, alphaId }: Fixture) => ({ taskId: genericId, memberSessionId: alphaId })],
    ['a directed task sent to the wrong member', ({ directedId, betaId }: Fixture) => ({ taskId: directedId, memberSessionId: betaId })],
  ])('rejects %s without mutation or dispatch', async (_caseName, decide) => {
    const composition = await compositionAt(roots, 'directed-invalid-')
    try {
      const live = new Map<string, { status: 'idle' | 'running' }>([['alpha', { status: 'idle' }], ['beta', { status: 'idle' }]])
      const data = await activeFixture(composition)
      const followups: string[] = []
      const before = await snapshotOf(composition)
      await expect(schedulingPass(composition, { select: () => [decide(data)] }, live, followups).run(composition.scope, AgentSwarm.TeamId(composition.teamId), composition.lead)).rejects.toMatchObject({ code: 'TEAM_SCHEDULER_DECISION_INVALID' })
      expect(await snapshotOf(composition)).toEqual(before)
      expect(followups).toHaveLength(0)
    } finally { await dispose(composition) }
  })
})

interface Fixture { readonly alphaId: string; readonly betaId: string; readonly directedId: string; readonly genericId: string }
async function compositionAt(roots: string[], prefix: string): Promise<Composition> { const sandbox = await mkdtemp(join(tmpdir(), `dsh-agent-swarm-${prefix}`)); roots.push(sandbox); return await mount(sandbox, 60_000) }
async function activeFixture(composition: Composition, seedTasks = true): Promise<Fixture> {
  const domain = composition.ctx.agentSwarm.domain, teamId = AgentSwarm.TeamId(composition.teamId)
  for (const [name, sessionId] of [['alpha', 'alpha'], ['beta', 'beta']] as const) { await domain.provisionMember(composition.scope, teamId, composition.lead.id, { name, role: name, sessionId, provider: 'spawn' }); await domain.settleMember(composition.scope, teamId, sessionId, { active: true }) }
  if (!seedTasks) return { alphaId: 'alpha', betaId: 'beta', directedId: '', genericId: '' }
  const directed = await domain.createTask(composition.scope, teamId, composition.lead.id, { subject: 'Directed alpha', description: 'Alpha only.', targetMemberSessionId: 'alpha' })
  const generic = await domain.createTask(composition.scope, teamId, composition.lead.id, { subject: 'Generic', description: 'Either member.' })
  return { alphaId: 'alpha', betaId: 'beta', directedId: directed.id, genericId: generic.id }
}
function schedulingPass(composition: Composition, provider: TeamSchedulerProvider, live: Map<string, { status: 'idle' | 'running' }>, followups: string[]): SchedulingPass {
  vi.spyOn(composition.ctx.agents, 'get').mockImplementation(sessionId => live.get(String(sessionId)) as never)
  vi.spyOn(composition.ctx.subagents, 'followup').mockImplementation(async (_parent, childId, content) => { followups.push(content.filter(block => block.type === 'text').map(block => block.text).join('\n')); live.delete(String(childId)); return 'mock-followup' as never })
  return new SchedulingPass(composition.ctx, { domain: () => composition.ctx.agentSwarm.domain, delivery: () => ({}) as never, usage: () => ({}) as never, schedulerProvider: () => 'test-provider', schedulerProviders: () => new Map([['test-provider', provider]]), strandedAfterMs: 0, idleSince: () => undefined, eventFaceActive: () => true, isClosing: () => false, trackTeamChildren: () => {}, requestSchedule: () => {}, executionRoots: () => ({}) as never, executionRootsEnabled: () => false, sweepExecutionRoots: async () => {} })
}
async function dispose(composition: Composition): Promise<void> { composition.adapter.open(); for (const fiber of composition.fibers.toReversed()) await fiber.dispose() }
