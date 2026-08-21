/**
 * Shared harness for the M2-4 Jiuwen node-mapping suite (issue #78): the
 * full official composition (AgentLoop + durable stack + continuable
 * subagents) with the swarm plugin in default adaptive mode (the mapping is
 * mode-agnostic and needs no bridge), one gated content-aware member
 * adapter whose assignment turns answer with a real `agent_swarm_submit_task`
 * call (embedding pipeline artifacts received through Team mail), and the
 * settle-flow driver that reviews every submission through the runtime's
 * review transaction.
 */
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { expect, vi } from 'vitest'
import * as AgentSwarm from '../../src/index.js'
import type { TeamTask } from '../../src/index.js'
import type { TeamDomainPort, TeamScope } from '../../src/domain/team-domain-port.js'
import { mountStorageStackOn } from './storage-stack.js'

/** Assignment-frame identity fields the member must echo in its submission. */
const ASSIGNMENT_RE = /Task: (task-[a-z0-9-]+), revision (\d+)\nAttempt capability: (\S+)/
/** Artifact marker the captain relays through quiet Team mail (pipeline leg). */
const ARTIFACT_RE = /PIPELINE-ARTIFACT:([^\s`]+)/

export const SIGNAL = new AbortController().signal

/**
 * Gated content-aware member adapter (the modes-suite shape, plus pipeline
 * artifact awareness): every model turn parks on the gate (abortable like a
 * cancelled call) and decides at release. A released turn carrying a Team
 * assignment frame answers with one real `agent_swarm_submit_task` call when
 * submission is armed; when the conversation also carries a relayed artifact
 * marker, the submission embeds it (the task-output + mailbox artifact
 * channel). Other turns answer plain text.
 */
class NodeMemberAdapter extends LlmAdapter {
  /** Every model request seen (member + captain turns; debug evidence). */
  readonly requests: GenerateOptions[] = []
  private calls = 0
  private gate: Promise<void>
  private releaseCurrent!: () => void

  constructor() {
    super()
    this.gate = new Promise<void>(resolve => { this.releaseCurrent = resolve })
  }

  /** Whether the next released assignment turn submits (`false` = park). */
  submit = false

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  /** Release the currently held turns; later turns are held again. */
  open(): void {
    const release = this.releaseCurrent
    this.gate = new Promise<void>(resolve => { this.releaseCurrent = resolve })
    release()
  }

  private conversationText(options: GenerateOptions): string {
    return options.messages
      .filter(message => message.role === 'user')
      .flatMap(message => message.content)
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('\n')
  }

  private lastUserText(options: GenerateOptions): string {
    for (let index = options.messages.length - 1; index >= 0; index -= 1) {
      const message = options.messages[index]!
      if (message.role !== 'user') continue
      return message.content
        .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('\n')
    }
    return ''
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const signal = options.signal
    if (signal !== undefined) {
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
        }
        if (signal.aborted) {
          abort()
          return
        }
        const admit = (): void => {
          signal.removeEventListener('abort', abort)
          resolve()
        }
        signal.addEventListener('abort', abort, { once: true })
        void this.gate.then(admit, admit)
      })
    } else {
      await this.gate
    }
    // Decision at release time: a flip between turns re-arms the behavior.
    const assignment = ASSIGNMENT_RE.exec(this.lastUserText(options))
    if (this.submit && assignment !== null) {
      const [, taskId, revision, attemptId] = assignment
      const artifact = ARTIFACT_RE.exec(this.conversationText(options))
      const output = artifact === null
        ? `Node member output for ${taskId}.`
        : `Node stage output for ${taskId} consuming artifact [${artifact[1]}].`
      const id = CallId(`node-submit-${(this.calls += 1)}`)
      const args = JSON.stringify({
        task_id: taskId,
        expected_revision: Number(revision),
        attempt_id: attemptId,
        output,
      })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'agent_swarm_submit_task', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'agent_swarm_submit_task', arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 24 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Member parked.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Member parked.' } }
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export interface NodeComposition {
  readonly ctx: Context
  readonly fibers: Fiber[]
  readonly adapter: NodeMemberAdapter
  readonly lead: Agent
  readonly domain: TeamDomainPort
  readonly scope: TeamScope
}

/** Mount the real composition in adaptive mode (the mapping is mode-agnostic). */
export async function mountNodeComposition(sandbox: string, config: { maxMembers?: number } = {}): Promise<NodeComposition> {
  const ctx = new Context()
  const fibers: Fiber[] = []
  await mountAgentLoopTestDependencies(ctx)
  fibers.push(await ctx.plugin(JsonlSessionPersistence, { root: join(sandbox, 'sessions') }))
  await mountStorageStackOn(ctx, join(sandbox, 'storage'))
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
  fibers.push(await ctx.plugin(SubagentService))
  fibers.push(await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }))
  fibers.push(await ctx.plugin(AgentSwarm, {
    memberProvider: 'spawn',
    memberMaxDepth: 1,
    schedulerProvider: 'priority-ready',
    reviewProvider: 'manual',
    orchestrationMode: 'adaptive',
    ...(config.maxMembers === undefined ? {} : { maxMembers: config.maxMembers }),
  }))
  const adapter = new NodeMemberAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = ctx.agentLoop.create(
    SessionId(`node-lead-${Math.random().toString(36).slice(2, 8)}`),
    { provider: 'mock', model: 'mock' },
    { cwd: join(sandbox, 'workspace') },
  )
  return {
    ctx,
    fibers,
    adapter,
    lead,
    domain: ctx.agentSwarm.domain,
    scope: ctx.agentSwarm.scopeOf(lead),
  }
}

/** Create one Team and add members through the real captain tool face. */
export async function setUpTeam(composition: NodeComposition, members: string[]): Promise<string> {
  const created = await composition.ctx.tools.execute({
    signal: SIGNAL,
    callId: CallId('node-create'),
    name: 'agent_swarm_create',
    arguments: { name: 'Node mapping team', description: 'Prove the Jiuwen node mapping over the board.' },
    agent: composition.lead,
  })
  if (created.isError) throw new Error(`create failed: ${JSON.stringify(created.error)}`)
  const teamId = (created.value as { team_id: string }).team_id
  for (const name of members) {
    const added = await composition.ctx.tools.execute({
      signal: SIGNAL,
      callId: CallId(`node-add-${name}`),
      name: 'agent_swarm_add_member',
      arguments: { name, role: 'Exercise the node mapping.' },
      agent: composition.lead,
    })
    if (added.isError) throw new Error(`add_member ${name} failed: ${JSON.stringify(added.error)}`)
  }
  return teamId
}

/** The authoritative task row of one task id. */
export async function taskOf(composition: NodeComposition, teamId: string, taskId: string): Promise<TeamTask> {
  const snapshot = await composition.domain.snapshot(composition.scope, AgentSwarm.TeamId(teamId), composition.lead.id)
  const task = snapshot.team.tasks.find(candidate => candidate.id === taskId)
  if (task === undefined) throw new Error(`task ${taskId} not found`)
  return task
}

/** Ready flag of one task straight from the authoritative snapshot. */
export async function readyOf(composition: NodeComposition, teamId: string, taskId: string): Promise<boolean> {
  const snapshot = await composition.domain.snapshot(composition.scope, AgentSwarm.TeamId(teamId), composition.lead.id)
  const task = snapshot.team.tasks.find(candidate => candidate.id === taskId)
  if (task === undefined) throw new Error(`task ${taskId} not found`)
  return task.blockedBy.every(id => snapshot.team.tasks.find(candidate => candidate.id === id)?.status === 'completed')
}

/** Assert one async call rejects with the exact structured domain code. */
export async function expectDomainCode(promise: Promise<unknown>, code: string): Promise<unknown> {
  const error: unknown = await promise.then(
    () => { throw new Error(`expected a TeamDomainError with code ${code}, got a resolution`) },
    (failure: unknown) => failure,
  )
  expect(error).toBeInstanceOf(AgentSwarm.TeamDomainError)
  expect((error as AgentSwarm.TeamDomainError).code).toBe(code)
  return error
}

/**
 * Drive the adaptive flow to completion: release held member/captain turns,
 * and review every task that reaches the gate through the runtime's review
 * transaction (the captain face). `decide` maps (taskId, submissionRound) to
 * the review decision — the human leg of the human-gate tests. Returns the
 * sampled in-flight peak (fan-out backpressure evidence).
 */
export async function settleFlow(
  composition: NodeComposition,
  teamId: string,
  taskIds: readonly string[],
  decide: (taskId: string, round: number) => { decision: 'accept' | 'reject'; diagnostic?: string },
): Promise<{ peakInFlight: number }> {
  const rounds = new Map<string, number>()
  const reviewed = new Set<string>()
  let peakInFlight = 0
  await vi.waitFor(async () => {
    composition.adapter.open()
    await new Promise(resolve => setTimeout(resolve, 120))
    const snapshot = await composition.domain.snapshot(composition.scope, AgentSwarm.TeamId(teamId), composition.lead.id)
    peakInFlight = Math.max(peakInFlight, snapshot.team.tasks.filter(task => task.status === 'in_progress').length)
    for (const task of snapshot.team.tasks) {
      if ((task.status === 'submitted' || task.status === 'verifying') && !reviewed.has(`${task.id}#${task.revision}`)) {
        reviewed.add(`${task.id}#${task.revision}`)
        const round = (rounds.get(task.id) ?? 0) + 1
        rounds.set(task.id, round)
        const { decision, diagnostic } = decide(task.id, round)
        await composition.ctx.agentSwarm.reviewTask(
          { agent: composition.lead, signal: SIGNAL },
          {
            taskId: task.id,
            expectedRevision: task.revision,
            attemptId: task.currentAttemptId!,
            decision,
            ...(diagnostic === undefined ? {} : { diagnostic }),
          },
        )
      }
    }
    for (const taskId of taskIds) {
      const task = snapshot.team.tasks.find(candidate => candidate.id === taskId)
      if (task === undefined) throw new Error(`task ${taskId} missing`)
      expect(['failed', 'cancelled']).not.toContain(task.status)
    }
    const allDone = taskIds.every(taskId => {
      const task = snapshot.team.tasks.find(candidate => candidate.id === taskId)
      return task?.status === 'completed'
    })
    expect(allDone).toBe(true)
  }, { timeout: 15_000 })
  return { peakInFlight }
}
