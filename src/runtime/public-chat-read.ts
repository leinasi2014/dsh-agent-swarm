/**
 * C1 model-facing public read surface (docs/04 §8.6): a real active member
 * pages its own Team's public history and reads one exact public message by
 * its public id. Both reads are pure — they never boot startup recovery,
 * deliver, or create tasks — and they never borrow the browser operator's
 * read entry point. There is deliberately no Team target parameter: the Team
 * always comes from the caller's own live membership, so another Team's
 * history is unaddressable. The executing Agent/Session and scope are
 * checked before IO, after IO and again before returning (together with
 * abort and runtime-close); the Team, Captain, membership AND the returned
 * public content are fixed together by the SECOND canonical membership scan
 * — per Root's R/W ruling, a read whose second scan linearized before the
 * removal may settle with that snapshot even if a removal durably completes
 * while it is still awaiting other locks, and the next read then rejects.
 * An aborted or rotated identity discards the in-flight page.
 *
 * Budgets are real: history caps entry count and the actual serialized
 * byte size (dropping whole entries with an explicit flag instead of
 * silently truncating), and an over-long original is only ever shortened by
 * the exact-ID reader at Unicode code-point offsets with completion flags.
 * The model face carries only public content, public image ids and metadata;
 * durable attachment refs, request ids, binding digests, frames, delivery
 * state, assistance records and private transcripts never leave this layer.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TeamDomainError } from '../domain/error.js'
import type { TeamDomainPort, TeamScope } from '../domain/team-domain-port.js'
import type { TeamPublicMessage } from '../domain/public-message.js'
import { projectPublicHistory, projectPublicMessage } from '../rpc/public-rpc-projection.js'
import { requireAgent, type ToolExecutionAuthority } from './authority.js'

export const PUBLIC_HISTORY_DEFAULT_BYTES = 32_768
const PUBLIC_HISTORY_MIN_BYTES = 1_024
const PUBLIC_HISTORY_MAX_BYTES = 65_536
export const PUBLIC_HISTORY_DEFAULT_LIMIT = 20
const PUBLIC_HISTORY_MAX_LIMIT = 50
export const PUBLIC_MESSAGE_DEFAULT_CHARS = 8_000
const PUBLIC_MESSAGE_MAX_CHARS = 20_000

interface PublicChatReadImage {
  image_id: string; media_type: string; bytes: number; width: number; height: number; name?: string
}

export interface PublicChatReadRow {
  message_id: string; sequence: number; created_at: number
  author: { kind: string; session_id?: string; role?: string; name?: string; display_name?: string }
  text: string; images: PublicChatReadImage[]; reply_to?: string
  /** Set only when the byte budget stripped this entry's text; the id still reads fully. */
  text_omitted_by_bytes?: boolean; text_total?: number
}

export interface PublicHistoryReadResult {
  entries: PublicChatReadRow[]; total_count: number; returned_count: number; limit: number
  has_earlier: boolean; has_more: boolean; truncated_by_bytes: boolean
  first_sequence?: number; last_sequence?: number
}

export interface PublicMessageReadResult extends PublicChatReadRow {
  text_offset: number; max_chars: number; text_total: number
  truncated: boolean; has_more_text: boolean; complete: boolean
}

export interface PublicChatReadDeps {
  ctx: Context
  domain: () => TeamDomainPort
  scopeOf: (agent: Agent) => TeamScope
  /** The real runtime close signal, aborted at dispose entry before store close. */
  closingSignal: () => AbortSignal
}

type ProjectedRow = ReturnType<typeof projectPublicMessage>

