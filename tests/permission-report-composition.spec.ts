/** Official child report and inherited transport regression coverage. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as SubagentReport from '@deepseek-ai/dsh-tool-subagent-report'
import { CodeRuntime, type CodeRunRequest, type CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { addMember, mount, snapshotOf, toolCall, type Composition } from './helpers/gated-composition.js'

const roots: string[] = []
const stacks: Composition[] = []
class FakeRuntime extends CodeRuntime {
  readonly language = 'typescript'
  readonly isolation = 'test'
  behavior: (request: CodeRunRequest) => Promise<CodeRunResult> = async () => ({ logs: [] })
  run(request: CodeRunRequest): Promise<CodeRunResult> { return this.behavior(request) }
}
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
    value.ctx.effect(() => value.ctx.tools.register(defineTool({
      name: 'report', description: 'global report fixture', parameters: { output: { type: 'string', required: true } },
      output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } }, render: () => [] },
      execute: async () => ({ ok: true }),
    })))
    value.fibers.push(await value.ctx.plugin(SubagentReport, { reportDelivery: 'quiet' }))
    const member = await memberOf(value, await addMember(value, 'report-worker'))
    expect(value.ctx.tools.get('report', member)).not.toBe(value.ctx.tools.get('report'))
    const before = await snapshotOf(value)
    const passed = await toolCall(value.ctx, member, 'report-pass', 'report', { output: 'handoff' })
    expect(passed.isError).toBe(false)
    expect(reports(value.lead).join('\n')).toContain('handoff')
    expect(await snapshotOf(value)).toEqual(before)
    const off = member.ctx.tools.guard(exec => exec.name === 'report' ? 'downstream report guard' : undefined)
    try {
      const blocked = await toolCall(value.ctx, member, 'report-blocked', 'report', { output: 'blocked' })
      expect(blocked.isError).toBe(true)
      expect((blocked.error as { message?: string }).message).toContain('downstream report guard')
      expect(await snapshotOf(value)).toEqual(before)
    } finally { off() }
  }, 30_000)

  it('denies root global report and inherits an ordinary host tool', async () => {
    const value = await stack()
    let calls = 0
    let globalReportCalls = 0
    value.ctx.effect(() => value.ctx.tools.register(defineTool({
      name: 'report', description: 'global report fixture', parameters: { output: { type: 'string', required: true } },
      output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } }, render: () => [] },
      execute: async () => { globalReportCalls += 1; return { ok: true } },
    })))
    value.ctx.effect(() => value.ctx.tools.register(defineTool({
      name: 'transport_probe', description: 'fixture', parameters: {},
      output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } }, render: () => [] },
      execute: async () => { calls += 1; return { ok: true } },
    })))
    const before = await snapshotOf(value)
    const report = await toolCall(value.ctx, value.lead, 'root-report', 'report', { output: 'nope' })
    expect(report.isError).toBe(true)
    expect((report.error as { message?: string }).message).toContain('denied by the Team tool policy')
    expect(globalReportCalls).toBe(0)
    expect(await snapshotOf(value)).toEqual(before)
    const inherited = await toolCall(value.ctx, value.lead, 'inherited-host-tool', 'transport_probe', {})
    expect(inherited.isError).toBe(false)
    expect(calls).toBe(1)
    const off = value.ctx.tools.guard(exec => exec.name === 'transport_probe' ? 'downstream host guard' : undefined)
    try {
      const denied = await toolCall(value.ctx, value.lead, 'inherited-host-tool-denied', 'transport_probe', {})
      expect(denied.isError).toBe(true)
      expect((denied.error as { message?: string }).message).toContain('downstream host guard')
      expect(calls).toBe(1)
    } finally { off() }
  }, 30_000)

  it('bridges official run_code into nested pre-execute: inherited success and downstream denial preserve Team state', async () => {
    const value = await stack()
    await value.ctx.plugin(FakeRuntime)
    const runtime = value.ctx.codeRuntime as FakeRuntime
    let calls = 0
    value.ctx.effect(() => value.ctx.tools.register(defineTool({
      name: 'transport_probe', description: 'fixture', parameters: {},
      output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } }, render: () => [] },
      execute: async () => { calls += 1; return { ok: true } },
    })))
    const member = await memberOf(value, await addMember(value, 'code-worker'))
    member.ctx.tools.presentAs('code')
    runtime.behavior = async request => ({ logs: [], value: await request.bindings[0]!.functions.transport_probe!({}) })
    const before = await snapshotOf(value)
    const pass = await toolCall(value.ctx, member, 'code-pass', 'run_code', { code: 'return await tools.transport_probe({})', description: 'probe' })
    expect(pass.isError).toBe(false)
    expect(calls).toBe(1)
    expect(await snapshotOf(value)).toEqual(before)
    const off = value.ctx.tools.guard(exec => exec.name === 'transport_probe' ? 'nested guard' : undefined)
    try {
      const denied = await toolCall(value.ctx, member, 'code-denied', 'run_code', { code: 'return await tools.transport_probe({})', description: 'probe' })
      expect(denied.isError).toBe(true)
      expect(calls).toBe(1)
      expect(await snapshotOf(value)).toEqual(before)
    } finally { off() }
  }, 30_000)
})
