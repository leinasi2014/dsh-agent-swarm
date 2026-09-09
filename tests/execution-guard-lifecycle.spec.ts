import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { installExecutionGuard } from '../src/runtime/execution-guard.js'
import { fingerprint, requestIdentity, ToolProgress } from '../src/runtime/execution-guard-tools.js'
import { TextProgress } from '../src/runtime/execution-guard-text.js'
import { GuardAdapter, doneChunks, mountGuard, prompt, toolChunks } from './helpers/execution-guard.js'

describe('execution guard ownership and lifecycle fences', () => {
  it('leaves non-Team Agents and disabled compositions unchanged', async () => {
    for (const enabled of [true, false]) {
      const adapter = new GuardAdapter(async function* (_options, index) {
        if (index <= 40) yield* toolChunks(index, 'guard_missing')
        else yield* doneChunks()
      })
      const stack = await mountGuard(adapter, { executionGuard: enabled })
      try {
        const agent = enabled ? await stack.ctx.agentLoop.create(SessionId('unowned'), { provider: 'guard', model: 'guard' }, { cwd: stack.root }) : stack.agent
        agent.followup(prompt()); await agent.whenIdle()
        expect(adapter.requests).toHaveLength(41)
        expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('completed')
      } finally { await stack.dispose() }
    }
  })

  it('starts each new turn with fresh counts and a fresh warning', async () => {
    let step = 0
    const adapter = new GuardAdapter(async function* (_options, index) {
      if (++step <= 6) yield* toolChunks(index, 'guard_missing')
      else yield* doneChunks()
    })
    const stack = await mountGuard(adapter)
    try {
      for (let turn = 0; turn < 2; turn += 1) {
        step = 0; stack.agent.followup(prompt()); await stack.agent.whenIdle()
      }
      expect(adapter.requests).toHaveLength(14)
      expect(stack.agent.session.snapshotEvents().filter(event => event.type === 'turn/end').every(event => event.data.reason.kind === 'completed')).toBe(true)
      expect(stack.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && JSON.stringify(event.data).includes('Execution guard WARNING'))).toHaveLength(2)
    } finally { await stack.dispose() }
  })

  it.each(['dispose', 'reject', 'abort'])('drops a pending WARNING at %s before its pre-step can commit', async action => {
    const adapter = new GuardAdapter(async function* (_options, index) {
      if (index <= 8) yield* toolChunks(index, 'guard_missing')
      else yield* doneChunks()
    })
    const stack = await mountGuard(adapter, { executionGuard: false })
    const offGuard = installExecutionGuard(stack.ctx, stack.ctx.agentSwarm)
    let release!: () => void
    let entered!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    const ready = new Promise<void>(resolve => { entered = resolve })
    const offStep = stack.ctx.on('agent/pre-step', async ({ step }, next) => {
      const decision = await next()
      if (step !== 6) return decision
      entered(); await hold
      return action === 'reject' ? { kind: 'reject' } : decision
    })
    try {
      stack.agent.followup(prompt()); await ready
      if (action === 'dispose') offGuard()
      if (action === 'abort') stack.agent.cancel({ kind: 'user' }, { keepInbox: true })
      release(); await stack.agent.whenIdle()
      expect(stack.agent.session.snapshotEvents().some(event => event.type === 'user/message' && JSON.stringify(event.data).includes('Execution guard WARNING'))).toBe(false)
      expect(stack.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason.kind)
        .toBe(action === 'dispose' ? 'completed' : action === 'reject' ? 'blocked' : 'aborted')
    } finally { release(); offStep(); offGuard(); await stack.dispose() }
  })

  it('fences an already scheduled critical cancellation when its guard is disposed', async () => {
    const adapter = new GuardAdapter(async function* (_options, index) {
      if (index <= 12) yield* toolChunks(index, 'guard_missing')
      else yield* doneChunks()
    })
    const stack = await mountGuard(adapter, { executionGuard: false })
    const offGuard = installExecutionGuard(stack.ctx, stack.ctx.agentSwarm)
    const offEvent = stack.ctx.on('session/event', (_session, event) => {
      if (event.type === 'tool/result' && event.data.message.source.callId === 'guard-call-10') offGuard()
    })
    try {
      stack.agent.followup(prompt()); await stack.agent.whenIdle()
      expect(adapter.requests).toHaveLength(13)
      expect(stack.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('completed')
    } finally { offEvent(); offGuard(); await stack.dispose() }
  })

  it('guards the current provisioning Session first turn but never its historical predecessor', async () => {
    const adapter = new GuardAdapter(async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      for (let index = 0; index < 100; index += 1) yield { type: 'text-delta', index: 0, text: 'Let me run. Executing. ' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const stack = await mountGuard(adapter)
    try {
      const scope = stack.ctx.agentSwarm.scopeOf(stack.agent)
      const domain = stack.ctx.agentSwarm.domain
      const { team } = await stack.ctx.agentSwarm.status({ agent: stack.agent, signal: new AbortController().signal })
      await domain.provisionMember(scope, team.id, stack.agent.id, { name: 'worker', role: 'bounded fixture', sessionId: 'guard-old', provider: 'spawn' })
      await domain.settleMember(scope, team.id, 'guard-old', { active: false, error: 'fixture interrupted admission' })
      await domain.provisionMember(scope, team.id, stack.agent.id, { name: 'worker', role: 'bounded fixture', sessionId: 'guard-new', retryOf: 'guard-old', provider: 'spawn' })
      const current = await stack.ctx.agentLoop.create(SessionId('guard-new'), { provider: 'guard', model: 'guard' }, { cwd: stack.root })
      const previous = await stack.ctx.agentLoop.create(SessionId('guard-old'), { provider: 'guard', model: 'guard' }, { cwd: stack.root })
      const before = await domain.snapshot(scope, team.id, stack.agent.id)
      expect(before.team.members[0]?.phase).toBe('provisioning')
      current.followup(prompt()); previous.followup(prompt())
      await Promise.all([current.whenIdle(), previous.whenIdle()])
      expect(current.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('aborted')
      expect(previous.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('completed')
      expect((await domain.snapshot(scope, team.id, stack.agent.id)).team.members).toEqual(before.team.members)
    } finally { await stack.dispose() }
  })

  it('contains a real active member repeatedly reading its own private memory', async () => {
    const adapter = new GuardAdapter(async function* (_options, index) {
      if (index <= 40) yield* toolChunks(index, 'agent_swarm_list_private_memory')
      else yield* doneChunks()
    })
    const stack = await mountGuard(adapter)
    try {
      const scope = stack.ctx.agentSwarm.scopeOf(stack.agent)
      const domain = stack.ctx.agentSwarm.domain
      const { team } = await stack.ctx.agentSwarm.status({ agent: stack.agent, signal: new AbortController().signal })
      await domain.provisionMember(scope, team.id, stack.agent.id, { name: 'reader', role: 'private memory owner', sessionId: 'guard-reader', provider: 'spawn' })
      await domain.settleMember(scope, team.id, 'guard-reader', { active: true })
      const member = await stack.ctx.agentLoop.create(SessionId('guard-reader'), { provider: 'guard', model: 'guard' }, { cwd: stack.root })
      member.followup(prompt()); await member.whenIdle()
      expect(adapter.requests).toHaveLength(31)
      expect(member.session.snapshotEvents().filter(event => event.type === 'tool/result').every(event => event.data.message.content[0].isError === false)).toBe(true)
      expect(member.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('aborted')
    } finally { await stack.dispose() }
  })

  it('bounds retained fingerprints and visible text without comparing truncated results', () => {
    const progress = new ToolProgress()
    for (let index = 0; index < 1_000; index += 1) progress.observe({ ...requestIdentity('other', { index }), result: fingerprint(index), failed: false, unknown: false })
    expect(progress.size).toBe(128)
    expect(fingerprint({ payload: 'x'.repeat(100_000) })).toBeUndefined()
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }))
    const text = new TextProgress()
    text.feed(Array.from({ length: 2_000 }, (_, index) => `Observation ${index}: result ${index * 37}. `).join(''))
    expect(text.retainedBytes).toBeLessThanOrEqual(8_192)
    const fenced = new TextProgress()
    expect(fenced.feed('`'.repeat(300) + 'text\n' + '`'.repeat(257) + '\n' + 'Let me run. Executing. '.repeat(100))).toEqual([])
    expect(text.feed('执行下一步操作，现在继续。'.repeat(100)).some(notice => notice.level === 'CRITICAL')).toBe(true)
  })
})
