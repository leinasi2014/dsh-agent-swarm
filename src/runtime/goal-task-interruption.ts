/** Exact old-turn cancellation captured inside the canonical Team transaction. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { TaskAttempt, TeamState, TeamTask } from '../domain/types.js'

export interface TaskInterruptionResult {
  state: 'not-needed' | 'requested' | 'skipped' | 'failed' | 'not-repeated'
  reason?: 'no-active-attempt' | 'captain-self' | 'not-live' | 'unproven-attempt' | 'execution-changed' | 'interrupt-failed'
}

function activeTurn(events: readonly SessionEvent[]): { seq: number; turn: number } | undefined {
  let current: { seq: number; turn: number } | undefined
  for (const event of events) {
    if (event.type === 'turn/start') current = { seq: event.seq, turn: event.data.turn }
    else if (event.type === 'turn/end' && current?.turn === event.data.turn) current = undefined
  }
  return current
}

/** Only plugin assignment input or successful official claim facts bind a turn. */
function ownsAttempt(events: readonly SessionEvent[], start: { seq: number; turn: number }, team: TeamState, task: TeamTask, attempt: TaskAttempt): boolean {
  const calls = new Set<string>()
  const claims = new Set<string>()
  const code = new Map<string, { root: string; parent: string }>()
  const matches = (content: readonly { type: string; text?: string }[]): boolean => content.some(block => {
    if (block.type !== 'text' || block.text === undefined) return false
    const claimed = /^Claimed ([^\s]+) revision \d+; attempt=([^\s]+) generation=\d+\./.exec(block.text)
    if (claimed?.[1] === task.id && claimed[2] === attempt.id) return true
    try {
      const value: unknown = JSON.parse(block.text)
      return typeof value === 'object' && value !== null && 'task_id' in value && 'attempt_id' in value
        && value.task_id === task.id && value.attempt_id === attempt.id
    } catch { return false }
  })
  for (const event of events) {
    if (event.seq <= start.seq) continue
    if (event.type === 'user/message' && event.data.source.kind === 'plugin' && event.data.source.plugin === 'dsh-agent-swarm') {
      for (const block of event.data.content) {
        if (block.type !== 'text') continue
        const match = /^Team assignment from captain\.\n\nTeam: ([^\s]+)\nTask: ([^\s,]+), revision \d+\nAttempt capability: ([^\s]+)\n/.exec(block.text)
        if (match?.[1] === team.id && match[2] === task.id && match[3] === attempt.id) return true
      }
    }
    if (event.type === 'tool/call' && event.data.turn === start.turn
      && ['agent_swarm_claim_task', 'run_code'].includes(event.data.name)) calls.add(event.data.callId)
    if (event.type === 'tool/call' && event.data.turn === start.turn && event.data.name === 'agent_swarm_claim_task') claims.add(event.data.callId)
    if (event.type === 'tool/ptc-dispatch-start' && event.data.name === 'agent_swarm_claim_task' && calls.has(event.data.rootCallId)) {
      code.set(event.data.subCallId, { root: event.data.rootCallId, parent: event.data.parentCallId })
    }
    if (event.type === 'tool/ptc-dispatch') {
      const claim = code.get(event.data.subCallId)
      code.delete(event.data.subCallId)
      if (claim?.root === event.data.rootCallId && claim?.parent === event.data.parentCallId
        && !event.data.isError && matches(event.data.content)) return true
    }
    if (event.type === 'tool/result' && event.data.turn === start.turn && calls.has(event.data.message.source.callId)) {
      const result = event.data.message.content[0]
      if (result.isError) continue
      if (claims.has(event.data.message.source.callId) && matches(result.content)) return true
    }
  }
  return false
}

/** The returned callback must run synchronously after durable write, before Team unlock. */
export function captureTaskInterruption(ctx: Context, captain: Agent, team: TeamState, task: TeamTask,
  attempt: TaskAttempt | undefined, result: TaskInterruptionResult): (() => void) | undefined {
  if (attempt === undefined || task.ownerSessionId === undefined || task.currentAttemptId !== attempt.id
    || attempt.memberSessionId !== task.ownerSessionId || attempt.taskId !== task.id || attempt.phase !== 'running') {
    Object.assign(result, { state: 'not-needed', reason: 'no-active-attempt' }); return undefined
  }
  if (task.ownerSessionId === captain.id) { Object.assign(result, { state: 'skipped', reason: 'captain-self' }); return undefined }
  const agent = ctx.agents.get(SessionId(task.ownerSessionId)), session = agent?.session
  if (agent === undefined || session === undefined || agent.status !== 'running' || ctx.sessions.get(agent.id) !== session
    || session.header.parentSession !== captain.id) {
    Object.assign(result, { state: 'skipped', reason: 'not-live' }); return undefined
  }
  const events = session.snapshotEvents(), turn = activeTurn(events)
  if (turn === undefined || !ownsAttempt(events, turn, team, task, attempt)) {
    Object.assign(result, { state: 'skipped', reason: 'unproven-attempt' }); return undefined
  }
  return () => {
    const current = activeTurn(session.snapshotEvents())
    if (ctx.agents.get(captain.id) !== captain || ctx.sessions.get(captain.id) !== captain.session
      || ctx.agents.get(agent.id) !== agent || ctx.sessions.get(agent.id) !== session || agent.session !== session
      || agent.status !== 'running' || current?.seq !== turn.seq || current.turn !== turn.turn) {
      Object.assign(result, { state: 'skipped', reason: 'execution-changed' }); return
    }
    try {
      // Official interrupt preserves the existing ancestry check. No await can
      // put a successor between this exact identity check and the SDK call.
      ctx.subagents.interrupt(agent.id, { kind: 'ancestor', agent: captain })
      Object.assign(result, { state: 'requested' }); delete result.reason
    } catch {
      Object.assign(result, { state: 'failed', reason: 'interrupt-failed' })
    }
  }
}
