/** Real Team Domain + SchedulingPass + MessageDelivery. Only the official
 * transport seam is controlled: accepted frames are appended to real Sessions,
 * so this proves recovery ordering and receipt folding, not model behavior. */
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

it('dispatches later automatic work before old open mail, retaining the same notice through busy and budget recovery', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-open-recovery-'))
  const composition = await mount(sandbox, 0)
  const { ctx, lead, scope } = composition
  const teamId = TeamId(composition.teamId)
  const domain = ctx.agentSwarm.domain
  const dispatches: { kind: 'assignment' | 'open'; text: string }[] = []
  let transport: { mockRestore(): void } | undefined
  try {
    const worker = await ctx.agentLoop.create(SessionId(`open-worker-${Date.now()}`), { provider: 'mock', model: 'mock' }, { cwd: scope })
    await domain.provisionMember(scope, teamId, lead.id, { name: 'worker', role: 'worker', sessionId: worker.id, provider: 'spawn' })
    await domain.settleMember(scope, teamId, worker.id, { active: true })
    const open = await domain.createTask(scope, teamId, lead.id, { subject: 'Older open work', description: 'Self claim only.', assignmentMode: 'open-claim' })
    const notice = await domain.noticeOpenClaimTask(scope, teamId, lead.id, { taskId: open.id, expectedTaskRevision: open.revision, recipientSessionIds: [worker.id] })
    const noticeId = notice.messageIds[0]!
    const automatic = await domain.createTask(scope, teamId, lead.id, { subject: 'Later automatic work', description: 'Must go first.', targetMemberSessionId: worker.id })
    const provider = { select: vi.fn(priorityReadyScheduler().select) }
    transport = vi.spyOn(ctx.subagents as unknown as HostPromptDeliverer, deliverSubagentPrompt).mockImplementation(async (_parent, child, content) => {
      expect(child).toBe(worker.id)
      const text = content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      const kind = text.includes(noticeId) ? 'open' : 'assignment'
      dispatches.push({ kind, text })
      if (kind === 'assignment') {
        expect(text).toContain(automatic.id)
        expect((await snapshotOf(composition)).team.tasks.find(task => task.id === automatic.id)?.status).toBe('in_progress')
      }
      worker.session.append('user/message', createUserMessage({ content, source: { kind: 'plugin', plugin: 'dsh-agent-swarm' } }), { surfaceOp: 'append' })
      await ctx.sessions.flush(worker.session)
      return 'controlled-accepted-frame' as never
    })
    const buildPass = () => {
      const delivery = new MessageDelivery(ctx, { domain: () => domain, isClosing: () => false,
        scopeOf: () => scope, accountAgentUsage: async () => {} })
      return new SchedulingPass(ctx, { domain: () => domain, delivery: () => delivery,
        usage: () => ({ accountAgentUsage: async () => {} }) as never,
        schedulerProvider: () => 'priority-ready', schedulerProviders: () => new Map([['priority-ready', provider]]),
        duringProvider: async (_scope, _teamId, operation) => await operation(),
        strandedAfterMs: 0, idleSince: () => undefined, eventFaceActive: () => true, isClosing: () => false,
        trackTeamChildren: () => {}, requestSchedule: () => {}, executionRoots: () => ({}) as never,
        executionRootsEnabled: () => false, sweepExecutionRoots: async () => {} })
    }
    await buildPass().run(scope, teamId, lead)
    expect(provider.select.mock.calls[0]![0].readyTasks.map(task => task.id)).toEqual([automatic.id])
    let state = (await snapshotOf(composition)).team
    const assigned = state.tasks.find(task => task.id === automatic.id)!
    expect(assigned.status, JSON.stringify(state.attempts)).toBe('in_progress')
    expect(dispatches.map(item => item.kind)).toEqual(['assignment'])
    expect(assigned.ownerSessionId).toBe(worker.id)
    expect(state.messages.find(message => message.id === noticeId)?.phase).toBe('queued')
    expect(state.tasks.find(task => task.id === open.id)?.openClaimNotice?.recipientSessionIds).toEqual([worker.id])
    await buildPass().run(scope, teamId, lead)
    expect(dispatches).toHaveLength(1)

    const submitted = await domain.submitTask(scope, teamId, worker.id, assigned.id, assigned.revision, assigned.currentAttemptId!, 'done', [])
    await domain.reviewTask(scope, teamId, lead.id, assigned.id, submitted.revision, assigned.currentAttemptId!, 'accept')
    state = (await snapshotOf(composition)).team
    await domain.setBudget(scope, teamId, lead.id, { requestLimit: state.budget.usedRequests })
    await buildPass().run(scope, teamId, lead)
    expect(dispatches).toHaveLength(1)
    expect((await snapshotOf(composition)).team.messages.find(message => message.id === noticeId)?.phase).toBe('queued')

    await domain.setBudget(scope, teamId, lead.id, { requestLimit: state.budget.usedRequests + 1 })
    await buildPass().run(scope, teamId, lead)
    expect(dispatches.map(item => item.kind)).toEqual(['assignment', 'open'])
    expect(dispatches[1]!.text).toContain(noticeId)
    await buildPass().run(scope, teamId, lead)
    state = (await snapshotOf(composition)).team
    expect(state.messages.filter(message => message.kind === 'open-claim-notice')).toHaveLength(1)
    expect(state.messages.find(message => message.id === noticeId)?.phase).toBe('delivered')
    expect(state.tasks.find(task => task.id === open.id)).toMatchObject({ status: 'pending', revision: 1 })
    expect(state.attempts.filter(attempt => attempt.taskId === open.id)).toHaveLength(0)
    expect(dispatches).toHaveLength(2)
  } finally {
    transport?.mockRestore()
    composition.adapter.open()
    for (const fiber of composition.fibers.toReversed()) await fiber.dispose()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
