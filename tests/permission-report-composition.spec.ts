/** Official child report and inherited transport regression coverage. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as SubagentReport from '@deepseek-ai/dsh-tool-subagent-report'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { addMember, mount, toolCall, type Composition } from './helpers/gated-composition.js'

const roots: string[] = []
const stacks: Composition[] = []
afterEach(async () => {
  for (const composition of stacks.splice(0).toReversed()) for (const fiber of composition.fibers.toReversed()) await fiber.dispose()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
}, 30_000)

async function stack(): Promise<Composition> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tool-transport-'))
  roots.push(root)
  const value = await mount(root, 30_000)
  stacks.push(value)
  return value
}

async function memberOf(value: Composition, id: string): Promise<Agent> {
  return await vi.waitFor(() => {
    const agent = value.ctx.agents.get(SessionId(id))
    expect(agent).toBeDefined()
    return agent as Agent
  })
}

function reports(agent: Agent): string[] {
  return agent.inbox.nextStep.flatMap(message => message.source.kind === 'subagent-report'
    ? message.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [])
}

describe('official member tool transport', () => {
  it('passes only the child-scoped official report and preserves a downstream denial', async () => {
    const value = await stack()
    value.fibers.push(await value.ctx.plugin(SubagentReport, { reportDelivery: 'quiet' }))
    const member = await memberOf(value, await addMember(value, 'report-worker'))
    expect(value.ctx.tools.get('report', member)).not.toBe(value.ctx.tools.get('report'))
    const passed = await toolCall(value.ctx, member, 'report-pass', 'report', { output: 'handoff' })
    expect(passed.isError).toBe(false)
    expect(reports(value.lead).join('\n')).toContain('handoff')
    const off = member.ctx.tools.guard(exec => exec.name === 'report' ? 'downstream report guard' : undefined)
    try {
      const blocked = await toolCall(value.ctx, member, 'report-blocked', 'report', { output: 'blocked' })
      expect(blocked.isError).toBe(true)
      expect((blocked.error as { message?: string }).message).toContain('downstream report guard')
    } finally { off() }
  }, 30_000)

  it('denies root global report but inherits an ordinary host tool and run_code transport', async () => {
    const value = await stack()
    let calls = 0
    value.ctx.effect(() => value.ctx.tools.register(defineTool({
      name: 'transport_probe', description: 'fixture', parameters: {},
      output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } }, render: () => [] },
      execute: async () => { calls += 1; return { ok: true } },
    }), 'transport fixture'))
    const report = await toolCall(value.ctx, value.lead, 'root-report', 'report', { output: 'nope' })
    expect(report.isError).toBe(true)
    const inherited = await toolCall(value.ctx, value.lead, 'inherited-host-tool', 'transport_probe', {})
    expect(inherited.isError).toBe(false)
    expect(calls).toBe(1)
  }, 30_000)
})
