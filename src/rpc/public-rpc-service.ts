/** Public chat is writable only behind the official authenticated connection bridge. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { z } from 'zod'
import { TeamDomainError } from '../domain/error.js'
import { PUBLIC_REQUEST_ID_PATTERN, type TeamPublicMessage } from '../domain/public-message.js'
import type { AgentSwarmRuntime } from '../runtime/orchestrator-runtime.js'
import { publicAppendEligibility } from '../runtime/public-lineage.js'
import { HostTargetReadService } from '../host/target-read-service.js'
import { PUBLIC_RPC_CHANNEL } from './public-rpc-contract.js'

export { PUBLIC_RPC_CHANNEL } from './public-rpc-contract.js'
const target = z.object({ rootSessionId: z.string().min(1), teamId: z.string().min(1) }).strict()
const common = { schemaVersion: z.literal(1), target }
const requestId = z.string().regex(PUBLIC_REQUEST_ID_PATTERN)
const append = z.object({ ...common, requestId, text: z.string().min(1), replyTo: z.string().min(1).optional() }).strict()
const result = z.object({ ...common, requestId }).strict()
const history = z.object({ ...common, limit: z.number().int().min(1).max(100).default(50),
  beforeSequence: z.number().int().positive().optional(), afterSequence: z.number().int().nonnegative().optional(),
}).strict().refine(value => value.beforeSequence === undefined || value.afterSequence === undefined, 'Choose one cursor')

/** An explicit allowlist; immutable frames and request credentials stay Host-side. */
export function projectPublicMessage(message: TeamPublicMessage) {
  const delivery = message.delivery
  return { id: message.id, sequence: message.sequence, createdAt: message.createdAt, author: message.author, text: message.text,
    ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
    delivery: delivery.state === 'not-requested' ? { state: 'not-requested' as const }
      : { state: delivery.state, recipientSessionId: delivery.recipientSessionId,
          ...(delivery.state === 'claimed' ? { claimedAt: delivery.claimedAt } : {}) } }
}

export function mountAgentSwarmPublicRpc(owner: Context, runtime: AgentSwarmRuntime): void {
  owner.inject(['connection', 'webServer', 'agentSwarmHostRead'], ctx => {
    const targets = new HostTargetReadService(ctx, runtime, ctx.agentSwarmHostRead)
    ctx.effect(() => ctx.connection.rpc.handle(PUBLIC_RPC_CHANNEL, async (endpoint, payload, signal) => {
      try {
        const schema = endpoint === 'v1/append' ? append : endpoint === 'v1/requestResult' ? result : endpoint === 'v1/history' ? history : undefined
        if (schema === undefined) throw new TeamDomainError('Unknown public endpoint', 'SWARM_RPC_INVALID_REQUEST')
        const parsed = schema.safeParse(payload)
        if (!parsed.success) throw new TeamDomainError('Invalid public request', 'SWARM_RPC_INVALID_REQUEST')
        const request = parsed.data
        const value = await targets.withPublicTeam(request.target, async (scope, team, verify) => {
          const response = (teamRevision = team.revision) => ({ schemaVersion: 1 as const,
            binding: { rootSessionId: team.captainSessionId, teamId: team.id }, teamRevision, observedAt: Date.now() })
          if (endpoint === 'v1/append') {
            const input = append.parse(payload)
            const eligibility = await publicAppendEligibility(ctx, scope, team, signal)
            if (eligibility.state !== 'available') throw new TeamDomainError(`Public append unavailable: ${eligibility.reason}`, 'TEAM_PUBLIC_UNSUPPORTED')
            await verify()
            signal.throwIfAborted()
            const committed = await runtime.domain.appendPublicMessage(scope, team.id, { author: { kind: 'local-operator' },
              requestId: input.requestId, text: input.text, ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
              expectedCaptainSessionId: team.captainSessionId, expectedTeamRevision: team.revision })
            runtime.kickPublicMessages(scope, team.id)
            return { ...response(committed.teamRevision), message: projectPublicMessage(committed.message), replayed: committed.replayed }
          }
          if (endpoint === 'v1/requestResult') {
            const input = result.parse(payload)
            const message = team.publicChat?.messages.find(row => row.author.kind === 'local-operator' && row.requestId === input.requestId)
            await verify()
            return message === undefined ? { ...response(), state: 'not-found' as const }
              : { ...response(), state: 'committed' as const, message: projectPublicMessage(message) }
          }
          const input = history.parse(payload)
          const messages = team.publicChat?.messages ?? []
          const eligible = messages.filter(row => (input.beforeSequence === undefined || row.sequence < input.beforeSequence)
            && (input.afterSequence === undefined || row.sequence > input.afterSequence))
          const entries = (input.afterSequence === undefined ? eligible.slice(-input.limit) : eligible.slice(0, input.limit)).map(projectPublicMessage)
          const first = entries[0]?.sequence, last = entries.at(-1)?.sequence
          const appendEligibility = await publicAppendEligibility(ctx, scope, team, signal)
          await verify()
          return { ...response(), entries, appendEligibility, totalCount: messages.length, returnedCount: entries.length, limit: input.limit,
            hasEarlier: first === undefined ? messages.some(row => row.sequence < (input.beforeSequence ?? 0)) : messages.some(row => row.sequence < first),
            hasMore: last === undefined ? messages.some(row => row.sequence > (input.afterSequence ?? Number.MAX_SAFE_INTEGER)) : messages.some(row => row.sequence > last),
            ...(first === undefined ? {} : { firstSequence: first, lastSequence: last }),
            limits: { maxTextBytes: runtime.config.limits.maxPublicTextBytes, maxMessages: runtime.config.limits.maxPublicMessages, maxBytes: runtime.config.limits.maxPublicBytes } }
        })
        return { ok: true, value }
      } catch (error) {
        return { ok: false, error: { code: error instanceof TeamDomainError ? error.code : 'SWARM_RPC_UNAVAILABLE',
          message: error instanceof TeamDomainError ? error.message : 'Public chat is unavailable', details: {} } }
      }
    }))
  })
}
