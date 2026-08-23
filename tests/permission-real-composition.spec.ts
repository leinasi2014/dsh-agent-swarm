/**
 * SW-I1a real-composition permission boundary: mounts the OFFICIAL
 * ToolRuntime + ApprovalService + AgentLoop + storage stack and proves:
 *
 *  - `allow-once` grants one concrete captain tool call in the same open turn;
 *  - `reject`, a missing approval seam, `unavailable` and `cancelled`
 *    approvals all fail closed through the official ToolRuntime;
 *  - a delegated member's `ask` tool is denied (and mapped into the member
 *    provisioning deny filter);
 *  - unrelated agents are NOT touched by the plugin's Team policy;
 *  - a monotonic guard can still deny after our pre-execute decision;
 *  - the evidence-only Reviewer Agent is consumed by the existing review
 *    transaction and commits through TeamDomainPort;
 *  - scenario 44: free text cannot authorize, a forged principal is rejected
 *    by the SW-I1a gateway with TEAM_INTERACTION_NO_PRINCIPAL, a real host
 *    verifier admits authenticated-human, and every Team change still lands
 *    through TeamDomainPort.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId, LlmAdapter, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import SubagentService, { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { defineTool } from '@deepseek-ai/dsh-tools'
import ApprovalService, { type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { afterEach, describe, expect, it } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import type { HumanInteractionRequest } from '../src/index.js'
import { CAPTAIN_ONLY_TOOLS } from '../src/runtime/prompts.js'
import type { ReviewerAgentVerdict } from '../src/runtime/reviewer-boundary.js'
import { mountStorageStackOn } from './helpers/storage-stack.js'
const SIGNAL = new AbortController().signal
class ImmediateAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async * stream(): AsyncIterable<StreamChunk> {
    const text = 'Acknowledged.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const PROBE_TOOL = 'test_permission_probe'
function registerProbeTool(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: PROBE_TOOL,
    description: 'Probe tool for SW-I1a permission composition tests.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
      render: () => [{ type: 'text', text: JSON.stringify({ ok: true }) }],
    },
    execute: async () => ({ ok: true }),
  })), 'agent-swarm: test probe tool')
}
interface Stack {
  readonly ctx: Context
  readonly fibers: Fiber[]
  readonly lead: ReturnType<Context['agentLoop']['create']>
  readonly teamId: AgentSwarm.TeamId
  readonly scope: string
}
async function mount(
  sandbox: string,
  options: {
    toolPolicy?: { allow?: string[]; ask?: string[]; deny?: string[] };
    approval?: boolean;
    reviewProvider?: string;
    orchestrationMode?: 'adaptive' | 'workflow';
    workflowBridge?: boolean;
  } = {},
): Promise<Stack> {
  const ctx = new Context()
  const fibers: Fiber[] = []
  await mountAgentLoopTestDependencies(ctx)
  fibers.push(await ctx.plugin(SqliteSessionPersistence, { path: join(sandbox, 'sessions', 'sessions.db') }))
  await mountStorageStackOn(ctx, join(sandbox, 'storage'))
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
  fibers.push(await ctx.plugin(SubagentService))
  fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
  if (options.approval === true) fibers.push(await ctx.plugin(ApprovalService, { policy: 'ask' }))
  const pluginFiber = await ctx.plugin(AgentSwarm, {
    memberProvider: 'spawn',
    memberMaxDepth: 1,
    ...(options.toolPolicy === undefined ? {} : { toolPolicy: options.toolPolicy }),
    ...(options.reviewProvider === undefined ? {} : { reviewProvider: options.reviewProvider }),
    ...(options.orchestrationMode === undefined ? {} : { orchestrationMode: options.orchestrationMode }),
    ...(options.workflowBridge === undefined ? {} : { workflowBridge: options.workflowBridge }),
  })
  fibers.push(pluginFiber)
  registerProbeTool(ctx)
  ctx.llm.registerAdapter(['mock'], new ImmediateAdapter())
  const lead = ctx.agentLoop.create(
    SessionId(`perm-lead-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    { provider: 'mock', model: 'mock' },
    { cwd: join(sandbox, 'workspace') },
  )
  const created = await callTool(ctx, lead, 'perm-create', 'agent_swarm_create', {
    name: 'SW-I1a permission team',
    description: 'Prove the real ToolRuntime permission surface.',
  })
  if (created.isError) throw new Error(`create failed: ${JSON.stringify(created.error)}`)
  const stack: Stack = {
    ctx,
    fibers,
    lead,
    teamId: AgentSwarm.TeamId((created.value as { team_id: string }).team_id),
    scope: ctx.agentSwarm.scopeOf(lead),
  }
  stacks.push(stack)
  return stack
}
async function callTool(
  ctx: Context,
  agent: ReturnType<Context['agentLoop']['create']>,
  callId: string,
  name: string,
  args: Record<string, unknown> = {},
) {
  return await ctx.tools.execute({ signal: SIGNAL, callId: CallId(callId), name, arguments: args, agent })
}
/**
 * Build an exec authority for a REAL provisioned member session. The
 * member may be cold (not in the live Agent registry) — the Team domain
 * and runtime resolve authority from the durable membership by session id
 * and the session header cwd, exactly like the production followup seam.
 */
