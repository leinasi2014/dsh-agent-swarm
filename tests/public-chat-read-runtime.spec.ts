/**
 * C1 RED→GREEN: a real active member reads its Team's public messages by its
 * OWN Agent identity — paged history plus exact public message-ID reads — and
 * answers a peer by the exact public id it just read. Before C1 the two read
 * tools do not exist, so every member read below fails through the real tool
 * pipeline (verified RED); after C1 the same assertions pass unchanged.
 *
 * Contract under test (docs/04 §8.6): reads resolve only the caller's current
 * Team by live Agent binding (no team target parameter exists); history limits
 * count, sequence window and real serialized bytes; an over-long original is
 * explicitly truncated and resumable by exact ID at Unicode-safe (code point)
 * offsets with coverage and completion flags; durable attachment refs, frames,
 * requestIds and private transcripts never appear — only public image ids and
 * metadata. Missing history, missing ID, invalid cursor and permission refusal
 * are each distinguishable. Old post/reply semantics stay unchanged.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { queueHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
import { expect, it, vi } from 'vitest'
import { withLiveChild } from './helpers/live-child.js'
import { RESTART_SIGNAL as SIGNAL, restartTool as tool } from './helpers/restart-real-composition.js'
import { ROOT, Recording, setup, createTeam, addPublicMembers } from './helpers/public-chat-real-composition.js'

// One long original with astral characters so continuation proves Unicode-safe
// (code point) slicing: CJK text, a ZWJ family emoji (several code points),
// then more text — no offset may ever return a lone surrogate.
const LONG = '公开修复进展：成员资料保存已与无关团队活动解冲突，窗口语义通过真实重开验证。👨‍👩‍👧‍👦继续补充边界证据：并发、移除、换Session与关闭后全部拒绝。'.repeat(3)

it('a member pages its Team public history, reads a peer post by exact public id, and answers it via public_reply', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-public-read-'))
  const f = await setup(sandbox, new Recording(), false)
  try {
    const { root, captain, teamId, scope } = await createTeam(f, sandbox)
    const memberIds = await addPublicMembers(f, root, captain.id)
    const alphaId = memberIds[0]!, betaId = memberIds[1]!

    // Beta publishes two real public messages through its own tool pipeline.
    // Members are the Captain's direct continuable children: drive them under
    // the exact live parent chain (root -> Captain -> member), the established
    // member-model-selection pattern; never assert a member as root's child.
    await withLiveChild(f.ctx, root, captain.id, SIGNAL, async liveCaptain => {
      await withLiveChild(f.ctx, liveCaptain, betaId, SIGNAL, async betaLive => {
        expect((await tool(f.ctx, betaLive, 'beta-post-1', 'agent_swarm_public_post', { request_id: 'beta-read-me-1', text: LONG.slice(0, 30) })).isError).toBe(false)
        expect((await tool(f.ctx, betaLive, 'beta-post-2', 'agent_swarm_public_post', { request_id: 'beta-read-me-2', text: LONG })).isError).toBe(false)
      })
    })

    // Alpha (neither author nor Captain) reads by its own identity.
    await withLiveChild(f.ctx, root, captain.id, SIGNAL, async liveCaptain => {
      await withLiveChild(f.ctx, liveCaptain, alphaId, SIGNAL, async alphaLive => {
      const history = await tool(f.ctx, alphaLive, 'alpha-history', 'agent_swarm_public_history', { limit: 10 })
      expect(history.isError, JSON.stringify(history.error ?? history.content)).toBe(false)
      const page = history.value as Record<string, unknown>
      const entries = page.entries as Array<{ message_id: string; sequence: number; text: string; author: Record<string, string>; reply_to?: string }>
      expect(page.total_count).toBeGreaterThanOrEqual(2)
      const target = entries.find(row => row.text === LONG)
      if (target === undefined) throw new Error(`history must carry beta's full original: ${JSON.stringify(page)}`)
      expect(target.message_id).toMatch(/^public-[a-f0-9-]{36}$/u)
      expect(target.author.session_id).toBe(betaId)
      expect(target.reply_to).toBeUndefined()
      expect(page).toMatchObject({ returned_count: entries.length, has_earlier: false, has_more: false, truncated_by_bytes: false })
      // Nothing private or durable-internal may reach the model face.
      expect(JSON.stringify(page)).not.toMatch(/requestId|request_id|bindingDigest|frame|parentSessionId|attachmentId|PRIVATE SESSION OUTPUT/u)

      // Exact-ID read: full text plus coverage and completion flags.
      const exact = await tool(f.ctx, alphaLive, 'alpha-exact', 'agent_swarm_public_message', { message_id: target.message_id })
      expect(exact.isError, JSON.stringify(exact.error ?? exact.content)).toBe(false)
      const full = exact.value as Record<string, unknown>
      expect(full.text).toBe(LONG)
      expect(full).toMatchObject({ message_id: target.message_id, truncated: false, has_more_text: false, complete: true, text_total: [...LONG].length })

      // Explicit truncation plus Unicode-safe continuation by the same ID.
      // Code-point slicing never splits a surrogate pair; grapheme/ZWJ cluster boundaries are not guaranteed.
      const head = await tool(f.ctx, alphaLive, 'alpha-head', 'agent_swarm_public_message', { message_id: target.message_id, max_chars: 40 })
      const headValue = head.value as { text: string, truncated: boolean }
      expect(headValue.text).toBe([...LONG].slice(0, 40).join(''))
      expect(headValue.truncated).toBe(true)
      expect(JSON.stringify(headValue)).not.toMatch(/\p{Surrogate}/u)
      const rest = await tool(f.ctx, alphaLive, 'alpha-rest', 'agent_swarm_public_message', { message_id: target.message_id, offset: 40 })
      const restValue = rest.value as { text: string, complete: boolean, has_more_text: boolean }
      expect(restValue.text).toBe([...LONG].slice(40).join(''))
      expect(headValue.text + restValue.text).toBe(LONG)
      expect(JSON.stringify(restValue)).not.toMatch(/\p{Surrogate}/u)
      expect(restValue).toMatchObject({ complete: false, has_more_text: false })

      // Distinguishable refusals: unknown ID, invalid offset, invalid cursor.
      const missing = await tool(f.ctx, alphaLive, 'alpha-missing', 'agent_swarm_public_message', { message_id: 'public-00000000-0000-4000-8000-000000000000' })
      expect(missing.isError).toBe(true)
      expect(missing.error).toMatchObject({ info: { code: 'TEAM_PUBLIC_MESSAGE_NOT_FOUND' } })
      const badOffset = await tool(f.ctx, alphaLive, 'alpha-bad-offset', 'agent_swarm_public_message', { message_id: target.message_id, offset: [...LONG].length + 5 })
      expect(badOffset.error).toMatchObject({ info: { code: 'TEAM_PUBLIC_OFFSET_INVALID' } })
      const badCursor = await tool(f.ctx, alphaLive, 'alpha-bad-cursor', 'agent_swarm_public_history', { before_sequence: 3, after_sequence: 1 })
      expect(badCursor.error).toMatchObject({ info: { code: 'TEAM_PUBLIC_CURSOR_INVALID' } })

      // Byte budget is real: a small max_bytes truncates with an explicit
      // flag, and the page is never a dead end — every locatable entry keeps
      // its public id (text omitted with its size) for exact-ID continuation.
      const tight = await tool(f.ctx, alphaLive, 'alpha-tight', 'agent_swarm_public_history', { limit: 10, max_bytes: 1024 })
      expect(tight.isError).toBe(false)
      const tightValue = tight.value as {
        entries: Array<{ message_id: string; text: string; text_omitted_by_bytes?: boolean; text_total?: number }>
        total_count: number; returned_count: number; truncated_by_bytes: boolean
      }
      expect(Buffer.byteLength(JSON.stringify(tight.value), 'utf8')).toBeLessThanOrEqual(1024)
      expect(tightValue.truncated_by_bytes).toBe(true)
      expect(tightValue.entries.length).toBeGreaterThan(0)
      expect(tightValue.entries.every(row => /^public-[a-f0-9-]{36}$/u.test(row.message_id))).toBe(true)
      expect(tightValue.total_count > tightValue.returned_count
        || tightValue.entries.every(row => row.text_omitted_by_bytes === true)).toBe(true)
      const headerTarget = tightValue.entries.find(row => row.text_omitted_by_bytes === true && (row.text_total ?? 0) === [...LONG].length)
      if (headerTarget !== undefined) {
        const revived = await tool(f.ctx, alphaLive, 'alpha-header-revive', 'agent_swarm_public_message', { message_id: headerTarget.message_id })
        expect((revived.value as { text: string }).text).toBe(LONG)
      }

      // The member answers the peer by the exact public id it read, using the
      // existing public_reply contract unchanged.
      const answered = await tool(f.ctx, alphaLive, 'alpha-answer', 'agent_swarm_public_reply', { request_id: 'alpha-answer-1', reply_to: target.message_id, text: '已按公开 ID 引用回复。' })
      expect(answered.isError, JSON.stringify(answered.error ?? answered.content)).toBe(false)
      })
    })

    // Permission: the unaffiliated Main Session cannot read member history.
    const denied = await tool(f.ctx, f.ctx.agents.get(ROOT)!, 'root-read', 'agent_swarm_public_history', {})
    expect(denied.isError).toBe(true)
    expect(denied.error).toMatchObject({ info: { code: 'TEAM_NOT_JOINED' } })

    // Old semantics retained: the reply landed referencing the exact id.
    const team = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
    const repliedId = team.publicChat!.messages.find(row => row.text === LONG)!.id
    expect(team.publicChat!.messages.some(row => row.replyTo === repliedId)).toBe(true)
    await f.close()
  } finally {
    await f.close().catch(() => undefined)
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 30_000)

/** Every string value inside a request tree that contains `token`. */
function stringsWith(node: unknown, token: string, into: string[] = []): string[] {
  if (typeof node === 'string') { if (node.includes(token)) into.push(node); return into }
  if (Array.isArray(node)) { for (const item of node) stringsWith(item, token, into); return into }
  if (node !== null && typeof node === 'object') for (const value of Object.values(node)) stringsWith(value, token, into)
  return into
}

