/** Per-send continuation ownership; official Sessions remain the private conversation authority. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentPromptRequestId } from '@deepseek-ai/dsh-subagent'
import { TeamDomainError } from '../domain/error.js'
import { publicManagedParent } from '../domain/public-message.js'
import type { TeamId } from '../domain/types.js'
import type { MemberChatPrompt, MemberChatPromptResult, MemberChatTarget } from '../shared/member-chat.js'
import type { RetirementBinding } from './team-retirement.js'
import { publicRecipientEligibility } from './public-lineage.js'
import { withLiveChild } from './continuable-child.js'

export class MemberChat {
  constructor(private readonly ctx: Context, private readonly deps: {
    root(main: string, scope: string): Promise<Agent>
    fence<T>(scope: string, teamId: TeamId, signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T>
  }) {}

  async target(binding: RetirementBinding, sessionId: string, signal: AbortSignal): Promise<MemberChatTarget> {
    const { team, scope, mainSessionId } = binding
    const member = team.members.find(row => row.sessionId === sessionId && row.phase === 'active')
    if (member === undefined || publicManagedParent(team.managedOrigin) !== mainSessionId
      || !await publicRecipientEligibility(this.ctx, scope, team, [sessionId], signal)) {
      throw new TeamDomainError('This Session is not an available managed member', 'SWARM_MEMBER_CHAT_UNAVAILABLE')
    }
    await binding.verify()
    signal.throwIfAborted()
    return { schemaVersion: 1, target: { rootSessionId: mainSessionId, teamId: team.id },
      name: member.name, sessionId, captainSessionId: team.captainSessionId }
  }

  async prompt(request: MemberChatPrompt, authorize: () => Promise<RetirementBinding>, signal: AbortSignal): Promise<MemberChatPromptResult> {
    const initial = await authorize()
    return this.deps.fence(initial.scope, initial.team.id, signal, async currentSignal => {
      // A restored Agent is a new live witness. Reacquire Host authority after
      // every activation instead of weakening the existing read identity fence.
      const checked = async () => {
        const binding = await authorize()
        if (binding.scope !== initial.scope || binding.mainSessionId !== initial.mainSessionId
          || binding.team.captainSessionId !== initial.team.captainSessionId
          || binding.team.managedOrigin !== initial.team.managedOrigin) this.changed()
        const target = await this.target(binding, request.sessionId, currentSignal)
        if (target.name !== request.name || target.target.rootSessionId !== request.target.rootSessionId
          || target.target.teamId !== request.target.teamId) this.changed()
        return binding
      }
      await checked()
      const root = await this.deps.root(initial.mainSessionId, initial.scope)
      currentSignal.throwIfAborted()
      return withLiveChild(this.ctx, root, SessionId(initial.team.captainSessionId), currentSignal, async (captain, lease) => {
        await checked()
        lease.throwIfAborted()
        if (this.ctx.agents.get(root.id) !== root || this.ctx.sessions.get(root.id) !== root.session
          || this.ctx.agents.get(captain.id) !== captain || this.ctx.sessions.get(captain.id) !== captain.session) this.changed()
        const receipt = await this.ctx.subagents.prompt({ requestId: request.requestId as SubagentPromptRequestId,
          parentSessionId: captain.id, childSessionId: SessionId(request.sessionId), mode: 'continuable',
          content: request.content.map(part => part.type === 'text' ? part : { type: part.type, mediaType: part.mediaType,
            data: part.data, ...(part.name === undefined ? {} : { name: part.name }) }), delivery: request.delivery,
          ...(request.clientTimeZone === undefined ? {} : { clientTimeZone: request.clientTimeZone }) }, lease)
        return { schemaVersion: 1, sessionId: request.sessionId, messageId: receipt.messageId }
      })
    })
  }

  private changed(): never { throw new TeamDomainError('Member chat binding changed before admission', 'SWARM_HOST_BINDING_MISMATCH') }
}
