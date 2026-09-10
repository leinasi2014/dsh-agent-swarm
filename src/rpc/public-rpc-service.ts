/** Public chat is writable only behind the official authenticated connection bridge. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { z } from 'zod'
import { TeamDomainError } from '../domain/error.js'
import { PUBLIC_REQUEST_ID_PATTERN, isPublicMessageV2, isPublicMessageV3, publicBindingDigest } from '../domain/public-message.js'
import { normalizePublicContent, publicContentSchema, publicMentionIds } from '../shared/public-content.js'
import type { AgentSwarmRuntime } from '../runtime/orchestrator-runtime.js'
import { publicAppendEligibility, publicRecipientEligibility } from '../runtime/public-lineage.js'
import { HostTargetReadService } from '../host/target-read-service.js'
import { PUBLIC_RPC_CHANNEL } from './public-rpc-contract.js'
import { projectPublicMessage, projectPublicHistory } from './public-rpc-projection.js'
import { handlePublicImageRpc } from './public-image-rpc.js'

const target = z.object({ rootSessionId: z.string().min(1), teamId: z.string().min(1) }).strict()
const common = { schemaVersion: z.literal(1), target }
const requestId = z.string().regex(PUBLIC_REQUEST_ID_PATTERN)
const append = z.object({ ...common, requestId, text: z.string().min(1), replyTo: z.string().min(1).optional() }).strict()
const appendV2 = z.object({ schemaVersion: z.literal(2), target, requestId, content: publicContentSchema, replyTo: z.string().min(1).optional() }).strict()
const result = z.object({ ...common, requestId }).strict()
const resultV2 = result.extend({ schemaVersion: z.literal(2) })
const directory = z.object({ schemaVersion: z.literal(2), target, limit: z.number().int().min(1).max(50).optional(), cursor: z.string().min(1).max(4096).optional() }).strict()
const history = z.object({ ...common, limit: z.number().int().min(1).max(100).default(50),
  beforeSequence: z.number().int().positive().optional(), afterSequence: z.number().int().nonnegative().optional(),
}).strict().refine(value => value.beforeSequence === undefined || value.afterSequence === undefined, 'Choose one cursor')
const historyV2 = z.object({ schemaVersion: z.literal(2), target, limit: z.number().int().min(1).max(100).default(50),
  beforeSequence: z.number().int().positive().optional(), afterSequence: z.number().int().nonnegative().optional(),
}).strict().refine(value => value.beforeSequence === undefined || value.afterSequence === undefined, 'Choose one cursor')

export function mountAgentSwarmPublicRpc(owner: Context, runtime: AgentSwarmRuntime): void {
  owner.inject(['connection', 'webServer', 'agentSwarmHostRead'], ctx => {
    const targets = new HostTargetReadService(ctx, runtime, ctx.agentSwarmHostRead)
    ctx.effect(() => ctx.connection.rpc.handle(PUBLIC_RPC_CHANNEL, async (endpoint, payload, signal) => {
      try {
        if (endpoint.startsWith('v3/')) return { ok: true, value: await handlePublicImageRpc(ctx, runtime, targets, endpoint, payload, signal) }
        const version = endpoint.startsWith('v2/') ? 2 : 1
        const operation = endpoint.slice(3)
        const schema = endpoint === 'v1/append' ? append : endpoint === 'v1/requestResult' ? result : endpoint === 'v1/history' ? history
          : endpoint === 'v2/append' ? appendV2 : endpoint === 'v2/requestResult' ? resultV2 : endpoint === 'v2/history' ? historyV2 : endpoint === 'v2/directory' ? directory : undefined
        if (schema === undefined) throw new TeamDomainError('Unknown public endpoint', 'SWARM_RPC_INVALID_REQUEST')
        const parsed = schema.safeParse(payload)
        if (!parsed.success) throw new TeamDomainError('Invalid public request', 'SWARM_RPC_INVALID_REQUEST')
        const request = parsed.data
        const value = await targets.withPublicTeam(request.target, async (scope, team, verify) => {
          if (operation === 'directory') {
            const input = directory.parse(payload)
            const projected = await runtime.directory.read(scope, team.id, {
              ...(input.limit === undefined ? {} : { limit: input.limit }), ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
            }, signal)
            await verify()
            return projected
          }
          const response = (teamRevision = team.revision) => ({ schemaVersion: version,
            binding: { rootSessionId: team.captainSessionId, teamId: team.id }, teamRevision, observedAt: Date.now() })
          if (operation === 'append') {
            const input = version === 2 ? appendV2.parse(payload) : append.parse(payload)
            const author = { kind: 'local-operator' as const }
            const identity = { author, requestId: input.requestId, ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }) }
            const body = input.schemaVersion === 2 ? { ...identity, formatVersion: 2 as const, content: normalizePublicContent(input.content) }
              : { ...identity, formatVersion: 1 as const, text: input.text.trim() }
            const existing = team.publicChat?.messages.find(row => row.author.kind === 'local-operator' && row.requestId === input.requestId)
            if (existing !== undefined) {
              await verify()
              if (isPublicMessageV3(existing) || (version === 1 && isPublicMessageV2(existing))) throw new TeamDomainError('Use the recorded public chat version for this request', 'SWARM_PUBLIC_VERSION_REQUIRED')
              if (existing.bindingDigest !== publicBindingDigest(team.id, body)) throw new TeamDomainError('Public requestId already binds another payload', 'TEAM_PUBLIC_REQUEST_CONFLICT')
              runtime.kickPublicMessages(scope, team.id)
              return { ...response(), message: projectPublicMessage(existing, version), replayed: true }
            }
            if (body.formatVersion === 1) throw new TeamDomainError('New public messages require version 2', 'SWARM_PUBLIC_VERSION_REQUIRED')
            const recipients = publicMentionIds(body.content)
            if (!await publicRecipientEligibility(ctx, scope, team, recipients, signal)) {
              throw new TeamDomainError('Public recipients require current Team identity and official lineage', 'TEAM_PUBLIC_RECIPIENT_INVALID')
            }
            await verify()
            signal.throwIfAborted()
            const committed = await runtime.domain.appendPublicMessage(scope, team.id, { ...body,
              expectedCaptainSessionId: team.captainSessionId, expectedTeamRevision: team.revision })
            runtime.kickPublicMessages(scope, team.id)
            return { ...response(committed.teamRevision), message: projectPublicMessage(committed.message, version), replayed: committed.replayed }
          }
          if (operation === 'requestResult') {
            const input = version === 2 ? resultV2.parse(payload) : result.parse(payload)
            const message = team.publicChat?.messages.find(row => row.author.kind === 'local-operator' && row.requestId === input.requestId)
            await verify()
            return message === undefined ? { ...response(), state: 'not-found' as const }
              : { ...response(), state: 'committed' as const, message: projectPublicMessage(message, version) }
          }
          const input = version === 2 ? historyV2.parse(payload) : history.parse(payload)
          const messages = team.publicChat?.messages ?? []
          const page = projectPublicHistory(messages, input, version)
          const appendEligibility = await publicAppendEligibility(ctx, scope, team, signal)
          await verify()
          return { ...response(), ...page, appendEligibility,
            limits: { maxTextBytes: runtime.config.limits.maxPublicTextBytes, maxMessages: runtime.config.limits.maxPublicMessages, maxBytes: runtime.config.limits.maxPublicBytes,
              ...(version === 2 ? { maxSegments: runtime.config.limits.maxPublicSegments } : {}) } }
        })
        return { ok: true, value }
      } catch (error) {
        return { ok: false, error: { code: error instanceof TeamDomainError ? error.code : 'SWARM_RPC_UNAVAILABLE',
          message: error instanceof TeamDomainError ? error.message : 'Public chat is unavailable', details: {} } }
      }
    }))
  })
}
