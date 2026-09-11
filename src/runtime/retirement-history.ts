/** Cold read handles only: viewing archived history never creates, resumes or prompts an Agent. */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, deriveEventMessage, isAppendSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { TeamDomainError } from '../domain/error.js'
import type { RetirementBinding } from './team-retirement.js'
import type { RetirementHistory, RetirementHistoryRequest } from '../shared/team-retirement.js'
import { retirementManifest } from './retirement-manifest.js'
import type { StorageDomainTeamStore } from '../storage/storage-domain-team-store.js'

function transcriptText(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap(block => {
    if (block.type === 'text') return [block.text]
    if (block.type === 'tool-result') return [transcriptText(block.content)]
    if (block.type === 'tool-call') return [`↳ ${block.name}`]
    if (block.type === 'image') return [`[${block.attachment.name ?? 'Image'} · ${block.attachment.width} × ${block.attachment.height}]`]
    if (block.type === 'file') return [`[${block.attachment.name}]`]
    return []
  }).join('\n\n')
}

export async function readRetirementHistory(ctx: Context, store: StorageDomainTeamStore, binding: RetirementBinding,
  input: RetirementHistoryRequest, signal: AbortSignal): Promise<RetirementHistory> {
  if (binding.team.phase !== 'archived') throw new TeamDomainError('Read-only history requires an archived Team', 'TEAM_RETIREMENT_HISTORY_NOT_ARCHIVED')
  const manifest = await retirementManifest(ctx, binding.scope, binding.mainSessionId, binding.team, store.records(), signal)
  const candidates = new Map<string, { id: string; label: string; role: 'captain' | 'member' | 'descendant' }>()
  if (binding.team.captainSessionId) candidates.set(binding.team.captainSessionId, { id: binding.team.captainSessionId, label: binding.team.captainProfile?.displayName || 'Captain', role: 'captain' })
  for (const member of binding.team.members) for (const id of [member.sessionId, ...(member.previousSessionIds ?? [])]) {
    if (id) candidates.set(id, { id, label: `${member.displayName || member.name}${id === member.sessionId ? '' : ' · previous'}`, role: 'member' })
  }
  for (const id of manifest.ownedSessionIds) if (!candidates.has(id)) candidates.set(id, { id, label: id, role: 'descendant' })
  const sessions: RetirementHistory['sessions'] = []
  for (const row of candidates.values()) sessions.push({ ...row, available: await ctx.sessionPersistence.stat(SessionId(row.id), { signal }) !== undefined })
  const sessionId = input.sessionId ?? sessions.find(row => row.available)?.id
  if (sessionId !== undefined && !sessions.some(row => row.id === sessionId && row.available)) throw new TeamDomainError('Selected history does not belong to this archived Team', 'SWARM_HOST_BINDING_MISMATCH')
  const response: RetirementHistory = { schemaVersion: 1, target: input.target, teamName: binding.team.name, readonly: true,
    sessions, cursor: input.cursor, entries: [], ...(sessionId === undefined ? {} : { sessionId }) }
  if (sessionId !== undefined) {
    const handle = await ctx.sessionPersistence.open(SessionId(sessionId), 'read', { signal })
    try {
      let offset = input.cursor, scanned = 0
      while (scanned < 5000) {
        const { events } = await handle.read(offset, 250, { signal })
        for (const event of events) {
          if (!isAppendSurfaceEvent(event)) continue
          const message = deriveEventMessage(event)
          if (message === null || message.role === 'system') continue
          const content = transcriptText(message.content)
          if (!content) continue
          if (response.entries.length === 50) { response.nextCursor = event.seq; break }
          const role = message.source.kind === 'tool' ? 'tool' : message.role === 'assistant' ? 'assistant' : message.source.kind === 'user' ? 'user' : 'context'
          response.entries.push({ sequence: event.seq, role, content: content.slice(0, 32768), truncated: content.length > 32768 })
        }
        if (response.nextCursor !== undefined || events.length < 250) break
        offset += events.length; scanned += events.length
        if (scanned >= 5000) response.nextCursor = offset
      }
    } finally { await handle.close() }
  }
  await binding.verify(); signal.throwIfAborted()
  return response
}
