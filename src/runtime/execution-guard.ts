/** Bounded, disposable observation of official execution facts for Team Agents. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TextProgress } from './execution-guard-text.js'
import { fingerprint, requestIdentity, ToolProgress, type ToolObservation } from './execution-guard-tools.js'
import type { AgentSwarmRuntime } from './orchestrator-runtime.js'

type Identity = Pick<ToolObservation, 'request' | 'name' | 'read'>
type CodeCall = Identity & { root: string; parent: string; unknown: boolean }

type State = {
  turn: number
  text: TextProgress
  progress: ToolProgress
  calls: Map<string, Identity>
  code: Map<string, CodeCall>
  transports: Set<string>
  seq: number
  warning?: string
  critical: boolean
  streamRevision: number
  stream?: { attemptId: string; nextIndex: number }
}

export function installExecutionGuard(ctx: Context, runtime: AgentSwarmRuntime): () => void {
  const states = new Map<Agent, State>()
  let closed = false
  const current = (agent: Agent, state: State): boolean => !closed && states.get(agent) === state
    && ctx.agents.get(agent.id) === agent && ctx.sessions.get(agent.id) === agent.session
  const contain = (agent: Agent, state: State, reason: string): void => {
    if (state.critical) return
    state.critical = true
    // Session publication cannot be reentered. Cancel only after that boundary
    // retires, rechecking the exact live turn; preserve all admitted inbox work.
    queueMicrotask(() => {
      if (current(agent, state) && agent.status === 'running') {
        agent.cancel({ kind: 'hook', reason: `Execution guard CRITICAL: ${reason}` }, { keepInbox: true })
      }
    })
  }
  const completed = (agent: Agent, state: State, observation: ToolObservation): void => {
    for (const notice of state.progress.observe(observation)) {
      const reason = `${notice.detector}: ${notice.count} repeated observations; change approach or request guidance.`
      if (notice.level === 'CRITICAL') contain(agent, state, reason)
      else state.warning = reason
    }
  }
  const observe = (agent: Agent, state: State, event: SessionEvent): void => {
    if (event.type === 'step/start') state.text = new TextProgress()
    if (event.type === 'tool/ptc-dispatch-start') {
      const { rootCallId, parentCallId, subCallId, name, arguments: args } = event.data
      const root = fingerprint(rootCallId)
      const parent = fingerprint(parentCallId)
      const key = fingerprint(subCallId)
      if (root === undefined || parent === undefined || key === undefined || !state.calls.has(root) || state.code.size >= 128) return
      state.code.set(key, { ...requestIdentity(name, args), root, parent, unknown: false })
    } else if (event.type === 'tool/ptc-dispatch') {
      const key = fingerprint(event.data.subCallId)
      if (key === undefined) return
      const call = state.code.get(key)
      state.code.delete(key)
      if (call === undefined || call.root !== fingerprint(event.data.rootCallId)
        || call.parent !== fingerprint(event.data.parentCallId) || !state.calls.has(call.root)) return
      if (state.transports.size < 128) state.transports.add(call.parent)
      if (state.transports.delete(key)) return
      completed(agent, state, { ...call, result: fingerprint(event.data.content), failed: event.data.isError })
    } else if (event.type === 'tool/result' && event.data.turn === state.turn) {
      const key = fingerprint(event.data.message.source.callId)
      if (key === undefined) return
      const call = state.calls.get(key)
      state.calls.delete(key)
      for (const [subKey, pending] of state.code) if (pending.root === key) state.code.delete(subKey)
      if (call === undefined || state.transports.delete(key)) return
      const result = event.data.message.content[0]
      completed(agent, state, { ...call, result: fingerprint(result.content),
        failed: result.isError === true, unknown: event.data.error?.code === 'UNKNOWN_TOOL' })
    }
  }
  const off = [
    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      const state = states.get(agent)
      if (state === undefined || !current(agent, state) || state.critical) return
      if (frame.type === 'start') {
        if (frame.turn !== state.turn || frame.revision <= state.streamRevision) return
        state.streamRevision = frame.revision
        state.stream = { attemptId: frame.attemptId, nextIndex: 0 }
        state.text = new TextProgress()
        return
      }
      const stream = state.stream
      if (stream === undefined || stream.attemptId !== frame.attemptId || frame.revision <= state.streamRevision) return
      if (frame.type === 'end') { state.streamRevision = frame.revision; delete state.stream; return }
      if (frame.index !== stream.nextIndex) return
      state.streamRevision = frame.revision
      stream.nextIndex++
      if (frame.chunk.type !== 'text-delta') return
      for (const notice of state.text.feed(frame.chunk.text)) {
        const reason = `visible-text: ${notice.count} exact periodic repeats; stop repeating announcements and change approach.`
        if (notice.level === 'CRITICAL') contain(agent, state, reason)
        else state.warning = reason
      }
    }),
    ctx.on('tools/result', (execution, result) => {
      const agent = execution.agent
      if (agent === undefined || execution.parent === undefined || execution.rootCallId === undefined) return undefined
      const state = states.get(agent)
      const key = fingerprint(execution.callId)
      if (state === undefined || !current(agent, state) || key === undefined) return undefined
      const call = state.code.get(key)
      if (call !== undefined && call.root === fingerprint(execution.rootCallId)
        && call.request !== undefined && call.request === requestIdentity(execution.name, execution.arguments).request) {
        call.unknown = result.isError && result.error.info?.code === 'UNKNOWN_TOOL'
      }
      return undefined
    }),
    ctx.on('agent/pre-step', async ({ agent, turn, signal }, next) => {
      const decision = await next()
      if (closed || signal.aborted || decision.kind === 'reject') return decision
      let state = states.get(agent)
      if (state === undefined) {
        const membership = await runtime.domain.findAccountingMembership(runtime.scopeOf(agent), agent.id)
        // Accounting lookup includes provisioning and historical Sessions. Only
        // the current active Team identity grants this execution boundary.
        const team = membership?.team
        const owned = team?.phase === 'active' && (team.captainSessionId === agent.id
          || team.members.some(member => member.sessionId === agent.id && (member.phase === 'active' || member.phase === 'provisioning')))
        if (!owned || closed || signal.aborted || ctx.agents.get(agent.id) !== agent) return decision
        state = { turn, text: new TextProgress(), progress: new ToolProgress(), calls: new Map(), code: new Map(), transports: new Set(), seq: agent.session.seq - 1, critical: false, streamRevision: 0 }
        states.set(agent, state)
      }
      if (!current(agent, state) || state.turn !== turn || state.critical || state.warning === undefined) return decision
      const warning = state.warning
      delete state.warning
      return { kind: 'enter', messages: [...decision.messages, createUserMessage({
        content: [{ type: 'text', text: `Execution guard WARNING: ${warning}` }],
        source: { kind: 'plugin', plugin: 'dsh-agent-swarm', form: 'notice', summary: 'Execution guard detected repeated work.' },
      })] }
    }),
    ctx.on('session/event', (session, event) => {
      const agent = ctx.agents.get(session.id)
      if (agent === undefined || agent.session !== session) return
      const state = states.get(agent)
      if (state === undefined || !current(agent, state)) return
      if (event.type === 'turn/end' || event.type === 'turn/start') { states.delete(agent); return }
      if (event.seq <= state.seq || state.critical) return
      state.seq = event.seq
      if (event.type === 'tool/call' && event.data.turn === state.turn) {
        const key = fingerprint(event.data.callId)
        if (key !== undefined && state.calls.size < 128) {
          let args: unknown
          try { args = event.data.arguments.length <= 65_536 ? JSON.parse(event.data.arguments) : undefined }
          catch { args = event.data.arguments }
          state.calls.set(key, requestIdentity(event.data.name, args))
        }
      }
      observe(agent, state, event)
    }),
    ctx.on('agent/disposed', ({ agent }) => { states.delete(agent) }),
  ]
  return () => { closed = true; for (const dispose of off) dispose(); states.clear() }
}