/** Strings that are themselves the JSON object carrying `token`, parsed back. */
function parsedToolResults(node: unknown, token: string): Array<Record<string, unknown>> {
  return stringsWith(node, token).flatMap(text => {
    try {
      const parsed = JSON.parse(text) as unknown
      return typeof parsed === 'object' && parsed !== null ? [parsed as Record<string, unknown>] : []
    } catch { return [] }
  })
}

const READ_PROMPT = '读取公开历史并按 ID 引用长文。'

/** Official message shape: tool results ride inside message content blocks. */
function collectStrings(node: unknown, into: string[] = []): string[] {
  if (typeof node === 'string') into.push(node)
  else if (Array.isArray(node)) for (const item of node) collectStrings(item, into)
  else if (node !== null && typeof node === 'object') for (const value of Object.values(node)) collectStrings(value, into)
  return into
}
function toolResultTexts(options: GenerateOptions, callId: string): string[] {
  return (options.messages as Array<{ content?: unknown }>).flatMap(message => Array.isArray(message.content) ? message.content : [])
    .flatMap(block => {
      const value = block as { type?: string; toolCallId?: string; content?: unknown }
      return value.type === 'tool-result' && value.toolCallId === callId ? collectStrings(value.content) : []
    })
}

/**
 * Alpha's model pages the history only on the request that carries the read
 * prompt, then answers with the exact public id parsed from that tool result.
 * Earlier legitimate turns (join reminders etc.) settle plainly, so the chain
 * is keyed by content, never by a raw request count.
 */