/** Model-facing row: the pure v3 projection narrowed to public content only. */
function toPublicRow(projected: ProjectedRow): PublicChatReadRow {
  const author = projected.author
  const content = 'content' in projected ? projected.content : []
  return {
    message_id: projected.id, sequence: projected.sequence, created_at: projected.createdAt,
    author: {
      kind: author.kind,
      ...(author.kind === 'agent'
        ? { session_id: author.sessionId, role: author.role, name: author.name,
            ...(author.displayName === undefined ? {} : { display_name: author.displayName }) }
        : {}),
    },
    text: projected.text,
    images: content.flatMap(part => part.type === 'image' ? [{
      image_id: part.imageId, media_type: part.mediaType, bytes: part.bytes, width: part.width, height: part.height,
      ...(part.name === undefined ? {} : { name: part.name }),
    }] : []),
    ...('replyTo' in projected && projected.replyTo !== undefined ? { reply_to: projected.replyTo } : {}),
  }
}

function expectInteger(value: number, minimum: number, maximum: number, message: string, code: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TeamDomainError(`${message} (allowed ${minimum}..${maximum})`, code)
  }
}

export function createPublicChatReadSurface(deps: PublicChatReadDeps) {
  /** Live Agent/Session/scope/abort/closing checks around the IO plus the two
   * canonical membership scans: the second scan is R — it fixes Team, Captain,
   * membership and the returned content in one snapshot; a target rotation
   * between the two scans discards the page. */
  async function readContext(exec: ToolExecutionAuthority): Promise<{ messages: readonly TeamPublicMessage[]; exact: () => void }> {
    const agent = requireAgent(exec)
    const scope = deps.scopeOf(agent)
    const exact = () => {
      exec.signal.throwIfAborted()
      if (deps.closingSignal().aborted) {
        throw new TeamDomainError('Team orchestrator is closing; public read discarded the in-flight page', 'TEAM_RUNTIME_CLOSING')
      }
      if (deps.ctx.agents.get(agent.id) !== agent || deps.ctx.sessions.get(agent.id) !== agent.session || deps.scopeOf(agent) !== scope) {
        throw new TeamDomainError('Public read requires the exact live executing Session', 'TEAM_AGENT_REQUIRED')
      }
    }
    exact()
    const membership = await deps.domain().requireMembership(scope, agent.id)
    const teamId = membership.team.id, captainId = membership.team.captainSessionId
    exact()
    const current = await deps.domain().requireMembership(scope, agent.id)
    if (current.team.id !== teamId || current.team.captainSessionId !== captainId) {
      throw new TeamDomainError('Public read target changed during the read', 'TEAM_PUBLIC_DELIVERY_MISMATCH')
    }
    return { messages: current.team.publicChat?.messages ?? [], exact }
  }

  async function history(exec: ToolExecutionAuthority, input: {
    limit: number; beforeSequence?: number | undefined; afterSequence?: number | undefined; maxBytes: number
  }): Promise<PublicHistoryReadResult> {
    const { messages, exact } = await readContext(exec)
    if (input.beforeSequence !== undefined && input.afterSequence !== undefined) {
      throw new TeamDomainError('before_sequence and after_sequence cannot combine', 'TEAM_PUBLIC_CURSOR_INVALID')
    }
    for (const cursor of [input.beforeSequence, input.afterSequence]) {
      if (cursor !== undefined) expectInteger(cursor, 1, Number.MAX_SAFE_INTEGER, 'sequence cursor must be a positive integer', 'TEAM_PUBLIC_CURSOR_INVALID')
    }
    expectInteger(input.limit, 1, PUBLIC_HISTORY_MAX_LIMIT, 'limit must be an integer', 'TEAM_PUBLIC_CURSOR_INVALID')
    expectInteger(input.maxBytes, PUBLIC_HISTORY_MIN_BYTES, PUBLIC_HISTORY_MAX_BYTES, 'max_bytes must be an integer', 'TEAM_PUBLIC_CURSOR_INVALID')
    const page = projectPublicHistory(messages, {
      limit: input.limit, ...(input.beforeSequence === undefined ? {} : { beforeSequence: input.beforeSequence }),
      ...(input.afterSequence === undefined ? {} : { afterSequence: input.afterSequence }),
    }, 3)
    const rows = page.entries.map(projected => toPublicRow(projected))
    // Direction contract: budget pressure may only drop the FAR end of the
    // window — default/before pages keep the NEWEST messages (a backward
    // reader resumes at before_sequence = first_sequence and can never lose
    // the newer part of the window it asked for), after pages keep the
    // EARLIEST. has_earlier/has_more are recomputed from the FINAL kept
    // range, so a header-only page — whose text merely awaits exact-id reads
    // — never claims a continuation page that does not exist.
    const keepsNewest = input.afterSequence === undefined
    // Every fit decision measures the final serialized artifact the caller
    // would actually receive — the same flags, never an approximation — so a
    // critical budget can never overshoot by a byte.
    const snapshot = (kept: PublicChatReadRow[], trimmed: boolean): PublicHistoryReadResult => {
      const firstKept = kept.length === 0 ? undefined : kept[0]!.sequence
      const lastKept = kept.length === 0 ? undefined : kept[kept.length - 1]!.sequence
      return {
        entries: kept, total_count: page.totalCount, returned_count: kept.length, limit: input.limit,
        has_earlier: firstKept === undefined ? false : messages.some(row => row.sequence < firstKept),
        has_more: lastKept === undefined ? false : messages.some(row => row.sequence > lastKept),
        truncated_by_bytes: trimmed,
        ...(firstKept === undefined || lastKept === undefined ? {} : { first_sequence: firstKept, last_sequence: lastKept }),
      }
    }
    const fits = (kept: PublicChatReadRow[], trimmed: boolean) =>
      Buffer.byteLength(JSON.stringify(snapshot(kept, trimmed)), 'utf8') <= input.maxBytes
    let kept = rows, trimmed = false
    if (!fits(kept, false)) {
      trimmed = true
      while (kept.length > 0 && !fits(kept, true)) kept = keepsNewest ? kept.slice(1) : kept.slice(0, -1)
      if (kept.length === 0 && rows.length > 0) {
        // A page must never dead-end: when even one full entry cannot fit, the
        // kept end comes back as locatable headers (ids kept, text omitted with
        // its size) that the exact-ID reader resolves in full.
        const headers = rows.map(row => ({
          ...row, text: '', images: [] as PublicChatReadImage[],
          text_total: [...row.text].length, text_omitted_by_bytes: true as const,
        }))
        while (headers.length > 1 && !fits(headers, true)) {
          if (keepsNewest) headers.shift(); else headers.pop()
        }
        if (!fits(headers, true)) {
          throw new TeamDomainError('max_bytes cannot fit a single public entry header; read exact ids with agent_swarm_public_message', 'TEAM_PUBLIC_CURSOR_INVALID')
        }
        kept = headers
      }
    }
    exact()
    return snapshot(kept, trimmed)
  }

  async function message(exec: ToolExecutionAuthority, input: {
    messageId: string; offset: number; maxChars: number
  }): Promise<PublicMessageReadResult> {
    const { messages, exact } = await readContext(exec)
    if (typeof input.messageId !== 'string' || input.messageId.trim() === '') {
      throw new TeamDomainError('message_id must be a non-empty public message id', 'TEAM_PUBLIC_MESSAGE_NOT_FOUND')
    }
    const found = messages.find(row => row.id === input.messageId)
    if (found === undefined) throw new TeamDomainError('No public message carries that id', 'TEAM_PUBLIC_MESSAGE_NOT_FOUND')
    expectInteger(input.maxChars, 1, PUBLIC_MESSAGE_MAX_CHARS, 'max_chars must be an integer', 'TEAM_PUBLIC_OFFSET_INVALID')
    const projected = toPublicRow(projectPublicMessage(found, 3))
    const characters = [...projected.text]
    if (!Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset > characters.length) {
      throw new TeamDomainError('offset must be a code-point offset inside this message', 'TEAM_PUBLIC_OFFSET_INVALID')
    }
    const slice = characters.slice(input.offset, input.offset + input.maxChars)
    const hasMore = input.offset + input.maxChars < characters.length
    exact()
    return { ...projected, text: slice.join(''), text_offset: input.offset, max_chars: input.maxChars,
      text_total: characters.length, truncated: hasMore, has_more_text: hasMore, complete: input.offset === 0 && !hasMore }
  }

  return { history, message }
}