function memberAgent(id: string, cwd: string): Agent {
  return {
    id: id as Agent['id'],
    session: { id: SessionId(id), header: { cwd } },
  } as unknown as Agent
}
async function addMember(stack: Stack): Promise<string> {
  const added = await callTool(stack.ctx, stack.lead, 'perm-add', 'agent_swarm_add_member', {
    name: 'worker',
    role: 'SW-I1a permission worker.',
  })
  if (added.isError) throw new Error(`add failed: ${JSON.stringify(added.error)}`)
  return (added.value as { session_id: string }).session_id
}
async function snapshot(stack: Stack) {
  return await stack.ctx.agentSwarm.domain.snapshot(stack.scope, stack.teamId, stack.lead.id)
}
function newRequestId(): string {
  return `human-${Math.random().toString(36).slice(2, 14)}`
}
function controlRequest(stack: Stack, overrides: Partial<HumanInteractionRequest>): HumanInteractionRequest {
  return {
    schemaVersion: 1,
    requestId: newRequestId(),
    teamId: stack.teamId,
    source: { kind: 'captain-mediated', captainSessionId: stack.lead.id },
    target: { kind: 'member', memberName: 'worker' },
    intent: 'wake-member',
    expectedTeamRevision: 1,
    createdAt: Date.now(),
    ...overrides,
  }
}
async function submitError(stack: Stack, control: HumanInteractionRequest): Promise<{ code: string; message: string }> {
  try {
    const admission: AgentSwarm.HumanControlAdmission = control.source.kind === 'authenticated-human'
      ? { kind: 'authenticated-human', principalRef: control.source.principalRef ?? '' }
      : { kind: 'captain', exec: { agent: stack.lead, signal: SIGNAL } }
    await stack.ctx.agentSwarmHumanControl.submit(stack.scope, control, admission, new AbortController().signal)
  } catch (error) {
    return { code: (error as { code?: string }).code ?? 'UNKNOWN', message: error instanceof Error ? error.message : String(error) }
  }
  throw new Error('expected submit to reject')
}
function errorCode(error: unknown): string | undefined {
  const candidate = error as { info?: { code?: string }; code?: string }
  return candidate.info?.code ?? candidate.code
}
const roots: string[] = []
const stacks: Stack[] = []
const detachAgents: Array<() => void> = []
afterEach(async () => {
  for (const detach of detachAgents.splice(0).toReversed()) detach()
  for (const stack of stacks.splice(0).toReversed()) {
    for (const fiber of stack.fibers.toReversed()) await fiber.dispose()
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
}, 30_000)
describe('Reviewer Agent real review transaction', () => {
  it('evidence-only reviewer is consumed by the existing review transaction and commits via TeamDomainPort', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-perm-reviewer-'))
    roots.push(sandbox)
    const stack = await mount(sandbox, { reviewProvider: 'reviewer-agent', orchestrationMode: 'workflow', workflowBridge: true })
    const memberId = await addMember(stack)
    const member = memberAgent(memberId, join(sandbox, 'workspace'))
    const created = await callTool(stack.ctx, stack.lead, 'rv-create', 'agent_swarm_create_task', {
      subject: 'Review me',
      description: 'Prove reviewer evidence flows through the real review transaction.',
    })
    expect(created.isError).toBe(false)
    const createdValue = created.value as { task_id: string; revision: number }
    const authoritative = await snapshot(stack)
    const currentTask = authoritative.team.tasks.find(task => task.id === createdValue.task_id)
    if (currentTask === undefined) throw new Error('created task missing from authoritative snapshot')
    let submitFence: number
    let submitAttempt: string
    const alreadyAssigned = currentTask.status === 'in_progress'
      && currentTask.ownerSessionId === memberId
      && currentTask.currentAttemptId !== undefined
    if (alreadyAssigned) {
      submitFence = currentTask.revision
      submitAttempt = currentTask.currentAttemptId!
    } else {
      const claim = await callTool(stack.ctx, member, 'rv-claim', 'agent_swarm_claim_task', {
        task_id: createdValue.task_id,
        expected_revision: currentTask.revision,
      })
      if (claim.isError) {
        // The scheduler may have claimed the task between the snapshot and
        // the claim (operation-triggered pass). Re-read the authoritative
        // snapshot and adopt the current fence without relaxing domain CAS.
        const retrySnapshot = await snapshot(stack)
        const retryTask = retrySnapshot.team.tasks.find(task => task.id === createdValue.task_id)
        if (retryTask !== undefined && retryTask.status === 'in_progress'
          && retryTask.ownerSessionId === memberId && retryTask.currentAttemptId !== undefined) {
          submitFence = retryTask.revision
          submitAttempt = retryTask.currentAttemptId
        } else {
          throw new Error(`claim failed: ${JSON.stringify(claim.error)}`)
        }
      } else {
        const claimValue = claim.value as { revision: number; attempt_id: string }
        submitFence = claimValue.revision
        submitAttempt = claimValue.attempt_id
      }
    }
    const submit = await callTool(stack.ctx, member, 'rv-submit', 'agent_swarm_submit_task', {
      task_id: createdValue.task_id,
      expected_revision: submitFence,
      attempt_id: submitAttempt,
      output: 'done',
      evidence: ['e1'],
    })
    expect(submit.isError).toBe(false)
    const submitValue = submit.value as { revision: number }
    const review = (): ReturnType<typeof callTool> => callTool(stack.ctx, stack.lead, 'rv-review', 'agent_swarm_review_task', {
      task_id: createdValue.task_id,
      expected_revision: submitValue.revision,
      attempt_id: submitAttempt,
      decision: 'accept',
    })
    const taskStatus = async (): Promise<string | undefined> => {
      const snap = await snapshot(stack)
      return snap.team.tasks.find(task => task.id === createdValue.task_id)?.status
    }
    // Provider missing: the transaction fails loud with no partial mutation.
    const missing = await review()
    expect(missing.isError).toBe(true)
    expect(errorCode(missing.error)).toBe('TEAM_REVIEW_PROVIDER_MISSING')
    expect(await taskStatus()).toBe('submitted')
    // Evidence without recommendation: the reviewer cannot fabricate a verdict.
    const unregisterNoRec = stack.ctx.agentSwarmPermission.registerReviewerAgentProvider({
      kind: 'reviewer-agent',
      name: 'no-recommendation',
      review: async () => ({ kind: 'evidence', evidenceIds: ['e1'], diagnostic: 'ambiguous' }),
    })
    const noRec = await review()
    expect(noRec.isError).toBe(true)
    expect(errorCode(noRec.error)).toBe('TEAM_REVIEWER_EVIDENCE_ONLY')
    expect(await taskStatus()).toBe('submitted')
    unregisterNoRec()
    // A mutation-handle verdict is rejected by the boundary, not executed.
    const unregisterBad = stack.ctx.agentSwarmPermission.registerReviewerAgentProvider({
      kind: 'reviewer-agent',
      name: 'mutation-handle',
      review: async () => ({ kind: 'evidence', evidenceIds: [], diagnostic: 'x', decision: 'accept' }) as unknown as ReviewerAgentVerdict,
    })
    const bad = await review()
    expect(bad.isError).toBe(true)
    expect(errorCode(bad.error)).toBe('TEAM_REVIEWER_EVIDENCE_ONLY')
    expect(await taskStatus()).toBe('submitted')
    unregisterBad()
    // A real evidence+recommendation provider is consumed by the existing
    // review transaction; only that transaction commits via TeamDomainPort.
    const seen: string[] = []
    const unregisterGood = stack.ctx.agentSwarmPermission.registerReviewerAgentProvider({
      kind: 'reviewer-agent',
      name: 'evidence-reviewer',
      review: async ({ workspace }) => {
        seen.push(workspace)
        return { kind: 'evidence', evidenceIds: ['e1'], diagnostic: 'evidence only', recommendation: 'accept' }
      },
    })
    const good = await review()
    expect(good.isError).toBe(false)
    expect(seen).toHaveLength(1)
    expect(await taskStatus()).toBe('completed')
    const reviewed = await snapshot(stack)
    expect(reviewed.team.attempts.find(attempt => attempt.id === submitAttempt)?.diagnostic)
      .toBe('reviewer evidence [e1]: evidence only')
    unregisterGood()
  }, 30_000)
})
describe('real ToolRuntime + approval composition (SW-I1a)', () => {
  it('allow-once grants one concrete captain tool call in the same open turn', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-perm-allow-'))
    roots.push(sandbox)
    const stack = await mount(sandbox, { toolPolicy: { ask: [PROBE_TOOL] }, approval: true })
    stack.ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
    stack.lead.session.append('turn/start', { turn: 1 })
    const result = await callTool(stack.ctx, stack.lead, 'probe-allow', PROBE_TOOL)
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({ ok: true })
  }, 20_000)
  it('reject fails closed through the official ToolRuntime', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-perm-reject-'))
    roots.push(sandbox)
    const stack = await mount(sandbox, { toolPolicy: { ask: [PROBE_TOOL] }, approval: true })
    stack.ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('rejected'))
    stack.lead.session.append('turn/start', { turn: 1 })
    const result = await callTool(stack.ctx, stack.lead, 'probe-reject', PROBE_TOOL)
    expect(result.isError).toBe(true)
    expect((result.error as { message?: string }).message ?? '').toContain('rejected')
  }, 20_000)
  it('missing approval seam fails closed without asking', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-perm-missing-'))
    roots.push(sandbox)
    const stack = await mount(sandbox, { toolPolicy: { ask: [PROBE_TOOL] } })
    const result = await callTool(stack.ctx, stack.lead, 'probe-missing', PROBE_TOOL)
    expect(result.isError).toBe(true)
    expect((result.error as { message?: string }).message ?? '').toContain('denied by the Team tool policy')
  }, 20_000)
  it('unavailable approval fails closed through the official ToolRuntime', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-perm-unavailable-'))
    roots.push(sandbox)
    const stack = await mount(sandbox, { toolPolicy: { ask: [PROBE_TOOL] }, approval: true })
    // ApprovalService mounted, but no answerer is composed: the official
    // service resolves `unavailable`, which the ToolRuntime turns into deny.
    stack.lead.session.append('turn/start', { turn: 1 })
    const result = await callTool(stack.ctx, stack.lead, 'probe-unavailable', PROBE_TOOL)
    expect(result.isError).toBe(true)
    expect((result.error as { message?: string }).message ?? '').toContain('approval')
  }, 20_000)
  it('cancelled approval fails closed through the official ToolRuntime', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-perm-cancelled-'))
    roots.push(sandbox)
    const stack = await mount(sandbox, { toolPolicy: { ask: [PROBE_TOOL] }, approval: true })
    const controller = new AbortController()
    stack.ctx.on('approval/request', () => {
      controller.abort()
      return Promise.resolve<ApprovalOutcome>('allowed-once')
    })
    stack.lead.session.append('turn/start', { turn: 1 })
    const result = await stack.ctx.tools.execute({
      signal: controller.signal,
      callId: CallId('probe-cancelled'),
      name: PROBE_TOOL,
      arguments: {},
      agent: stack.lead,
    })
    expect(result.isError).toBe(true)
    const message = (result.error as { message?: string }).message ?? ''
    expect(message.toLowerCase()).toMatch(/cancelled|abort/)
  }, 20_000)
  it('our deny merges monotonically with a downstream next() allow (no widening)', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-perm-next-'))
    roots.push(sandbox)
    const stack = await mount(sandbox, { toolPolicy: { deny: [PROBE_TOOL] } })
    stack.ctx.on('tools/pre-execute', async (_exec, next) => {
      await next()
      return { kind: 'allow' }
    })
    const result = await callTool(stack.ctx, stack.lead, 'probe-next', PROBE_TOOL)
    expect(result.isError).toBe(true)
    expect((result.error as { message?: string }).message ?? '').toContain('denied by the Team tool policy')
  }, 20_000)
  it('delegated member ask is denied and mapped into the durable provisioning filter', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-perm-member-'))
    roots.push(sandbox)
    const stack = await mount(sandbox, { toolPolicy: { ask: [PROBE_TOOL] }, approval: true })
    const memberId = await addMember(stack)
    // The official creation-window toolFilter is the durable authority: the
    // config `ask` tool is denied for the delegated member (children are
    // approval-pinned `never`), so the member cannot even see it.
    const stored = await stack.ctx.sessionPersistence.inspect(SessionId(memberId))
    const suffix = stored.events.slice(stored.meta.seedLength ?? 0)
    const descriptor = foldSubagentDescriptor(suffix)
    expect(descriptor?.mode).toBe('continuable')
    if (descriptor?.mode !== 'continuable') throw new Error('member descriptor is not continuable')
    expect(descriptor.toolFilter).toEqual({ deny: [...CAPTAIN_ONLY_TOOLS, PROBE_TOOL] })
  }, 30_000)
  it('unrelated agents are not polluted by the Team policy', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-perm-unrelated-'))
    roots.push(sandbox)
    const stack = await mount(sandbox, { toolPolicy: { deny: [PROBE_TOOL] } })
    const unrelated = stack.ctx.agentLoop.create(
      SessionId(`perm-unrelated-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
      { provider: 'mock', model: 'mock' },
      { cwd: join(sandbox, 'unrelated-workspace') },
    )
    const result = await callTool(stack.ctx, unrelated, 'probe-unrelated', PROBE_TOOL)
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({ ok: true })
  }, 20_000)
  it('a monotonic guard can still deny after the pre-execute decision (no widening)', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-perm-guard-'))
    roots.push(sandbox)
    const stack = await mount(sandbox, { toolPolicy: { allow: [PROBE_TOOL] } })
    stack.ctx.effect(() => stack.ctx.tools.guard(() => 'guard denied after policy'), 'test guard')
    const result = await callTool(stack.ctx, stack.lead, 'probe-guard', PROBE_TOOL)
    expect(result.isError).toBe(true)
    expect((result.error as { message?: string }).message ?? '').toContain('guard denied after policy')
  }, 20_000)
})
describe('scenario 44: gateway provenance boundary over the real typed-control surface', () => {
  it('scenario 44: free text/relay do not authorize, forged/false/throwing verifier fail closed, real verifier allows, and mutations stay on TeamDomainPort', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-perm-44-'))
    roots.push(sandbox)
    const stack = await mount(sandbox)
    const memberId = await addMember(stack)
    const delegated = memberAgent(memberId, join(sandbox, 'workspace'))
    const detachDelegated = stack.ctx.agents.enter(delegated, stack.lead)
    detachAgents.push(detachDelegated)
    const initial = await snapshot(stack)
    const memberAdmission = { kind: 'captain' as const, exec: { agent: delegated, signal: SIGNAL } }
    const captainReadAdmission = { exec: { agent: stack.lead, signal: SIGNAL } }
    // Free text cannot become a typed Control: `message` is not a
    // HUMAN_INTERACTION_CONTROL_INTENT, so the gateway rejects it before any
    // mutation and without consulting any verifier.
    const freeText = controlRequest(stack, {
      intent: 'message',
      body: 'please reconsider task 4',
      expectedTeamRevision: initial.team.revision,
    })
    const freeTextError = await submitError(stack, freeText)
    expect(freeTextError.code).toBe('TEAM_INTERACTION_INVALID')
    expect((await snapshot(stack)).team.revision).toBe(initial.team.revision)
    // A relay/delegated member cannot pass itself off as the live root
    // captain — the gateway's exact-live-root resolution rejects it.
    const relay = controlRequest(stack, {
      source: { kind: 'captain-mediated', captainSessionId: memberId },
      expectedTeamRevision: initial.team.revision,
    })
    const relayError = await submitError(stack, relay)
    expect(relayError.code).toBe('TEAM_INTERACTION_CAPTAIN_REQUIRED')
    expect((await snapshot(stack)).team.revision).toBe(initial.team.revision)
    // Naming the real root in the request cannot self-mint captain authority:
    // the actual delegated caller is independently bound by object identity.
    const selfAssertedRoot = controlRequest(stack, {
      requestId: 'human-self-asserted-root-00000001',
      source: { kind: 'captain-mediated', captainSessionId: stack.lead.id },
      expectedTeamRevision: initial.team.revision,
    })
    await expect(stack.ctx.agentSwarmHumanControl.submit(
      stack.scope,
      selfAssertedRoot,
      memberAdmission,
      SIGNAL,
    )).rejects.toMatchObject({ code: 'TEAM_INTERACTION_CAPTAIN_REQUIRED' })

    // Admission runs before expiry/cancel persistence. A forged caller cannot
    // reserve global ids, cancel an existing request, or probe an unknown id.
    const receiptsBeforeForgery = await stack.ctx.agentSwarmHumanInteraction.listReceipts(
      stack.scope,
      stack.teamId,
      captainReadAdmission,
    )
    const forgedExpired = controlRequest(stack, {
      requestId: 'human-forged-expired-00000002',
      createdAt: Date.now() - 1_000,
      expiresAt: Date.now() - 1,
      expectedTeamRevision: initial.team.revision,
    })
    await expect(stack.ctx.agentSwarmHumanControl.submit(
      stack.scope,
      forgedExpired,
      memberAdmission,
      SIGNAL,
    )).rejects.toMatchObject({ code: 'TEAM_INTERACTION_CAPTAIN_REQUIRED' })
    const forgedUnknownCancel = controlRequest(stack, {
      requestId: 'human-forged-cancel-unknown-00000003',
      expectedTeamRevision: initial.team.revision,
    })
    await expect(stack.ctx.agentSwarmHumanControl.cancel(
      stack.scope,
      forgedUnknownCancel,
      memberAdmission,
    )).rejects.toMatchObject({ code: 'TEAM_INTERACTION_CAPTAIN_REQUIRED' })
    expect(await stack.ctx.agentSwarmHumanInteraction.listReceipts(
      stack.scope,
      stack.teamId,
      captainReadAdmission,
    )).toEqual(receiptsBeforeForgery)
    expect((await snapshot(stack)).team.revision).toBe(initial.team.revision)
    detachDelegated()
    // No verifier mounted: authenticated-human is refused.
    const forged = controlRequest(stack, {
      source: { kind: 'authenticated-human', captainSessionId: stack.lead.id, principalRef: 'forged-principal' },
      expectedTeamRevision: initial.team.revision,
    })
    expect((await submitError(stack, forged)).code).toBe('TEAM_INTERACTION_NO_PRINCIPAL')
    expect((await snapshot(stack)).team.revision).toBe(initial.team.revision)
    // A host verifier that returns false is still a refusal.
    const unregisterFalse = stack.ctx.agentSwarmPermission.registerHumanPrincipalVerifier({
      kind: 'human-principal-verifier',
      name: 'false-host',
      verify: async () => false,
    })
    expect((await submitError(stack, forged)).code).toBe('TEAM_INTERACTION_NO_PRINCIPAL')
    expect((await snapshot(stack)).team.revision).toBe(initial.team.revision)
    unregisterFalse()
    // A throwing host verifier fails closed to NO_PRINCIPAL, never a grant.
    const unregisterThrow = stack.ctx.agentSwarmPermission.registerHumanPrincipalVerifier({
      kind: 'human-principal-verifier',
      name: 'throw-host',
      verify: async () => { throw new Error('host verifier unavailable') },
    })
    expect((await submitError(stack, forged)).code).toBe('TEAM_INTERACTION_NO_PRINCIPAL')
    expect((await snapshot(stack)).team.revision).toBe(initial.team.revision)
    unregisterThrow()
    // A real host verifier returning true is the ONLY path to
    // authenticated-human; the resulting Control mutation still lands
    // through TeamDomainPort (durable Team mail bumps the aggregate revision).
    const unregisterTrue = stack.ctx.agentSwarmPermission.registerHumanPrincipalVerifier({
      kind: 'human-principal-verifier',
      name: 'real-host',
      verify: async (principalRef) => principalRef === 'real-principal',
    })
    const real = controlRequest(stack, {
      source: { kind: 'authenticated-human', captainSessionId: stack.lead.id, principalRef: 'real-principal' },
      expectedTeamRevision: initial.team.revision,
    })
    const receipt = await stack.ctx.agentSwarmHumanControl.submit(
      stack.scope,
      real,
      { kind: 'authenticated-human', principalRef: 'real-principal' },
      new AbortController().signal,
    )
    expect(receipt.status).toBe('executed')
    expect((await snapshot(stack)).team.revision).toBeGreaterThan(initial.team.revision)
    unregisterTrue()
    const cancelProtected = controlRequest(stack, {
      requestId: 'human-forged-cancel-existing-00000004',
      expectedTeamRevision: (await snapshot(stack)).team.revision,
    })
    const protectedReceipt = await stack.ctx.agentSwarmHumanControl.submit(
      stack.scope,
      cancelProtected,
      { kind: 'captain', exec: { agent: stack.lead, signal: SIGNAL } },
      SIGNAL,
    )
    expect(protectedReceipt.status).toBe('executed')
    await expect(stack.ctx.agentSwarmHumanControl.cancel(
      stack.scope,
      cancelProtected,
      memberAdmission,
    )).rejects.toMatchObject({ code: 'TEAM_INTERACTION_CAPTAIN_REQUIRED' })
    expect((await stack.ctx.agentSwarmHumanInteraction.listReceipts(
      stack.scope,
      stack.teamId,
      captainReadAdmission,
    )).find(item => item.requestId === cancelProtected.requestId)?.status).toBe('executed')
    // scenario-evidence: 44
  }, 30_000)
})