class ReaderModel extends Recording {
  alphaSession: string | undefined
  /** Minimal fixture-local diagnostics: shape and tokens per alpha request. */
  readonly trace: Array<Record<string, unknown>> = []
  private historyRequested = false
  private replyRequested = false
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.sessionId !== this.alphaSession) { yield* super.stream(options); return }
    const prompted = stringsWith(options.messages, READ_PROMPT).length > 0
    const historyPages = parsedToolResults(options.messages, 'total_count')
    const raw = JSON.stringify(options.messages)
    this.trace.push({
      n: this.trace.length + 1,
      pushed: this.requests.length,
      prompted,
      hasStep1: raw.includes('alpha-read-step-1'),
      hasStep2: raw.includes('alpha-read-step-2'),
      stages: { history: this.historyRequested, reply: this.replyRequested },
      pages: historyPages.map(p => ({ total: p.total_count, returned: p.returned_count, texts: (p.entries as Array<{ text: string }> | undefined)?.map(entry => [...entry.text].length) ?? null })),
      replyResults: stringsWith(options.messages, 'Public reply ').map(text => text.slice(0, 200)),
      errorHints: [...new Set([...stringsWith(options.messages, 'TEAM_'), ...stringsWith(options.messages, 'isError'),
        ...stringsWith(options.messages, 'denied'), ...stringsWith(options.messages, 'unknown tool')].map(text => text.slice(0, 200)))].slice(0, 6),
    })
    if (!prompted && historyPages.length === 0) { yield* super.stream(options); return }
    this.requests.push(options)
    if (!this.historyRequested) {
      this.historyRequested = true
      yield* this.toolCall('alpha-read-step-1', 'agent_swarm_public_history', { limit: 10 })
      return
    }
    if (!this.replyRequested && historyPages.length > 0) {
      const entries = (historyPages[historyPages.length - 1]!.entries ?? []) as Array<{ message_id: string; text: string }>
      const target = entries.find(entry => entry.text === LONG)
      if (target === undefined) throw new Error('the history tool result must carry the long public original with its id')
      this.replyRequested = true
      yield* this.toolCall('alpha-read-step-2', 'agent_swarm_public_reply', { request_id: 'alpha-model-reply', reply_to: target.message_id, text: '模型按读到的公开 ID 直接引用回复。' })
      return
    }
    yield* super.stream(options)
  }
  stages(): Record<string, boolean> { return { history: this.historyRequested, reply: this.replyRequested } }
  private async * toolCall(id: string, name: string, args: object): AsyncIterable<StreamChunk> {
    const callId = ToolCallId(id)
    const json = JSON.stringify(args)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: json }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: json } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

