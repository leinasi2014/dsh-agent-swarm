import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { MEMBER_CHAT_CHANNEL, memberChatTargetRequestSchema, memberChatTargetSchema, memberChatPromptSchema,
  memberChatPromptResultSchema, type MemberChatTarget, type MemberChatPrompt, type MemberChatPromptResult } from '../shared/member-chat.js'

/** Authenticated Host rejections remain explicit; transport failures are never retried here. */
class MemberChatRpcError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

/** The Host owns member identity and official prompt admission; this client only carries the exact request. */
export class MemberChatClient {
  constructor(private readonly rpc: Pick<ClientConnectionRpc, 'call'>) {}
  private async call(endpoint: string, request: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await this.rpc.call(MEMBER_CHAT_CHANNEL, endpoint, request, signal)
    if (!response.ok) throw new MemberChatRpcError(response.error.code, response.error.message)
    return response.value
  }
  async target(sessionId: string, signal?: AbortSignal): Promise<MemberChatTarget> {
    const value = memberChatTargetSchema.parse(await this.call('target', memberChatTargetRequestSchema.parse({ schemaVersion: 1, sessionId }), signal))
    if (value.sessionId !== sessionId) throw new Error('Member Chat target Session changed')
    return value
  }
  async prompt(request: MemberChatPrompt, signal?: AbortSignal): Promise<MemberChatPromptResult> {
    const value = memberChatPromptResultSchema.parse(await this.call('prompt', memberChatPromptSchema.parse(request), signal))
    if (value.sessionId !== request.sessionId) throw new Error('Member Chat prompt Session changed')
    return value
  }
}
