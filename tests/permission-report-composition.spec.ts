/**
 * DBG-021 real-composition contract for the official continuable-child
 * `report` channel under the Team permission overlay.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as SubagentReport from '@deepseek-ai/dsh-tool-subagent-report'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addMember,
  mount,
  snapshotOf,
  toolCall,
  type Composition,
} from './helpers/gated-composition.js'

const GLOBAL_REPORT = 'report'
const UNLISTED_TOOL = 'test_unlisted_host_probe'
const roots: string[] = []
const compositions: Composition[] = []

afterEach(async () => {
  for (const composition of compositions.splice(0).toReversed()) {
    for (const fiber of composition.fibers.toReversed()) await fiber.dispose()
  }
  await Promise.all(roots.splice(0).map(async root => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }))
}, 30_000)

async function newComposition(): Promise<Composition> {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-perm-report-'))
  roots.push(sandbox)
  const composition = await mount(sandbox, 30_000)
  compositions.push(composition)
  return composition
}

async function liveMember(composition: Composition, memberId: string): Promise<Agent> {
  return await vi.waitFor(() => {
    const member = composition.ctx.agents.get(SessionId(memberId))
    expect(member).toBeDefined()
    return member as Agent
  }, { timeout: 5_000 })
}

function reports(agent: Agent): Array<{ readonly text: string; readonly sender: string }> {
  const visible = agent.session.events.flatMap(event => event.type === 'user/message' ? [event.data] : [])
  return [...visible, ...agent.inbox.nextStep].flatMap(message => {
    if (message.source.kind !== 'subagent-report') return []
    return [{
      text: message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'),
      sender: message.source.senderSessionId,
    }]
  })
}

function registerFixtureTool(ctx: Context, name: string, executed: { count: number }): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name,
    description: `Global ${name} fixture for DBG-021.`,
    parameters: name === GLOBAL_REPORT
      ? { output: { type: 'string', required: true } }
      : {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true } },
      },
      render: () => [],
    },
    execute: async () => {
      executed.count += 1
      return { ok: true }
    },
  })), `DBG-021 ${name} fixture`)
}

async function setupOfficialReport(): Promise<{
  readonly composition: Composition
  readonly memberId: string
  readonly member: Agent
}> {
  const composition = await newComposition()
  composition.fibers.push(await composition.ctx.plugin(SubagentReport, { reportDelivery: 'quiet' }))
  const memberId = await addMember(composition, 'report-worker')
  return { composition, memberId, member: await liveMember(composition, memberId) }
}

describe('DBG-021: official report is a child-scoped host-plane channel', () => {
  it('passes the official member report to its exact captain without mutating Team state', async () => {
    const { composition, memberId, member } = await setupOfficialReport()
    const before = await snapshotOf(composition)

    expect(member.session.header.parentSession).toBe(composition.lead.id)
    expect(composition.ctx.tools.get(GLOBAL_REPORT, member)).toBeDefined()
    expect(composition.ctx.tools.get(GLOBAL_REPORT, member)).not.toBe(composition.ctx.tools.get(GLOBAL_REPORT))
    const result = await toolCall(composition.ctx, member, 'member-report', GLOBAL_REPORT, {
      output: 'member handoff',
    })

    expect(result.isError).toBe(false)
    const delivered = reports(composition.lead)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ sender: memberId })
    expect(delivered[0]?.text).toContain('member handoff')
    expect(await snapshotOf(composition)).toEqual(before)
  }, 30_000)

  it('keeps a downstream guard authoritative over the scoped member report', async () => {
    const { composition, member } = await setupOfficialReport()
    const disposeGuard = member.ctx.tools.guard(exec => exec.name === GLOBAL_REPORT
      ? 'downstream report guard'
      : undefined)
    try {
      const result = await toolCall(composition.ctx, member, 'member-report-guarded', GLOBAL_REPORT, {
        output: 'must not arrive',
      })
      expect(result.isError).toBe(true)
      expect((result.error as { message?: string }).message ?? '').toContain('downstream report guard')
      expect(reports(composition.lead)).toHaveLength(0)
    } finally {
      disposeGuard()
    }
  }, 30_000)

  it('does not exempt a scoped report when the durable Team captain mismatches its parent', async () => {
    const { composition, memberId, member } = await setupOfficialReport()
    const domain = composition.ctx.agentSwarm.domain
    const findMembership = domain.findMembership.bind(domain)
    const actual = await findMembership(composition.scope, memberId)
    if (actual === undefined) throw new Error('member membership is missing')
    const spy = vi.spyOn(domain, 'findMembership').mockImplementation(async (scope, sessionId) => {
      if (sessionId !== memberId) return await findMembership(scope, sessionId)
      return { ...actual, team: { ...actual.team, captainSessionId: 'different-captain' } }
    })
    try {
      const result = await toolCall(composition.ctx, member, 'member-report-wrong-parent', GLOBAL_REPORT, {
        output: 'must not arrive',
      })
      expect(result.isError).toBe(true)
      expect((result.error as { message?: string }).message ?? '').toContain('denied by the Team tool policy')
      expect(reports(composition.lead)).toHaveLength(0)
    } finally {
      spy.mockRestore()
    }
  }, 30_000)

  it('keeps global same-name and ordinary unlisted host tools fail-closed for members', async () => {
    const composition = await newComposition()
    const reportExecutions = { count: 0 }
    const probeExecutions = { count: 0 }
    registerFixtureTool(composition.ctx, GLOBAL_REPORT, reportExecutions)
    registerFixtureTool(composition.ctx, UNLISTED_TOOL, probeExecutions)
    const memberId = await addMember(composition, 'global-report-worker')
    const member = await liveMember(composition, memberId)

    expect(composition.ctx.tools.get(GLOBAL_REPORT, member)).toBe(composition.ctx.tools.get(GLOBAL_REPORT))
    const reportResult = await toolCall(composition.ctx, member, 'member-global-report', GLOBAL_REPORT, {
      output: 'must not execute',
    })
    expect(reportResult.isError).toBe(true)
    expect((reportResult.error as { message?: string }).message ?? '').toContain('denied by the Team tool policy')

    const unlistedResult = await toolCall(composition.ctx, member, 'member-unlisted-probe', UNLISTED_TOOL, {})
    expect(unlistedResult.isError).toBe(true)
    expect((unlistedResult.error as { message?: string }).message ?? '').toContain('denied by the Team tool policy')
    expect(reportExecutions.count).toBe(0)
    expect(probeExecutions.count).toBe(0)
  }, 30_000)
})