it('the read public original enters the next real model request and the model itself references the returned public id', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-public-read-model-'))
  const adapter = new ReaderModel()
  const f = await setup(sandbox, adapter, false)
  try {
    const { root, captain, teamId, scope } = await createTeam(f, sandbox)
    const memberIds = await addPublicMembers(f, root, captain.id)
    const alphaId = memberIds[0]!, betaId = memberIds[1]!
    adapter.alphaSession = alphaId
    await withLiveChild(f.ctx, root, captain.id, SIGNAL, async liveCaptain => {
      await withLiveChild(f.ctx, liveCaptain, betaId, SIGNAL, async betaLive => {
        expect((await tool(f.ctx, betaLive, 'beta-model-post', 'agent_swarm_public_post', { request_id: 'beta-model-1', text: LONG })).isError).toBe(false)
      })
    })
    // Boundary: everything alpha had requested BEFORE the read prompt is cut
    // off; the chain is located by its unique tool-call ids afterwards, so an
    // unrelated earlier turn can neither mask nor fake the read chain.
    const seenBefore = adapter.requests.filter(request => request.sessionId === alphaId).length
    await withLiveChild(f.ctx, root, captain.id, SIGNAL, async liveCaptain => {
      await queueHostSubagentPrompt(f.ctx.subagents, liveCaptain, alphaId, [{ type: 'text', text: READ_PROMPT }], { kind: 'user' }, SIGNAL)
    })
    const chainOf = () => adapter.requests.filter(request => request.sessionId === alphaId).slice(seenBefore)
    // The existing public_reply renderer is plain text (`Public reply <id>,
    // sequence N.`); locate the ACTUAL tool result for our exact callId.
    const receiptText = () => chainOf().flatMap(request => toolResultTexts(request, 'alpha-read-step-2')).find(text => text.startsWith('Public reply public-'))
    try {
      await vi.waitFor(() => expect(receiptText()).toBeDefined(), { timeout: 25_000 })
    } catch (cause) {
      // Minimal fixture-local structured diagnostics: which chain step is
      // missing (model trigger / history result / reply call / receipt)?
      throw new Error(`READ_CHAIN_DIAGNOSTICS ${JSON.stringify({ seenBefore, chainNow: chainOf().length, stages: adapter.stages(), trace: adapter.trace })}`, { cause })
    }
    const chain = chainOf()

    // Step 1→2: the FIRST request that already contains the history tool call
    // is the true next request; it must carry the parsed tool result with the
    // full original and its exact public id — evidence from the tool result,
    // not from escaped JSON text.
    const historyCarrier = chain.find(request => JSON.stringify(request.messages).includes('alpha-read-step-1'))
    expect(historyCarrier, 'the model loop must answer the history tool call').toBeDefined()
    const pages = parsedToolResults(historyCarrier!.messages, 'total_count')
    expect(pages.length).toBeGreaterThan(0)
    const page = pages[pages.length - 1]!
    const entries = page.entries as Array<{ message_id: string; text: string }>
    const target = entries.find(entry => entry.text === LONG)
    expect(target, 'the tool result must carry beta\'s full public original').toBeDefined()
    // Leakage is judged on the NEW public payload; the session legitimately
    // holds alpha's own private history elsewhere.
    expect(JSON.stringify(page)).not.toMatch(/requestId|request_id|bindingDigest|frameVersion|parentSessionId|attachmentId|PRIVATE SESSION OUTPUT/u)

    // Step 2: the model itself issues the reply call, referencing the exact
    // id parsed from the tool result — parsed args, not string matching.
    const replyCarrier = chain.find(request => JSON.stringify(request.messages).includes('alpha-read-step-2'))
    expect(replyCarrier, 'the model loop must answer the reply tool call').toBeDefined()
    const referenced = stringsWith(replyCarrier!.messages, '"reply_to"')
      .flatMap(text => { try { return [JSON.parse(text) as Record<string, unknown>] } catch { return [] } })
      .find(value => typeof value.reply_to === 'string' && value.request_id === 'alpha-model-reply')
    expect(referenced?.reply_to).toBe(target!.message_id)

    // Step 3: the reply receipt returned to the model is the real tool-result
    // text in the old stable contract, parsed by its exact public id/sequence.
    const receiptTextValue = receiptText()!
    const receipt = /^Public reply (public-[a-f0-9-]{36}), sequence (\d+)( \(replayed\))?\.$/u.exec(receiptTextValue)
    expect(receipt, `actual reply tool result: ${JSON.stringify(receiptTextValue.slice(0, 200))}`).not.toBeNull()
    expect(receiptTextValue).not.toContain('(replayed)')

    // Durable ledger: the reply references the exact id, authored by alpha,
    // and no private text ever entered the public record.
    const team = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
    const targetId = team.publicChat!.messages.find(row => row.text === LONG)!.id
    const reply = team.publicChat!.messages.find(row => row.replyTo === targetId)
    expect(target!.message_id).toBe(targetId)
    expect(receipt![1]).toBe(reply!.id)
    expect(receipt![2]).toBe(String(reply!.sequence))
    expect(reply!.text).toBe('模型按读到的公开 ID 直接引用回复。')
    expect(reply!.author).toMatchObject({ kind: 'agent', sessionId: alphaId })
    expect(team.publicChat!.messages.every(row => !row.text.includes('PRIVATE SESSION OUTPUT'))).toBe(true)
    await f.close()
  } finally {
    await f.close().catch(() => undefined)
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 40_000)
