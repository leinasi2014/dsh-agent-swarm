import { CodeRuntime, type CodeRunRequest, type CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { GuardAdapter, doneChunks, mountGuard, prompt, toolChunks } from './helpers/execution-guard.js'

class BridgeRuntime extends CodeRuntime {
  readonly language = 'typescript'
  readonly isolation = 'test'
  behavior: (request: CodeRunRequest) => Promise<CodeRunResult> = async () => ({ logs: [] })
  run(request: CodeRunRequest): Promise<CodeRunResult> { return this.behavior(request) }
}

describe('execution guard through the real Code Mode dispatch bridge', () => {
  it.each(['global', 'unknown-tool'])('contains nested %s while successful run_code wrappers cannot clear its streak', async detector => {
    const adapter = new GuardAdapter(async function* (_options, index) {
      if (index <= 40) yield* toolChunks(index, 'run_code', { code: 'return await tools.guard_nested({})', description: 'bounded bridge proof' })
      else yield* doneChunks()
    })
    const stack = await mountGuard(adapter)
    try {
      const code = await stack.ctx.plugin(BridgeRuntime)
      stack.fibers.push(code)
      const runtime = stack.ctx.codeRuntime as BridgeRuntime
      stack.agent.ctx.tools.presentAs('ptc')
      let bodyCalls = 0
      const definition = defineTool({ name: 'guard_nested', description: 'nested real tool', parameters: {},
        output: { schema: { type: 'boolean' }, render: () => [] },
        execute: async () => { bodyCalls += 1; throw new HarnessError('private nested failure', 'GUARD_TEST_FAILURE') },
      })
      let unregister = stack.ctx.tools.register(definition)
      runtime.behavior = async request => {
        const invoke = request.bindings[0]!.functions.guard_nested!
        // The SDK binding exists, but the actual registry entry vanishes before
        // dispatch. This produces official UNKNOWN_TOOL, not JS missing-property text.
        if (detector === 'unknown-tool') unregister()
        try { await invoke({}) } catch { /* The finite program handles its inner failure. */ }
        finally { if (detector === 'unknown-tool') unregister = stack.ctx.tools.register(definition) }
        return { logs: [], value: true }
      }
      stack.agent.followup(prompt())
      await stack.agent.whenIdle()
      expect(adapter.requests).toHaveLength(detector === 'global' ? 30 : 10)
      const events = stack.agent.session.snapshotEvents()
      expect(events.findLast(event => event.type === 'turn/end')?.data.reason)
        .toMatchObject({ kind: 'aborted', reason: { reason: expect.stringContaining(detector) } })
      expect(events.filter(event => event.type === 'tool/code-dispatch')).toHaveLength(detector === 'global' ? 30 : 10)
      expect(bodyCalls).toBe(detector === 'global' ? 30 : 0)
      unregister()
      await code.dispose()
    } finally { await stack.dispose() }
  })

  it('does not label a missing SDK binding TypeError as structured UNKNOWN_TOOL', async () => {
    const adapter = new GuardAdapter(async function* (_options, index) {
      if (index <= 12) yield* toolChunks(index, 'run_code', { code: 'return await tools.absent({})', description: 'missing binding' })
      else yield* doneChunks()
    })
    const stack = await mountGuard(adapter)
    try {
      stack.fibers.push(await stack.ctx.plugin(BridgeRuntime))
      stack.agent.ctx.tools.presentAs('ptc')
      ;(stack.ctx.codeRuntime as BridgeRuntime).behavior = async request => ({ logs: [], value: await request.bindings[0]!.functions.absent!({}) })
      stack.agent.followup(prompt()); await stack.agent.whenIdle()
      expect(adapter.requests).toHaveLength(13)
      expect(stack.agent.session.snapshotEvents().filter(event => event.type === 'tool/code-dispatch')).toHaveLength(0)
      expect(stack.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('completed')
    } finally { await stack.dispose() }
  })

  it('contains two stable read identities at ten complete no-progress cycles', async () => {
    const adapter = new GuardAdapter(async function* (_options, index) {
      if (index <= 40) yield* toolChunks(index, 'agent_swarm_list_memory', { cursor: index % 2 })
      else yield* doneChunks()
    })
    const stack = await mountGuard(adapter)
    try {
      stack.agent.followup(prompt())
      await stack.agent.whenIdle()
      expect(adapter.requests).toHaveLength(22)
      expect(stack.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason)
        .toMatchObject({ kind: 'aborted', reason: { reason: expect.stringContaining('ping-pong') } })
      expect(adapter.requests[12]?.messages.some(message => JSON.stringify(message).includes('ping-pong: 5'))).toBe(true)
    } finally { await stack.dispose() }
  })
})
