/** Runtime pause boundary over real Domain, Session and mailbox persistence.
 * The paused projection is controlled so this tests scheduling independently
 * of the Domain's separate new-attempt admission guard. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { deliverSubagentPrompt, type HostPromptDeliverer } from '@deepseek-ai/dsh-subagent/internal'
import { expect, it, vi } from 'vitest'
import { TeamId } from '../src/domain/types.js'
import { MessageDelivery } from '../src/runtime/message-delivery.js'
import { priorityReadyScheduler } from '../src/runtime/providers.js'
import { SchedulingPass } from '../src/runtime/scheduling.js'
import { mount, snapshotOf } from './helpers/gated-composition.js'

it.each(['automatic', 'open invitation'] as const)('pauses new %s work while delivering and finishing a previously reserved attempt', async kind => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-goal-pause-'))
  const composition = await mount(sandbox, 0)
  const { ctx, lead, scope } = composition, teamId = TeamId(composition.teamId), domain = ctx.agentSwarm.domain
  const workers = await Promise.all(['alpha', 'beta'].map(async name => {
    const worker = await ctx.agentLoop.create(SessionId(`pause-${name}-${Date.now()}`), { provider: 'mock', model: 'mock' }, { cwd: scope })
    await domain.provisionMember(scope, teamId, lead.id, { name, role: name, sessionId: worker.id, provider: 'spawn' })
    await domain.settleMember(scope, teamId, worker.id, { active: true })
    return worker
  }))
  const [alpha, beta] = workers
  const delivered: string[] = []
  const transport = vi.spyOn(ctx.subagents as unknown as HostPromptDeliverer, deliverSubagentPrompt).mockImplementation(async (_parent, child, content) => {
    const worker = workers.find(candidate => candidate.id === child)!
    delivered.push(content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'))
    worker.session.append('user/message', createUserMessage({ content, source: { kind: 'plugin', plugin: 'dsh-agent-swarm' } }), { surfaceOp: 'append' })
    await ctx.sessions.flush(worker.session)
    return 'pause-controlled-claim' as never
  })
  let projection: { mockRestore(): void } | undefined
  let paused = true
  try {
    const old = await domain.createTask(scope, teamId, lead.id, { subject: 'Existing reserved work', description: 'This attempt remains valid.' })
    const claim = await domain.claimTask(scope, teamId, lead.id, old.id, old.revision, alpha!.id)
    const next = await domain.createTask(scope, teamId, lead.id, { subject: 'Waiting new work', description: 'Wait until resume.',
      ...(kind === 'automatic' ? { targetMemberSessionId: beta!.id } : { assignmentMode: 'open-claim' as const }) })
    const notice = kind === 'open invitation' ? await domain.noticeOpenClaimTask(scope, teamId, lead.id,
      { taskId: next.id, expectedTaskRevision: next.revision, recipientSessionIds: [beta!.id] }) : undefined
    const read = domain.snapshot.bind(domain)
    projection = vi.spyOn(domain, 'snapshot').mockImplementation(async (...args) => {
      const value = await read(...args)
      return paused ? { ...value, team: { ...value.team, goalLifecycle: { schemaVersion: 1, phase: 'paused' } } } as typeof value : value
    })
    const provider = { select: vi.fn(priorityReadyScheduler().select) }
    const delivery = new MessageDelivery(ctx, { domain: () => domain, isClosing: () => false,
      scopeOf: () => scope, accountAgentUsage: async () => {} })
    const pass = new SchedulingPass(ctx, { domain: () => domain, delivery: () => delivery,
      usage: () => ({ accountAgentUsage: async () => {} }) as never,
      schedulerProvider: () => 'priority-ready', schedulerProviders: () => new Map([['priority-ready', provider]]),
      duringProvider: async (_scope, _teamId, operation) => await operation(),
      strandedAfterMs: 0, idleSince: () => undefined, eventFaceActive: () => true, isClosing: () => false,
      trackTeamChildren: () => {}, requestSchedule: () => {}, executionRoots: () => ({}) as never,
      executionRootsEnabled: () => false, sweepExecutionRoots: async () => {} })
    await pass.run(scope, teamId, lead)
    let team = (await snapshotOf(composition)).team
    expect(team.attempts.find(attempt => attempt.id === claim.attempt.id)?.assignmentPhase).toBe('delivered')
    expect(team.tasks.find(task => task.id === next.id)?.status).toBe('pending')
    expect(team.attempts).toHaveLength(1)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toContain(claim.attempt.id)
    expect(provider.select).not.toHaveBeenCalled()
    if (notice !== undefined) expect(team.messages.find(message => message.id === notice.messageIds[0])?.phase).toBe('queued')
    // Existing execution can submit and be accepted while new work is paused.
    const current = team.tasks.find(task => task.id === old.id)!
    const submitted = await domain.submitTask(scope, teamId, alpha!.id, current.id, current.revision, claim.attempt.id, 'Preserved old result', ['fixture://pause'])
    await domain.reviewTask(scope, teamId, lead.id, old.id, submitted.revision, claim.attempt.id, 'accept')
    paused = false
    await pass.run(scope, teamId, lead)
    team = (await snapshotOf(composition)).team
    expect(team.tasks.find(task => task.id === old.id)?.status).toBe('completed')
    if (notice !== undefined) expect(team.messages.find(message => message.id === notice.messageIds[0])?.phase).toBe('delivered')
    else expect(team.tasks.find(task => task.id === next.id)?.status).toBe('in_progress')
    expect(delivered.length).toBeGreaterThan(1)
  } finally {
    projection?.mockRestore(); transport.mockRestore(); composition.adapter.open()
    for (const fiber of composition.fibers.toReversed()) await fiber.dispose()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
