import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { TeamDomainError } from '../domain/error.js'
import type { AgentSwarmRuntime } from './orchestrator-runtime.js'

export const CAPTAIN_APPROVAL_TOOL = 'agent_swarm_decide_tool_approval'
const MAX_PENDING = 64
const TIMEOUT_MS = 300_000
const MAX_ARGUMENT_BYTES = 16_384

interface PendingApproval {
  readonly captain: Agent
  readonly valid: () => Promise<boolean>
  readonly finish: (allowed: boolean) => void
  readonly drained: Promise<void>
  deciding: boolean
}

/** Invocation-local gates only. The mailbox and official tool results own the audit. */
export class CaptainToolApproval {
  private readonly pending = new Map<string, PendingApproval>()
  private closed = false
  constructor(private readonly ctx: Context, private readonly runtime: AgentSwarmRuntime) {}

  async dispose(): Promise<void> {
    this.closed = true
    const requests = [...this.pending.values()]
    for (const request of requests) request.finish(false)
    await Promise.all(requests.map(request => request.drained))
  }

  private openTurn(agent: Agent) {
    return this.ctx.get('sessionProjections')?.stateOf(agent.session, 'turnBoundary')?.openTurnStartSeq ?? null
  }

  async request(exec: ToolExecution): Promise<boolean> {
    const member = exec.agent
    if (this.closed || member === undefined || exec.signal.aborted || this.pending.size >= MAX_PENDING) return false
    const session = member.session
    const scope = this.runtime.scopeOf(member)
    const turn = this.openTurn(member)
    const membership = await this.runtime.domain.findMembership(scope, member.id)
    if (turn === null || membership?.role !== 'member' || membership.team.phase !== 'active') return false
    const teamId = membership.team.id
    const captain = this.ctx.agents.get(SessionId(membership.team.captainSessionId))
    if (captain === undefined || session.header.parentSession !== captain.id) return false
    const captainSession = captain.session
    if (!this.ctx.tools.schemas(captain).some(tool => tool.name === CAPTAIN_APPROVAL_TOOL)) return false
    const definition = this.ctx.tools.get(exec.name, member)
    if (definition === undefined) return false
    const { token, callId, rootCallId, arguments: args, name } = exec
    const argumentJson = JSON.stringify(args)
    if (Buffer.byteLength(argumentJson, 'utf8') > MAX_ARGUMENT_BYTES) return false
    const requestId = randomUUID()
    const controller = new AbortController()
    let settled = false
    let finish!: (allowed: boolean) => void
    const answer = new Promise<boolean>(resolve => {
      finish = allowed => {
        if (!allowed) controller.abort()
        if (settled) return
        settled = true
        resolve(allowed)
      }
    })
    const sameInvocation = (): boolean => !(this.closed || exec.signal.aborted || controller.signal.aborted
        || this.ctx.agents.get(member.id) !== member || member.session !== session
        || this.ctx.agents.get(captain.id) !== captain || captain.session !== captainSession
        || session.header.parentSession !== captain.id || this.openTurn(member) !== turn
        || this.runtime.scopeOf(member) !== scope || this.runtime.scopeOf(captain) !== scope
        || exec.token !== token || exec.callId !== callId || exec.rootCallId !== rootCallId
        || exec.arguments !== args || exec.name !== name || JSON.stringify(args) !== argumentJson
        || this.ctx.tools.get(name, member) !== definition)
    const valid = async (): Promise<boolean> => {
      if (!sameInvocation()) return false
      const current = await this.runtime.domain.findMembership(scope, member.id)
      return current?.role === 'member' && current.team.id === teamId
        && current.team.phase === 'active' && current.team.captainSessionId === captain.id
        && sameInvocation()
    }
    const cancel = () => { finish(false) }
    exec.signal.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(cancel, TIMEOUT_MS)
    timer.unref?.()
    let drain!: () => void
    const drained = new Promise<void>(resolve => { drain = resolve })
    if (this.closed || this.pending.size >= MAX_PENDING) {
      clearTimeout(timer)
      exec.signal.removeEventListener('abort', cancel)
      return false
    }
    this.pending.set(requestId, { captain, valid, finish, drained, deciding: false })
    try {
      if (!await valid()) return false
      const message = await this.runtime.sendMessage({ agent: member, signal: controller.signal }, 'captain', JSON.stringify({
        type: 'member_tool_approval', request_id: requestId, member: membership.name,
        tool: name, arguments: args, call_id: callId, root_call_id: rootCallId,
        instruction: `Review this exact call, then use ${CAPTAIN_APPROVAL_TOOL} with approve or deny. A normal message cannot approve. This request expires and never authorizes another call.`,
      }), 'wakeup')
      if (message.phase !== 'delivered') return false
      return await answer && await valid()
    } catch {
      return false
    } finally {
      finish(false)
      controller.abort()
      clearTimeout(timer)
      exec.signal.removeEventListener('abort', cancel)
      this.pending.delete(requestId)
      drain()
    }
  }

  async decide(exec: ToolExecution, requestId: string, decision: 'approve' | 'deny'): Promise<void> {
    const request = this.pending.get(requestId)
    if (request === undefined || request.deciding || this.closed || exec.signal.aborted
      || exec.agent !== request.captain || this.ctx.agents.get(request.captain.id) !== request.captain
      || this.openTurn(request.captain) === null) {
      throw new TeamDomainError('No pending tool approval owned by this live Captain', 'TEAM_TOOL_APPROVAL_UNAVAILABLE')
    }
    const decisionTurn = this.openTurn(request.captain)
    request.deciding = true
    try {
      if (!await request.valid() || exec.signal.aborted || this.ctx.agents.get(request.captain.id) !== exec.agent
        || this.openTurn(request.captain) !== decisionTurn) {
        throw new TeamDomainError('The member tool invocation is no longer current', 'TEAM_TOOL_APPROVAL_STALE')
      }
      request.finish(decision === 'approve')
    } catch (error) {
      request.finish(false)
      throw error
    }
  }
}
