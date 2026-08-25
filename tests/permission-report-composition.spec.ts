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
  SIGNAL,
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

async function startOfficialChild(composition: Composition, label: string): Promise<Agent> {
  const started = await composition.ctx.subagents.startContinuable({
    provider: 'spawn',
    label,
    request: {
      prompt: [{ type: 'text', text: label }],
      parent: composition.lead,
    },
    signal: SIGNAL,
  })
  return await liveMember(composition, started.childId)
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

  it('lets a continuable child Captain report to its direct parent without mutating its Team', async () => {
    const composition = await newComposition()
    composition.fibers.push(await composition.ctx.plugin(SubagentReport, { reportDelivery: 'quiet' }))
    const child = await startOfficialChild(composition, 'independent child Captain')
    const childTeam = await composition.ctx.agentSwarm.create(
      { agent: child, signal: SIGNAL },
      'Child-owned Team',
      'Prove that Host-plane report is role independent.',
    )
    const scope = composition.ctx.agentSwarm.scopeOf(child)
    const before = await composition.ctx.agentSwarm.domain.snapshot(scope, childTeam.id, child.id)

    const result = await toolCall(composition.ctx, child, 'child-captain-report', GLOBAL_REPORT, {
      output: 'child Captain handoff',
    })

    expect(result.isError).toBe(false)
    const delivered = reports(composition.lead)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ sender: child.id })
    expect(delivered[0]?.text).toContain('child Captain handoff')
    expect(await composition.ctx.agentSwarm.domain.snapshot(scope, childTeam.id, child.id)).toEqual(before)
  }, 30_000)

  it('bypasses membership ambiguity when a parent-Team member also Captains a sub-Team', async () => {
    const { composition, memberId, member } = await setupOfficialReport()
    const subTeam = await composition.ctx.agentSwarm.create(
      { agent: member, signal: SIGNAL },
      'Member sub-Team',
      'Exercise the valid member-plus-Captain overlap.',
    )
    await expect(composition.ctx.agentSwarm.domain.findMembership(composition.scope, memberId))
      .rejects.toMatchObject({ code: 'TEAM_MEMBERSHIP_AMBIGUOUS' })
    const parentBefore = await snapshotOf(composition)
    const childBefore = await composition.ctx.agentSwarm.domain.snapshot(composition.scope, subTeam.id, member.id)

    const result = await toolCall(composition.ctx, member, 'ambiguous-member-report', GLOBAL_REPORT, {
      output: 'ambiguous membership handoff',
    })

    expect(result.isError).toBe(false)
    const delivered = reports(composition.lead)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ sender: memberId })
    expect(delivered[0]?.text).toContain('ambiguous membership handoff')
    expect(await snapshotOf(composition)).toEqual(parentBefore)
    expect(await composition.ctx.agentSwarm.domain.snapshot(composition.scope, subTeam.id, member.id)).toEqual(childBefore)
  }, 30_000)

  it('denies a root Captain global report while ordinary host tools inherit official authority', async () => {
    const composition = await newComposition()
    const reportExecutions = { count: 0 }
    const probeExecutions = { count: 0 }
    registerFixtureTool(composition.ctx, GLOBAL_REPORT, reportExecutions)
    registerFixtureTool(composition.ctx, UNLISTED_TOOL, probeExecutions)

    expect(composition.lead.session.header.parentSession).toBeUndefined()
    expect(composition.ctx.tools.get(GLOBAL_REPORT, composition.lead)).toBe(composition.ctx.tools.get(GLOBAL_REPORT))
    const reportResult = await toolCall(composition.ctx, composition.lead, 'captain-global-report', GLOBAL_REPORT, {
      output: 'must not execute',
    })
    expect(reportResult.isError).toBe(true)
    expect((reportResult.error as { message?: string }).message ?? '').toContain('denied by the Team tool policy')

    const unlistedResult = await toolCall(composition.ctx, composition.lead, 'captain-unlisted-probe', UNLISTED_TOOL, {})
    expect(unlistedResult.isError).toBe(false)
    expect(reportExecutions.count).toBe(0)
    expect(probeExecutions.count).toBe(1)
  }, 30_000)
})
