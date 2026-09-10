import { expect, it } from 'vitest'
import { CodeRuntime, type CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import { GuardAdapter, doneChunks, mountGuard, prompt } from './helpers/execution-guard.js'

/** No program execution: this fixture exercises the official model-facing SDK compiler. */
class VisualSchemaRuntime extends CodeRuntime {
  readonly language = 'typescript'
  readonly isolation = 'test'
  run(): Promise<CodeRunResult> { throw new Error('Schema proof must not execute code') }
}

it.each(['native', 'ptc'] as const)('projects visual assistance through the official %s model schema boundary', async mode => {
  const adapter = new GuardAdapter(async function* () { yield* doneChunks() })
  const stack = await mountGuard(adapter)
  try {
    if (mode === 'ptc') {
      stack.fibers.push(await stack.ctx.plugin(VisualSchemaRuntime))
      stack.agent.ctx.tools.presentAs('ptc')
    }
    stack.agent.followup(prompt('Read the available visual assistance contract.'))
    await stack.agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    const request = adapter.requests[0]!
    const schema = stack.ctx.tools.schemas().find(tool => tool.name === 'agent_swarm_complete_visual_assistance')!
    const requestSchema = stack.ctx.tools.schemas().find(tool => tool.name === 'agent_swarm_request_visual_assistance')!
    assertSupportedJsonSchema(schema.parameters)
    assertSupportedJsonSchema(requestSchema.parameters)
    expect(schema.parameters).toMatchObject({ additionalProperties: false, required: ['request_id', 'assistance_id', 'outcome'],
      properties: { outcome: { oneOf: [
        { type: 'object', additionalProperties: false, required: ['state', 'summary'], properties: {
          state: { const: 'completed' }, summary: { type: 'string', description: expect.stringContaining('8192') } } },
        { type: 'object', additionalProperties: false, required: ['state', 'reason'], properties: {
          state: { const: 'failed' }, reason: { enum: ['helper-unavailable', 'image-capability-unknown',
            'image-model-unsupported', 'image-unavailable', 'permission-revoked', 'expired'] } } },
      ] } } })
    if (mode === 'native') {
      expect(request.tools).toContainEqual(schema)
      expect(request.tools).toContainEqual(requestSchema)
      for (const outcome of [{ state: 'completed', summary: '' }, { state: 'completed', summary: ' \t\n' },
        { state: 'completed', summary: 'x'.repeat(8193) }, { state: 'failed', reason: 'invented' },
        { state: 'failed', reason: 'expired', summary: 'wrong branch' }]) {
        const rejected = await stack.execute('agent_swarm_complete_visual_assistance', {
          request_id: 'invalid-completion', assistance_id: 'absent', outcome })
        expect(rejected.isError).toBe(true)
        expect(rejected.error?.message).toContain('outcome')
      }
      for (const fields of [{ image_ids: [] }, { image_ids: ['image-1', 'image-1'] },
        { image_ids: Array.from({ length: 257 }, (_, index) => `image-${index}`) },
        { question: ' \t\n' }, { question: 'x'.repeat(8193) }]) {
        const rejected = await stack.execute('agent_swarm_request_visual_assistance', { request_id: 'invalid-request',
          source_message_id: 'absent', image_ids: ['image-1'], helper_member_id: 'absent', question: 'inspect', ...fields })
        expect(rejected.isError).toBe(true)
        expect(rejected.error?.message).toMatch(/Select a nonempty unique image set|Visual question must not be empty|Visual question is too large/u)
      }
    }
    else {
      expect(request.tools?.map(tool => tool.name)).toEqual(['run_code'])
      const system = request.messages.filter(message => message.role === 'system').flatMap(message => message.content)
        .map(block => block.type === 'text' ? block.text : '').join('\n')
      const signature = system.split('interface ToolOutputMap')[0]!.match(/  agent_swarm_complete_visual_assistance:[\s\S]*?(?=\n  \/\*\*|\n\})/u)?.[0]
      expect(signature).toContain('outcome:')
      expect(signature).toContain('state: "completed";')
      expect(signature).toContain('summary: string;')
      expect(signature).toMatch(/state: "failed";\s+reason:/u)
      const requestSignature = system.split('interface ToolOutputMap')[0]!.match(/  agent_swarm_request_visual_assistance:[\s\S]*?(?=\n  \/\*\*|\n\})/u)?.[0]
      expect(requestSignature).toContain('image_ids: string[];')
      expect(requestSignature).toContain('question: string;')
    }
  } finally { await stack.dispose() }
})

