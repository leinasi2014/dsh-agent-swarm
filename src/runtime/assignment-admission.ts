/** Revalidate parked assignment capabilities at the official model admission boundary. */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { AgentSwarmRuntime } from './orchestrator-runtime.js'

const PREFIX = 'Team assignment from captain.\n\n'

/** Only plugin-authored assignment envelopes belong to this boundary. */
function assignmentHeader(message: UserMessage): string | undefined {
  if (message.source.kind !== 'plugin' || message.source.plugin !== 'dsh-agent-swarm') return undefined
  for (const block of message.content) {
    if (block.type === 'text' && block.text.startsWith(PREFIX)) return block.text
  }
  return undefined
}

/** Lifetime-owned, stateless consumer of the canonical Team domain. */
export function installAssignmentAdmission(ctx: Context, runtime: AgentSwarmRuntime): () => void {
  return ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const assignments = decision.messages.flatMap(message => {
      const header = assignmentHeader(message)
      return header === undefined ? [] : [{ message, header }]
    })
    if (assignments.length === 0) return decision
    signal.throwIfAborted()
    // Read after downstream admission awaits; neither inbox admission nor an
    // old task revision is execution authority. Delivery acknowledgements and
    // other aggregate writes may leave this very same attempt valid.
    const membership = await runtime.domain.findMembership(runtime.scopeOf(agent), agent.id)
    signal.throwIfAborted()
    const team = membership?.team
    const removed = new Set<string>()
    for (const { message, header } of assignments) {
      const match = /^Team assignment from captain\.\n\nTeam: ([^\s]+)\nTask: ([^\s,]+), revision \d+\nAttempt capability: ([^\s]+)\n/.exec(header)
      const task = team?.tasks.find(candidate => candidate.id === match?.[2])
      const attempt = team?.attempts.find(candidate => candidate.id === match?.[3])
      if (match === null || membership?.role !== 'member' || team === undefined || team.id !== match[1] || team.phase !== 'active'
        || !team.members.some(member => member.sessionId === agent.id && member.phase === 'active')
        || task?.status !== 'in_progress' || task.ownerSessionId !== agent.id || task.currentAttemptId !== match[3]
        || attempt?.taskId !== task.id || attempt.memberSessionId !== agent.id || attempt.phase !== 'running') {
        removed.add(message.id)
      }
    }
    if (removed.size === 0) return decision
    ctx.logger.info(`agent-swarm: suppressed ${removed.size} expired assignment(s) before model admission for ${agent.id}`)
    const retained = decision.messages.filter(message => !removed.has(message.id))
    // Respect additions by other admission plugins as well as the claimed
    // inbox batch. The official passive runtime-context snapshot alone must
    // not ask the model to continue its previous task from history.
    const hasInput = retained.some(message => message.source.kind !== 'plugin' || message.source.plugin !== '@deepseek-ai/dsh-system-prompt')
    if (!hasInput) {
      if (agent.inbox.nextTurn.length === 0 && agent.inbox.nextStep.length === 0) return { kind: 'reject' }
      // The official reject/empty-initial-step paths stop the driver even
      // when another turn is queued. A logged cancellation notice lets that
      // turn end normally and the official loop claim its queued successor.
      // No old task data or attempt capability is forwarded to the model.
      return { ...decision, messages: [...retained, createUserMessage({
        source: { kind: 'plugin', plugin: 'dsh-agent-swarm' },
        content: [{ type: 'text', text: 'An expired queued Team assignment was discarded after checking the current task board. Do not repeat earlier assignment work or call tools for this discarded assignment. End this turn; the remaining queued messages will follow.' }],
      })] }
    }
    return { ...decision, messages: retained }
  }, { prepend: true })
}
