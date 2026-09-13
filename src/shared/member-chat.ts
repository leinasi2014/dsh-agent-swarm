/** Authenticated local operator prompts; content is admitted by official Subagent.prompt. */
import { z } from 'zod'

export const MEMBER_CHAT_CHANNEL = '/swarm-member-chat'
const id = z.string().min(1).max(256)
const target = z.object({ rootSessionId: id, teamId: id }).strict()
export const memberChatTargetRequestSchema = z.object({ schemaVersion: z.literal(1), sessionId: id }).strict()
export const memberChatTargetSchema = z.object({ schemaVersion: z.literal(1), target, name: id,
  sessionId: id, captainSessionId: id }).strict()
export const memberChatPromptSchema = z.object({ schemaVersion: z.literal(1), target, name: id, sessionId: id,
  requestId: z.string().uuid(), delivery: z.enum(['queue', 'steer']), clientTimeZone: z.string().optional(),
  content: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string() }).strict(),
    z.object({ type: z.literal('image'), mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
      data: z.string(), name: z.string().optional() }).strict(),
  ])).min(1),
}).strict()
export const memberChatPromptResultSchema = z.object({ schemaVersion: z.literal(1), sessionId: id, messageId: id }).strict()
export type MemberChatTarget = z.infer<typeof memberChatTargetSchema>
export type MemberChatPrompt = z.infer<typeof memberChatPromptSchema>
export type MemberChatPromptResult = z.infer<typeof memberChatPromptResultSchema>
