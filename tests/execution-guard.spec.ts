import { readPersistedSession } from '../src/runtime/persisted-session.js'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { GuardAdapter, doneChunks, mountGuard, prompt, toolChunks } from './helpers/execution-guard.js'

describe('execution guard over the official Agent Loop', () => {
  it('warns on exact unknown-tool failures and cancels only this turn with queued input intact', async () => {
    const adapter = new GuardAdapter(async function* (_options, index) {
      if (index <= 40) yield* toolChunks(index, 'guard_missing')
      else yield* doneChunks()
    })
    const stack = await mountGuard(adapter)
    try {
      const task = await stack.execute('agent_swarm_create_task', { subject: 'Keep ownership', description: 'Existing running attempt survives guard.' })
      expect(task.isError).toBe(false)
      if (task.isError) throw new Error('task setup failed')
      const taskValue = task.value as { task_id: string; revision: number }
      expect((await stack.execute('agent_swarm_claim_task', { task_id: taskValue.task_id, expected_revision: taskValue.revision })).isError).toBe(false)
      const before = await stack.ctx.agentSwarm.status({ agent: stack.agent, signal: new AbortController().signal })
      expect(before.team.attempts).toHaveLength(1)
      // Claiming reserves delivery; establish its real domain acknowledgement
      // before measuring interrupt preservation, otherwise the idle scheduler
      // correctly rolls back an undelivered reservation.
      await stack.ctx.agentSwarm.domain.acknowledgeAssignment(stack.ctx.agentSwarm.scopeOf(stack.agent), before.team.id, before.team.tasks[0]!.id, before.team.attempts[0]!.id)
      const admitted = await stack.ctx.agentSwarm.status({ agent: stack.agent, signal: new AbortController().signal })
      const queued = prompt('Preserve this queued input.')
      const off = stack.ctx.on('tools/result', execution => {
        if (execution.callId === 'guard-call-9') stack.agent.send(queued, 'next-turn', false)
        return undefined
      })
      stack.agent.followup(prompt())
      await stack.agent.whenIdle()
      off()
      const end = stack.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
      expect(end?.data.reason).toMatchObject({ kind: 'aborted', reason: { kind: 'hook', reason: expect.stringContaining('unknown-tool') } })
      expect(adapter.requests.length).toBe(10)
      expect(stack.agent.inbox.nextTurn.map(message => message.id)).toContain(queued.id)
      expect(adapter.requests[5]?.messages.some(message => JSON.stringify(message).includes('Execution guard WARNING'))).toBe(true)
      await stack.ctx.sessions.flush(stack.agent.session)
      const stored = await readPersistedSession(stack.ctx.sessionPersistence, stack.agent.id, new AbortController().signal)
      expect(stored.events.filter(event => event.type === 'user/message' && JSON.stringify(event.data).includes('Execution guard WARNING'))).toHaveLength(1)
      const after = await stack.ctx.agentSwarm.status({ agent: stack.agent, signal: new AbortController().signal })
      expect(after.team.tasks).toEqual(admitted.team.tasks)
      expect(after.team.attempts).toEqual(admitted.team.attempts)
    } finally { await stack.dispose() }
  })
})

describe('three classes of tool progress', () => {
  it('counts structured failures across distinct requests', async () => {
    const adapter = new GuardAdapter(async function* (_options, index) {
      if (index <= 40) yield* toolChunks(index, 'guard_failure', { index })
      else yield* doneChunks()
    })
    const stack = await mountGuard(adapter)
    try {
      stack.ctx.tools.register(defineTool({ name: 'guard_failure', description: 'Real structured failure.', parameters: { index: { type: 'integer' } },
        output: { schema: { type: 'boolean' }, render: () => [] },
        execute: async () => { throw new HarnessError('private failure payload', 'GUARD_TEST_FAILURE') },
      }))
      stack.agent.followup(prompt())
      await stack.agent.whenIdle()
      expect(adapter.requests).toHaveLength(30)
      expect(stack.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason)
        .toMatchObject({ kind: 'aborted', reason: { reason: expect.stringContaining('global') } })
      expect(adapter.requests[20]?.messages.some(message => JSON.stringify(message).includes('Execution guard WARNING'))).toBe(true)
    } finally { await stack.dispose() }
  })

  it('contains repeated successful memory reads but allows new cursors with identical results', async () => {
    for (const changing of [false, true]) {
      const adapter = new GuardAdapter(async function* (_options, index) {
        if (index <= 40) yield* toolChunks(index, 'agent_swarm_list_memory', changing ? { cursor: index } : {})
        else yield* doneChunks()
      })
      const stack = await mountGuard(adapter)
      try {
        stack.agent.followup(prompt())
        await stack.agent.whenIdle()
        expect(adapter.requests).toHaveLength(changing ? 41 : 31)
        expect(stack.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe(changing ? 'completed' : 'aborted')
      } finally { await stack.dispose() }
    }
  })

  it('treats changed results of the same memory request as progress', async () => {
    let update!: (index: number) => Promise<void>
    const adapter = new GuardAdapter(async function* (_options, index) {
      if (index <= 40) { await update(index); yield* toolChunks(index, 'agent_swarm_list_memory') }
      else yield* doneChunks()
    })
    const stack = await mountGuard(adapter)
    update = async index => {
      const result = await stack.execute('agent_swarm_add_memory', { category: 'lesson', content: `New durable fact ${index}`, evidence_refs: [] })
      expect(result.isError).toBe(false)
    }
    try {
      stack.agent.followup(prompt()); await stack.agent.whenIdle()
      expect(adapter.requests).toHaveLength(41)
      expect(stack.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('completed')
    } finally { await stack.dispose() }
  })

  it('warns without aborting repeated productive side effects or parsing their success:false data', async () => {
    let effects = 0
    const adapter = new GuardAdapter(async function* (_options, index) {
      if (index <= 40) yield* toolChunks(index, 'guard_increment')
      else yield* doneChunks()
    })
    const stack = await mountGuard(adapter)
    try {
      stack.ctx.tools.register(defineTool({ name: 'guard_increment', description: 'Productive side effect.', parameters: {},
        output: { schema: { type: 'boolean' }, render: () => [{ type: 'text', text: '{"success":false}' }] },
        execute: async () => { effects += 1; return true },
      }))
      stack.agent.followup(prompt())
      await stack.agent.whenIdle()
      expect(effects).toBe(40)
      expect(adapter.requests).toHaveLength(41)
      expect(adapter.requests[10]?.messages.some(message => JSON.stringify(message).includes('Execution guard WARNING'))).toBe(true)
    } finally { await stack.dispose() }
  })
})
