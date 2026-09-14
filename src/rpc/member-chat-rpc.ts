/** Local operator command on the official authenticated Connection; never a model tool. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { TeamDomainError } from '../domain/error.js'
import { HostTargetReadService } from '../host/target-read-service.js'
import type { AgentSwarmRuntime } from '../runtime/orchestrator-runtime.js'
import { MEMBER_CHAT_CHANNEL, memberChatPromptSchema, memberChatTargetRequestSchema } from '../shared/member-chat.js'

export function mountMemberChatRpc(owner: Context, runtime: AgentSwarmRuntime): void {
  owner.inject(['connection', 'webServer', 'agentSwarmHostRead'], ctx => {
    const targets = new HostTargetReadService(ctx, runtime, ctx.agentSwarmHostRead)
    ctx.effect(() => ctx.connection.rpc.handle(MEMBER_CHAT_CHANNEL, async (endpoint, payload, signal) => {
      try {
        const current = AbortSignal.any([signal, runtime.closingSignal])
        current.throwIfAborted()
        let value: unknown
        if (endpoint === 'target') {
          const request = memberChatTargetRequestSchema.safeParse(payload)
          if (!request.success) throw new TeamDomainError('Invalid member chat target', 'SWARM_RPC_INVALID_REQUEST')
          const view = await targets.teams(request.data.sessionId)
          if (view.binding.mainSessionId === undefined || view.binding.currentTeamId === undefined) {
            throw new TeamDomainError('This Session is not a managed member', 'SWARM_MEMBER_CHAT_UNAVAILABLE')
          }
          value = await targets.withOperatorTeam({ rootSessionId: view.binding.mainSessionId, teamId: view.binding.currentTeamId },
            binding => runtime.memberChat.target(binding, request.data.sessionId, current))
        } else if (endpoint === 'prompt') {
          const request = memberChatPromptSchema.safeParse(payload)
          if (!request.success) throw new TeamDomainError('Invalid member chat prompt', 'SWARM_RPC_INVALID_REQUEST')
          value = await runtime.memberChat.prompt(request.data,
            () => targets.withOperatorTeam(request.data.target, async binding => binding), current)
        } else throw new TeamDomainError('Unknown member chat endpoint', 'SWARM_RPC_INVALID_REQUEST')
        return { ok: true, value }
      } catch (error) {
        const remote = remoteErrorOf(error)
        return { ok: false, error: { code: error instanceof TeamDomainError ? error.code : remote?.code ?? 'SWARM_MEMBER_CHAT_UNAVAILABLE',
          message: error instanceof TeamDomainError ? error.message : remote?.message ?? 'Member chat is unavailable', details: {} } }
      }
    }))
  })
}
