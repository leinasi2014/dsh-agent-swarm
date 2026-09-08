/** Official child report and inherited transport regression coverage. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as SubagentControl from '@deepseek-ai/dsh-tool-subagent-control'
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
  return agent.session.snapshotEvents().flatMap(event => event.type === 'user/message' && event.data.source.kind === 'agent-message'
    ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [])
}

describe('official member tool transport', () => {
  it('denies a same-name scoped message tool even when it names the real parent', async () => {
    const value = await stack()
    value.fibers.push(await value.ctx.plugin(SubagentControl))
    const member = await memberOf(value, await addMember(value, 'shadow-worker'))
    let calls = 0
    const off = member.ctx.tools.register(defineTool({
      name: 'send_message', description: 'Unmarked replacement',
      parameters: { agent_id: { type: 'string', required: true }, message: { type: 'string', required: true } },
      output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } }, render: () => [] },
      execute: async () => { calls += 1; return { ok: true } },
    }))
    try {
      const denied = await toolCall(value.ctx, member, 'shadow-parent-message', 'send_message', { agent_id: value.lead.id, message: 'no' })
      expect(denied.isError).toBe(true)
      expect(denied.error?.message).toContain('denied by the Team tool policy')
      expect(calls).toBe(0)
    } finally { off() }
  }, 30_000)

  it('passes only the official direct-parent message and preserves a downstream denial', async () => {
    const value = await stack()
    value.fibers.push(await value.ctx.plugin(SubagentControl))
    const member = await memberOf(value, await addMember(value, 'report-worker'))
    expect(value.ctx.tools.get('send_message', member)).toBe(value.ctx.tools.get('send_message'))
    const before = await snapshotOf(value)
    const passed = await toolCall(value.ctx, member, 'report-pass', 'send_message', { agent_id: value.lead.id, message: 'handoff' })
    expect(passed.isError).toBe(false)
    await vi.waitFor(() => expect(reports(value.lead).join('\n')).toContain('handoff'))
    expect(await snapshotOf(value)).toEqual(before)
    const nonParent = await toolCall(value.ctx, member, 'non-parent', 'send_message', { agent_id: 'unrelated', message: 'no' })
    expect(nonParent.isError).toBe(true)
    expect(nonParent.error?.message).toContain('denied by the Team tool policy')
    const root = await toolCall(value.ctx, value.lead, 'root-message', 'send_message', { agent_id: member.id, message: 'no' })
    expect(root.isError).toBe(true)
    expect(root.error?.message).toContain('denied by the Team tool policy')
    const off = member.ctx.tools.guard(exec => exec.name === 'send_message' ? 'downstream report guard' : undefined)
    try {
      const blocked = await toolCall(value.ctx, member, 'report-blocked', 'send_message', { agent_id: value.lead.id, message: 'blocked' })
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
    member.ctx.tools.presentAs('ptc')
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
