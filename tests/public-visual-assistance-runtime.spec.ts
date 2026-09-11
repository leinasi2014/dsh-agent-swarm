import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { publicDeliveries, isPublicMessageV3, publicChatReservedBytes, assertPublicChat } from '../src/domain/public-message.js'
import type { StoredPublicImageSegment } from '../src/domain/public-image-message.js'
import { TeamDomain, DEFAULT_TEAM_LIMITS } from '../src/domain/team-domain.js'
import { openStorageStack } from './helpers/storage-stack.js'
import { assistanceRows } from '../src/domain/team-domain-visual-assistance.js'
import { VISUAL_ASSISTANCE_TTL_MS } from '../src/domain/visual-assistance.js'
import { readPersistedSession } from '../src/runtime/persisted-session.js'
import { frameVisibility } from '../src/runtime/frame-visibility.js'
import { publicInputPredicates } from '../src/runtime/public-image-delivery.js'
import { createTeam } from './helpers/public-chat-real-composition.js'
import { RESTART_SIGNAL as SIGNAL } from './helpers/restart-real-composition.js'
import { PNG_IMAGE, GIF_IMAGE, ImageRecording, setupImages, imageClient } from './helpers/public-images-real-composition.js'

class AssistanceRecording extends ImageRecording {
  readonly calls: string[] = []
  readonly toolCalls: { id: ToolCallId; name: string; sessionId: GenerateOptions['sessionId']; sourceMessageId: string }[] = []
  directoryTexts: string[] = []
  autoRequest = true
  autoComplete = true
  helperCapability: 'supported' | 'unsupported' | 'unknown' = 'supported'
  private readonly requested = new Set<string>()
  private readonly steps = new Map<string, number>()
  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model,
      ...(model === 'visual-helper' && this.helperCapability === 'unknown' ? {}
        : { inputModalities: model === 'visual-helper' && this.helperCapability === 'supported' ? ['text' as const, 'image' as const] : ['text' as const] }) }
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const frames = options.messages.filter(message => message.role === 'user').flatMap(message => message.content)
      .filter(part => part.type === 'text' && part.text.includes('Message data (JSON): '))
    const frame = frames.at(-1)
    if (frame?.type !== 'text') { yield { type: 'finish', reason: { kind: 'stop' } }; return }
    const data = JSON.parse(frame.text.split('Message data (JSON): ')[1]!)
    const step = this.steps.get(data.messageId) ?? 0
    let name: string | undefined, args: object = {}
    if (data.assistance?.kind === 'request' && step === 0 && this.autoComplete) {
      name = 'agent_swarm_complete_visual_assistance'
      args = { request_id: 'complete-once', assistance_id: data.assistance.assistanceId,
        outcome: { state: 'completed', summary: 'The original image is a one pixel PNG.' } }
    } else if (data.assistance === undefined && step === 0 && this.autoRequest) {
      name = 'agent_swarm_directory'
    } else if (data.assistance === undefined && step >= 1 && step <= 5 && this.autoRequest && !this.requested.has(data.messageId)) {
      const texts = options.messages.flatMap(message => message.content).flatMap(block => block.type === 'tool-result'
        ? block.content.filter(part => part.type === 'text').map(part => part.text) : [])
      this.directoryTexts = texts
      const directory = texts.map(text => { try { return JSON.parse(text) } catch { return undefined } })
        .find(value => value?.entries?.some((entry: { name: string }) => entry.name === 'vision'))
      const helper = directory?.entries.find((entry: { name: string }) => entry.name === 'vision')
      if (helper === undefined) name = 'agent_swarm_directory'
      else {
        this.requested.add(data.messageId)
        name = 'agent_swarm_request_visual_assistance'
        args = { request_id: 'assist-once', source_message_id: data.messageId, image_ids: ['image-1'],
          helper_member_id: helper.memberId, question: 'Describe the original PNG.' }
      }
    }
    this.steps.set(data.messageId, step + 1)
    if (name === undefined) { yield { type: 'finish', reason: { kind: 'stop' } }; return }
    this.calls.push(name)
    const id = ToolCallId(`visual-real-${this.calls.length}`), toolArguments = JSON.stringify(args)
    this.toolCalls.push({ id, name, sessionId: options.sessionId, sourceMessageId: data.messageId })
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: toolArguments }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: toolArguments } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

async function visualFixture(adapter = new AssistanceRecording()) {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-visual-boundaries-')), f = await setupImages(sandbox, adapter)
  try {
    const { root, captain, teamId, scope } = await createTeam(f, sandbox)
    let helperId!: SessionId
    const asCaptain = async (name: string, args: object, requestSignal?: AbortSignal) => await f.ctx.subagents.withContinuableChild(root, captain.id, SIGNAL,
      async (agent, signal) => await f.ctx.tools.execute({ signal: requestSignal ?? signal, agent, callId: ToolCallId(crypto.randomUUID()), name, arguments: args }))
    const helper = await asCaptain('agent_swarm_add_member', { name: 'vision', role: 'Describe original images', llm_provider: 'public-fixture', model: 'visual-helper' })
    expect(helper.isError, JSON.stringify(helper)).toBe(false)
    helperId = SessionId((helper.value as { session_id: string }).session_id)
    await f.ctx.agents.get(helperId)?.whenIdle()
    const asHelper = async (name: string, args: object) => await f.ctx.subagents.withContinuableChild(root, captain.id, SIGNAL,
      async (parent, signal) => await f.ctx.subagents.withContinuableChild(parent, helperId, signal,
        async (agent, inner) => await f.ctx.tools.execute({ signal: inner, agent, callId: ToolCallId(crypto.randomUUID()), name, arguments: args })))
    const call = await imageClient(f, teamId), team = async () => (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
    return { sandbox, f, root, captain, teamId, scope, helperId, asCaptain, asHelper, call, team,
      close: async () => { await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } }
  } catch (error) { await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); throw error }
}

// Public delivery itself allows 5s for a durable claim after admission. These
// real cold-Session/attachment gates also include setup and persistence IO.
const VISUAL_GATE_WAIT = { timeout: 10_000, interval: 50 }

async function claimedImage(fixture: Awaited<ReturnType<typeof visualFixture>>, messageId: string, recipientId: string) {
  const started = performance.now()
  await vi.waitFor(async () => {
    const message = (await fixture.team()).publicChat?.messages.find(row => row.id === messageId)
    const delivery = message === undefined ? undefined : publicDeliveries(message).find(row => row.recipientSessionId === recipientId)
    const detail = `${messageId} -> ${recipientId}, ${Math.round(performance.now() - started)}ms: ${JSON.stringify(delivery)}`
    expect(delivery, detail).toMatchObject({ state: 'claimed', frameVersion: 3 })
    if (message === undefined || delivery?.frameVersion !== 3 || delivery.projection === undefined) throw new Error(detail)
    expect(await frameVisibility(fixture.f.ctx, recipientId, delivery.frame, SIGNAL, 'visual fixture claim', true,
      publicInputPredicates(delivery.frame, message.id, delivery.projection)), detail).toBe('claimed')
  }, VISUAL_GATE_WAIT)
}

async function originalImage(fixture: Awaited<ReturnType<typeof visualFixture>>) {
  const sent = await fixture.call('append', { requestId: 'original-for-assistance', content: [PNG_IMAGE] })
  expect(sent.ok, JSON.stringify(sent)).toBe(true)
  await claimedImage(fixture, sent.value.message.id, fixture.captain.id)
  return { request_id: 'manual-assistance', source_message_id: sent.value.message.id, image_ids: ['image-1'],
    helper_member_id: fixture.helperId, question: 'Describe the original PNG.' }
}

function deferred() {
  let resolve!: () => void
  return { promise: new Promise<void>(done => { resolve = done }), resolve: () => resolve() }
}

it('lets a nonvisual model choose a directory helper, transfer original refs and receive its atomic public result', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-visual-assistance-'))
  const adapter = new AssistanceRecording(), f = await setupImages(sandbox, adapter)
  try {
    const { root, captain, teamId, scope } = await createTeam(f, sandbox)
    let helperId!: SessionId, requesterId!: SessionId
    await f.ctx.subagents.withContinuableChild(root, captain.id, SIGNAL, async (liveCaptain, signal) => {
      const requester = await f.ctx.tools.execute({ signal, agent: liveCaptain, callId: ToolCallId('add-original-member'),
        name: 'agent_swarm_add_member', arguments: { name: 'original', role: 'Continue the original task',
          llm_provider: 'public-fixture', model: 'public-model' } })
      expect(requester.isError, JSON.stringify(requester)).toBe(false)
      requesterId = SessionId((requester.value as { session_id: string }).session_id)
      const helper = await f.ctx.tools.execute({ signal, agent: liveCaptain, callId: ToolCallId('add-vision'),
        name: 'agent_swarm_add_member', arguments: { name: 'vision', role: 'Describe original images',
          llm_provider: 'public-fixture', model: 'visual-helper' } })
      expect(helper.isError, JSON.stringify(helper)).toBe(false)
      helperId = SessionId((helper.value as { session_id: string }).session_id)
    })
    await Promise.all([f.ctx.agents.get(helperId)?.whenIdle(), f.ctx.agents.get(requesterId)?.whenIdle()])
    const before = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
    const call = await imageClient(f, teamId)
    const sent = await call('append', { requestId: 'needs-vision', content: [{ type: 'mention', memberId: requesterId }, PNG_IMAGE] })
    expect(sent.ok, JSON.stringify(sent)).toBe(true)
    await vi.waitFor(async () => {
      expect(adapter.calls, JSON.stringify(adapter.directoryTexts)).toContain('agent_swarm_request_visual_assistance')
      const toolCall = adapter.toolCalls.find(row => row.name === 'agent_swarm_request_visual_assistance'
        && row.sessionId === requesterId && row.sourceMessageId === sent.value.message.id)
      expect(toolCall).toBeDefined()
      const persisted = await readPersistedSession(f.ctx.sessionPersistence, requesterId, SIGNAL)
      const request = persisted.events.find(event => event.type === 'tool/call' && event.data.callId === toolCall!.id)
      expect(request).toBeDefined()
      const result = persisted.events.find(event => event.type === 'tool/result' && event.sourceEventSeqs?.includes(request!.seq))
      expect(result, JSON.stringify(result)).toMatchObject({ data: { message: { content: [{ type: 'tool-result', toolCallId: toolCall!.id, isError: false }] } } })
    }, VISUAL_GATE_WAIT)
    await vi.waitFor(async () => {
      const team = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
      expect(team.publicChat?.messages).toHaveLength(3)
      expect(team.publicChat!.messages.every(message => publicDeliveries(message).every(row => row.state === 'claimed'))).toBe(true)
    }, { timeout: 15_000 })
    expect(adapter.calls.filter(name => name !== 'agent_swarm_directory')).toEqual(['agent_swarm_request_visual_assistance', 'agent_swarm_complete_visual_assistance'])
    const team = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
    expect(team.tasks).toEqual(before.tasks)
    const [original, request, result] = team.publicChat!.messages
    expect(request).toMatchObject({ author: { kind: 'agent', sessionId: requesterId }, replyTo: original!.id })
    expect(result).toMatchObject({ author: { kind: 'agent', sessionId: helperId }, replyTo: original!.id })
    if (!isPublicMessageV3(original!)) throw new Error('Expected v3 original')
    const refs = original.content.filter(part => part.type === 'image').map(part => part.attachment)
    for (const [message, recipient, expectedRefs] of [[request!, helperId, refs], [result!, requesterId, []]] as const) {
      const session = await readPersistedSession(f.ctx.sessionPersistence, recipient, SIGNAL)
      const frame = publicDeliveries(message)[0]!.frame
      const events = session.events.filter(event => event.type === 'user/message' && event.data.content.some(part => part.type === 'text' && part.text === frame))
      expect(events).toHaveLength(1)
      const event = events[0]!
      if (event.type !== 'user/message') throw new Error('Expected user message')
      expect(event.data.source).toEqual({ kind: 'plugin', plugin: 'dsh-agent-swarm' })
      expect(event.data.content.filter(part => part.type === 'image').map(part => part.attachment)).toEqual(expectedRefs)
    }
    const page = await call('history')
    expect(page.value.entries[2].text).toContain('one pixel PNG')
    expect(JSON.stringify(page)).not.toMatch(/attachmentId|bindingDigest|"data"/u)
  } finally { await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 40_000)

it('keeps real tool retries immutable, deduplicates in-flight image sets and rejects nonrecipients and chaining', async () => {
  const adapter = new AssistanceRecording(); adapter.autoRequest = false; adapter.autoComplete = false
  const fixture = await visualFixture(adapter)
  try {
    const args = await originalImage(fixture), before = await fixture.team()
    expect(await fixture.asHelper('agent_swarm_request_visual_assistance', { ...args, helper_member_id: fixture.captain.id }))
      .toMatchObject({ isError: true, error: { info: { code: 'TEAM_VISUAL_PERMISSION_REVOKED' } } })
    const started = await fixture.asCaptain('agent_swarm_request_visual_assistance', args)
    expect(started.isError, JSON.stringify(started)).toBe(false)
    const startedRow = assistanceRows(await fixture.team())[0]!
    await claimedImage(fixture, startedRow.requestMessageId, fixture.helperId)
    const read = vi.spyOn(fixture.f.ctx.attachments, 'readImage')
    const retry = await fixture.asCaptain('agent_swarm_request_visual_assistance', args)
    expect(retry).toMatchObject({ isError: false, value: { ...(started.value as object), replayed: true } })
    const alias = { ...args, request_id: 'same-inflight-images', question: 'A differently worded repeat while pending' }
    expect(await fixture.asCaptain('agent_swarm_request_visual_assistance', alias))
      .toMatchObject({ isError: false, value: { ...(started.value as object), replayed: true } })
    expect(read).not.toHaveBeenCalled()
    expect(await fixture.asCaptain('agent_swarm_request_visual_assistance', { ...alias, question: 'Changed retry payload' }))
      .toMatchObject({ isError: true, error: { info: { code: 'TEAM_VISUAL_REQUEST_CONFLICT' } } })
    const row = assistanceRows(await fixture.team())[0]!
    expect(row.requests).toHaveLength(2)
    expect(row.visited).toEqual([fixture.captain.id, fixture.helperId])
    expect(await fixture.asHelper('agent_swarm_request_visual_assistance', { ...args, request_id: 'chain',
      source_message_id: row.requestMessageId, helper_member_id: fixture.captain.id }))
      .toMatchObject({ isError: true, error: { info: { code: 'TEAM_VISUAL_PERMISSION_REVOKED' } } })
    const complete = { request_id: 'manual-complete', assistance_id: row.assistanceId, outcome: { state: 'completed', summary: 'An original pixel.' } }
    expect(await fixture.asCaptain('agent_swarm_complete_visual_assistance', complete))
      .toMatchObject({ isError: true, error: { info: { code: 'TEAM_VISUAL_PERMISSION_REVOKED' } } })
    expect(await fixture.asHelper('agent_swarm_complete_visual_assistance', complete)).toMatchObject({ isError: false, value: { state: 'completed', replayed: false } })
    expect(await fixture.asHelper('agent_swarm_complete_visual_assistance', complete)).toMatchObject({ isError: false, value: { state: 'completed', replayed: true } })
    expect(await fixture.asHelper('agent_swarm_complete_visual_assistance', { ...complete, outcome: { state: 'completed', summary: 'Changed summary' } }))
      .toMatchObject({ isError: true, error: { info: { code: 'TEAM_VISUAL_REQUEST_CONFLICT' } } })
    await claimedImage(fixture, row.resultId, fixture.captain.id)
    expect((await fixture.team()).tasks).toEqual(before.tasks)
    expect((await fixture.team()).publicChat!.messages).toHaveLength(3)
  } finally { await fixture.close() }
}, 30_000)

it('still cold-recovers existing task work while a helper has claimed an unexpired assistance and has not completed it', async () => {
  const adapter = new AssistanceRecording(); adapter.autoRequest = false; adapter.autoComplete = false
  const fixture = await visualFixture(adapter)
  let live: typeof fixture.f | undefined = fixture.f
  try {
    const args = await originalImage(fixture)
    expect(await fixture.asCaptain('agent_swarm_request_visual_assistance', args)).toMatchObject({ isError: false })
    await claimedImage(fixture, assistanceRows(await fixture.team())[0]!.requestMessageId, fixture.helperId)
    expect(await fixture.asCaptain('agent_swarm_create_task', { subject: 'Existing work', description: 'Existing independent task must recover',
      target_member: 'vision', acceptance_criteria: ['Keep the original task identity'] })).toMatchObject({ isError: false })
    const before = await fixture.team()
    expect(before.tasks).toHaveLength(1)
    await live.close(); live = undefined
    const afterAdapter = new AssistanceRecording(); afterAdapter.autoRequest = false; afterAdapter.autoComplete = false
    live = await setupImages(fixture.sandbox, afterAdapter)
    await live.ctx.agentSwarm.recoverDormantManagedTeams()
    await vi.waitFor(() => expect(afterAdapter.requests.some(request => request.sessionId === fixture.captain.id
      && request.messages.some(message => message.content.some(part => part.type === 'text'
        && part.text.includes('The Host restarted while this managed Team still had unfinished work.'))))).toBe(true), { timeout: 3000 })
    const after = (await live.ctx.agentSwarm.domain.snapshot(fixture.scope, fixture.teamId, fixture.captain.id)).team
    expect(after.tasks.map(task => task.id)).toEqual(before.tasks.map(task => task.id))
    expect(assistanceRows(after)).toEqual(assistanceRows(before))
    expect(after.publicChat!.messages).toHaveLength(2)
  } finally { await live?.close(); await rm(fixture.sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 30_000)

it('cancels an actual request tool during attachment validation without committing a half collaboration', async () => {
  const adapter = new AssistanceRecording(); adapter.autoRequest = false; adapter.autoComplete = false
  const fixture = await visualFixture(adapter), entered = deferred(), gate = deferred()
  try {
    const args = await originalImage(fixture), original = fixture.f.ctx.attachments.readImage.bind(fixture.f.ctx.attachments)
    vi.spyOn(fixture.f.ctx.attachments, 'readImage').mockImplementation(async (...input) => {
      const read = await original(...input); entered.resolve(); await gate.promise; return read
    })
    const abort = new AbortController(), pending = fixture.asCaptain('agent_swarm_request_visual_assistance', args, abort.signal)
    await entered.promise; abort.abort(); gate.resolve()
    expect(await pending).toMatchObject({ isError: true })
    await fixture.f.ctx.agentSwarm.withPublicAdmissionFence(fixture.scope, fixture.teamId, SIGNAL, async () => {})
    expect(assistanceRows(await fixture.team())).toEqual([])
    expect((await fixture.team()).publicChat!.messages).toHaveLength(1)
  } finally { gate.resolve(); await fixture.close() }
}, 30_000)

it('closes an absent helper request that expires during its official image read and delivers only the system failure', async () => {
  let now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  const adapter = new AssistanceRecording(); adapter.autoRequest = false; adapter.autoComplete = false
  const fixture = await visualFixture(adapter), entered = deferred(), gate = deferred()
  try {
    const args = await originalImage(fixture), original = fixture.f.ctx.attachments.readImage.bind(fixture.f.ctx.attachments)
    let reads = 0
    vi.spyOn(fixture.f.ctx.attachments, 'readImage').mockImplementation(async (...input) => {
      const read = await original(...input)
      if (++reads === 2) { entered.resolve(); await gate.promise }
      return read
    })
    expect(await fixture.asCaptain('agent_swarm_request_visual_assistance', args)).toMatchObject({ isError: false })
    await entered.promise; now += VISUAL_ASSISTANCE_TTL_MS + 1; gate.resolve()
    await vi.waitFor(async () => {
      const team = await fixture.team()
      expect(team.publicChat!.messages).toHaveLength(3)
      expect(publicDeliveries(team.publicChat!.messages[1]!)[0]).toMatchObject({ state: 'not-delivered', reason: 'assistance-closed' })
      expect(publicDeliveries(team.publicChat!.messages[2]!)[0]).toMatchObject({ state: 'claimed' })
      expect(team.publicChat!.messages[2]).toMatchObject({ author: { kind: 'system' }, assistance: { outcome: { state: 'failed', reason: 'expired' } } })
    }, { timeout: 10_000 })
    const helper = await readPersistedSession(fixture.f.ctx.sessionPersistence, fixture.helperId, SIGNAL)
    const requestFrame = publicDeliveries((await fixture.team()).publicChat!.messages[1]!)[0]!.frame
    expect(helper.events.some(event => event.type === 'user/message' && event.data.content.some(part => part.type === 'text' && part.text === requestFrame))).toBe(false)
  } finally { gate.resolve(); await fixture.close(); clock.mockRestore() }
}, 30_000)

it.each(['absent', 'claimed'] as const)('checks a %s pending assistance deadline on cold recovery and preserves consumption evidence', async state => {
  let now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  const adapter = new AssistanceRecording(); adapter.autoRequest = false; adapter.autoComplete = false
  const fixture = await visualFixture(adapter)
  let live: typeof fixture.f | undefined = fixture.f
  try {
    const args = await originalImage(fixture)
    const request = fixture.f.ctx.agentSwarm.domain.requestVisualAssistance.bind(fixture.f.ctx.agentSwarm.domain)
    const committed = vi.spyOn(fixture.f.ctx.agentSwarm.domain, 'requestVisualAssistance').mockImplementation(async (...input) => {
      const result = await request(...input); if (state === 'absent') adapter.helperCapability = 'unknown'; return result
    })
    expect(await fixture.asCaptain('agent_swarm_request_visual_assistance', args)).toMatchObject({ isError: false })
    await vi.waitFor(async () => expect(publicDeliveries((await fixture.team()).publicChat!.messages[1]!)[0])
      .toMatchObject(state === 'claimed' ? { state: 'claimed' } : { state: 'queued', deferredReason: 'image-capability-unknown' }))
    await live.close(); live = undefined; committed.mockRestore()
    now += VISUAL_ASSISTANCE_TTL_MS + 1
    const afterAdapter = new AssistanceRecording(); afterAdapter.autoRequest = false; afterAdapter.autoComplete = false
    live = await setupImages(fixture.sandbox, afterAdapter)
    await live.ctx.agentSwarm.recoverDormantManagedTeams()
    const current = live
    await vi.waitFor(async () => {
      const team = (await current.ctx.agentSwarm.domain.snapshot(fixture.scope, fixture.teamId, fixture.captain.id)).team
      expect(team.publicChat!.messages).toHaveLength(3)
      expect(publicDeliveries(team.publicChat!.messages[2]!)[0]).toMatchObject({ state: 'claimed' })
      expect(publicDeliveries(team.publicChat!.messages[1]!)[0]).toMatchObject(state === 'claimed'
        ? { state: 'claimed' } : { state: 'not-delivered', reason: 'assistance-closed' })
      expect(team.publicChat!.messages[2]).toMatchObject({ author: { kind: 'system' }, assistance: { outcome: { state: 'failed', reason: 'expired' } } })
    }, { timeout: 10_000 })
    expect(afterAdapter.requests.filter(modelRequest => modelRequest.sessionId === fixture.helperId)).toHaveLength(0)
  } finally { await live?.close(); clock.mockRestore(); await rm(fixture.sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 30_000)

it('recovers a committed helper image request after full teardown and completes through the real helper model', async () => {
  const adapter = new AssistanceRecording(); adapter.autoRequest = false; adapter.autoComplete = false
  const fixture = await visualFixture(adapter)
  let live: typeof fixture.f | undefined = fixture.f
  try {
    const args = await originalImage(fixture)
    const request = fixture.f.ctx.agentSwarm.domain.requestVisualAssistance.bind(fixture.f.ctx.agentSwarm.domain)
    const committed = vi.spyOn(fixture.f.ctx.agentSwarm.domain, 'requestVisualAssistance').mockImplementation(async (...input) => {
      const result = await request(...input); adapter.helperCapability = 'unknown'; return result
    })
    expect(await fixture.asCaptain('agent_swarm_request_visual_assistance', args)).toMatchObject({ isError: false })
    await vi.waitFor(async () => expect(publicDeliveries((await fixture.team()).publicChat!.messages[1]!)[0])
      .toMatchObject({ state: 'queued', deferredReason: 'image-capability-unknown', projection: { mode: 'images' } }))
    const before = assistanceRows(await fixture.team())[0]!
    await live.close(); live = undefined; committed.mockRestore()
    const afterAdapter = new AssistanceRecording(); afterAdapter.autoRequest = false
    live = await setupImages(fixture.sandbox, afterAdapter)
    await live.ctx.agentSwarm.recoverDormantManagedTeams()
    const current = live
    await vi.waitFor(async () => {
      const team = (await current.ctx.agentSwarm.domain.snapshot(fixture.scope, fixture.teamId, fixture.captain.id)).team
      expect(team.publicChat!.messages).toHaveLength(3)
      expect(team.publicChat!.messages.every(row => publicDeliveries(row).every(recipient => recipient.state === 'claimed'))).toBe(true)
    }, { timeout: 10_000 })
    const team = (await live.ctx.agentSwarm.domain.snapshot(fixture.scope, fixture.teamId, fixture.captain.id)).team
    const row = assistanceRows(team)[0]!
    expect(row).toMatchObject({ assistanceId: before.assistanceId, requestMessageId: before.requestMessageId, resultId: before.resultId,
      result: { origin: 'helper', outcome: { state: 'completed' } } })
    expect(afterAdapter.calls).toEqual(['agent_swarm_complete_visual_assistance'])
    const original = team.publicChat!.messages[0]!
    if (!isPublicMessageV3(original)) throw new Error('Expected original image')
    const expectedRefs = original.content.filter(part => part.type === 'image').map(part => part.attachment)
    const input = afterAdapter.requests.filter(modelRequest => modelRequest.sessionId === fixture.helperId).flatMap(modelRequest => modelRequest.messages)
      .find(message => message.content.some(part => part.type === 'text' && part.text === publicDeliveries(team.publicChat!.messages[1]!)[0]!.frame))
    expect(input!.content.filter(part => part.type === 'image').map(part => part.attachment)).toEqual(expectedRefs)
  } finally { await live?.close(); await rm(fixture.sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 30_000)

it('repairs lost helper and result acknowledgements after full teardown without repeating either model delivery', async () => {
  const adapter = new AssistanceRecording(); adapter.autoRequest = false
  const fixture = await visualFixture(adapter)
  let live: typeof fixture.f | undefined = fixture.f
  try {
    const args = await originalImage(fixture)
    const ack = vi.spyOn(fixture.f.ctx.agentSwarm.domain, 'acknowledgePublicMessage').mockRejectedValue(new Error('Fixture lost assistance ACK'))
    expect(await fixture.asCaptain('agent_swarm_request_visual_assistance', args)).toMatchObject({ isError: false })
    await vi.waitFor(async () => {
      const team = await fixture.team()
      expect(team.publicChat!.messages).toHaveLength(3)
      for (const message of team.publicChat!.messages.slice(1)) {
        const delivery = publicDeliveries(message)[0]!
        if (delivery.frameVersion !== 3 || delivery.projection === undefined) throw new Error('Missing frozen input')
        expect(delivery.state).toBe('queued')
        expect(await frameVisibility(fixture.f.ctx, delivery.recipientSessionId, delivery.frame, SIGNAL, 'assistance cold cut', true,
          publicInputPredicates(delivery.frame, message.id, delivery.projection))).toBe('claimed')
      }
    }, { timeout: 10_000 })
    const before = await fixture.team()
    await live.close(); live = undefined; ack.mockRestore()
    const afterAdapter = new AssistanceRecording(); afterAdapter.autoRequest = false; afterAdapter.autoComplete = false
    live = await setupImages(fixture.sandbox, afterAdapter)
    await live.ctx.agentSwarm.recoverDormantManagedTeams()
    const team = (await live.ctx.agentSwarm.domain.snapshot(fixture.scope, fixture.teamId, fixture.captain.id)).team
    expect(team.publicChat!.messages.every(row => publicDeliveries(row).every(delivery => delivery.state === 'claimed'))).toBe(true)
    expect(assistanceRows(team)).toEqual(assistanceRows(before))
    expect(afterAdapter.requests.filter(modelRequest => modelRequest.sessionId === fixture.helperId || modelRequest.sessionId === fixture.captain.id)).toHaveLength(0)
    for (const message of team.publicChat!.messages.slice(1)) {
      const delivery = publicDeliveries(message)[0]!, persisted = await readPersistedSession(live.ctx.sessionPersistence, SessionId(delivery.recipientSessionId), SIGNAL)
      expect(persisted.events.filter(event => event.type === 'user/message' && event.data.content.some(part => part.type === 'text' && part.text === delivery.frame))).toHaveLength(1)
    }
  } finally { await live?.close(); await rm(fixture.sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 30_000)

it('reserves a durable result slot and its worst escaped summary before admitting unrelated public traffic', async () => {
  const adapter = new AssistanceRecording(); adapter.autoRequest = false; adapter.autoComplete = false
  const fixture = await visualFixture(adapter)
  let live: typeof fixture.f | undefined = fixture.f
  let storage: Awaited<ReturnType<typeof openStorageStack>> | undefined
  try {
    const args = await originalImage(fixture)
    expect(await fixture.asCaptain('agent_swarm_request_visual_assistance', args)).toMatchObject({ isError: false })
    await vi.waitFor(async () => expect(publicDeliveries((await fixture.team()).publicChat!.messages[1]!)[0]!.state).toBe('claimed'))
    const before = await fixture.team(), row = assistanceRows(before)[0]!, reserved = publicChatReservedBytes(before.publicChat!)
    await live.close(); live = undefined
    storage = await openStorageStack(join(fixture.sandbox, 'storage'))
    // Storage/Domain capacity boundary only; the image/tool/Session path above is real.
    const domain = new TeamDomain(storage.store, { ...DEFAULT_TEAM_LIMITS, maxPublicMessages: 3, maxPublicBytes: reserved })
    await expect(domain.appendPublicMessage(fixture.scope, fixture.teamId, { author: { kind: 'local-operator' },
      formatVersion: 2, requestId: 'cannot-spend-result-slot', content: [{ type: 'text', text: 'An unrelated message' }] }))
      .rejects.toMatchObject({ code: 'TEAM_PUBLIC_CAPACITY' })
    const limitedBytes = new TeamDomain(storage.store, { ...DEFAULT_TEAM_LIMITS, maxPublicBytes: reserved })
    await expect(limitedBytes.appendPublicMessage(fixture.scope, fixture.teamId, { author: { kind: 'local-operator' },
      formatVersion: 3, requestId: 'cannot-spend-result-bytes', content: [{ type: 'text', text: 'An unrelated message' }] }))
      .rejects.toMatchObject({ code: 'TEAM_PUBLIC_CAPACITY' })
    await domain.completeVisualAssistance(fixture.scope, fixture.teamId, fixture.helperId, { requestId: 'large-completion',
      assistanceId: row.assistanceId, outcome: { state: 'completed', summary: '\0'.repeat(8192) } })
    const after = (await domain.snapshot(fixture.scope, fixture.teamId, fixture.captain.id)).team
    expect(after.publicChat!.messages).toHaveLength(3)
    expect(publicChatReservedBytes(after.publicChat!)).toBeLessThanOrEqual(reserved)
    const invalid = structuredClone(after.publicChat!)
    if (invalid.schemaVersion !== 3) throw new Error('Expected v3 graph')
    invalid.assistances![0]!.visited.reverse()
    expect(() => assertPublicChat(invalid, after.id, after.captainSessionId, after.managedOrigin)).toThrow('Invalid visual collaboration graph')
  } finally { await storage?.close(); await live?.close(); await rm(fixture.sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 30_000)

it('returns bounded real tool failures for unavailable/unknown helpers and unreadable original images', async () => {
  const adapter = new AssistanceRecording(); adapter.autoRequest = false; adapter.autoComplete = false
  const fixture = await visualFixture(adapter)
  try {
    const args = await originalImage(fixture)
    expect(await fixture.asCaptain('agent_swarm_request_visual_assistance', { ...args, helper_member_id: 'absent-member' }))
      .toMatchObject({ isError: true, error: { info: { code: 'TEAM_VISUAL_HELPER_UNAVAILABLE' } } })
    adapter.helperCapability = 'unknown'
    expect(await fixture.asCaptain('agent_swarm_request_visual_assistance', args))
      .toMatchObject({ isError: true, error: { info: { code: 'TEAM_VISUAL_CAPABILITY_UNKNOWN' } } })
    adapter.helperCapability = 'unsupported'
    expect(await fixture.asCaptain('agent_swarm_request_visual_assistance', args))
      .toMatchObject({ isError: true, error: { info: { code: 'TEAM_VISUAL_MODEL_UNSUPPORTED' } } })
    adapter.helperCapability = 'supported'
    vi.spyOn(fixture.f.ctx.attachments, 'readImage').mockRejectedValueOnce(new Error('private C:/store/ref credential'))
    const failed = await fixture.asCaptain('agent_swarm_request_visual_assistance', args)
    expect(failed).toMatchObject({ isError: true, error: { info: { code: 'TEAM_VISUAL_IMAGE_UNAVAILABLE' } } })
    expect(JSON.stringify(failed)).not.toMatch(/C:\/store|credential/u)
    expect(assistanceRows(await fixture.team())).toHaveLength(0)
    expect((await fixture.team()).publicChat!.messages).toHaveLength(1)
  } finally { await fixture.close() }
}, 30_000)

it.each(['expired', 'helper-unavailable'] as const)('publishes a system %s result and returns it to the original member without replacing the terminal fact', async reason => {
  let now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  const adapter = new AssistanceRecording(); adapter.autoRequest = false; adapter.autoComplete = false
  const fixture = await visualFixture(adapter)
  try {
    const args = await originalImage(fixture)
    expect(await fixture.asCaptain('agent_swarm_request_visual_assistance', args)).toMatchObject({ isError: false })
    const request = (await fixture.team()).publicChat!.messages[1]!
    await claimedImage(fixture, request.id, fixture.helperId)
    if (reason === 'expired') now += VISUAL_ASSISTANCE_TTL_MS + 1
    else expect(await fixture.asCaptain('agent_swarm_remove_member', { name: 'vision', reason: 'Fixture revocation' })).toMatchObject({ isError: false })
    const page = await fixture.call('history')
    expect(page.ok, JSON.stringify(page)).toBe(true)
    expect(page.value.entries[2]).toMatchObject({ author: { kind: 'system' }, assistance: { kind: 'result', outcome: { state: 'failed', reason } } })
    await claimedImage(fixture, page.value.entries[2]!.id, fixture.captain.id)
    const row = assistanceRows(await fixture.team())[0]!
    if (reason === 'expired') expect(await fixture.asHelper('agent_swarm_complete_visual_assistance', {
      request_id: 'too-late', assistance_id: row.assistanceId, outcome: { state: 'completed', summary: 'Late replacement' },
    })).toMatchObject({ isError: true, error: { info: { code: 'TEAM_VISUAL_EXPIRED' } } })
    const again = assistanceRows(await fixture.team())[0]!
    expect(again).toEqual(row)
    expect((await fixture.team()).publicChat!.messages).toHaveLength(3)
    const persisted = await readPersistedSession(fixture.f.ctx.sessionPersistence, fixture.captain.id, SIGNAL)
    const frame = publicDeliveries((await fixture.team()).publicChat!.messages[2]!)[0]!.frame
    expect(persisted.events.filter(event => event.type === 'user/message' && event.data.content.some(part => part.type === 'text' && part.text === frame)))
      .toMatchObject([{ data: { source: { kind: 'plugin', plugin: 'dsh-agent-swarm' } } }])
  } finally { await fixture.close(); clock.mockRestore() }
}, 30_000)


it('binds original image-2 and image-10 to their actual helper image blocks and preserves the ordered links in the result', async () => {
  const adapter = new AssistanceRecording(); adapter.autoRequest = false; adapter.autoComplete = false
  const fixture = await visualFixture(adapter)
  try {
    const images = Array.from({ length: 10 }, (_, index) => ({ ...(index === 1 ? GIF_IMAGE : PNG_IMAGE), name: `original-${index + 1}.${index === 1 ? 'gif' : 'png'}` }))
    const sent = await fixture.call('append', { requestId: 'ten-original-images', content: images })
    expect(sent.ok, JSON.stringify(sent)).toBe(true)
    await vi.waitFor(async () => expect(publicDeliveries((await fixture.team()).publicChat!.messages[0]!)[0]!.state).toBe('claimed'))
    const source = (await fixture.team()).publicChat!.messages[0]!
    if (!isPublicMessageV3(source)) throw new Error('Expected v3 source')
    const original = source.content.filter((part): part is StoredPublicImageSegment => part.type === 'image' && ['image-2', 'image-10'].includes(part.imageId))
    expect(original.map(part => part.imageId)).toEqual(['image-2', 'image-10'])
    const requested = await fixture.asCaptain('agent_swarm_request_visual_assistance', { request_id: 'two-and-ten',
      source_message_id: sent.value.message.id, image_ids: ['image-10', 'image-2'], helper_member_id: fixture.helperId,
      question: 'Describe original image-2, then original image-10, with their exact IDs.' })
    expect(requested.isError, JSON.stringify(requested)).toBe(false)
    await vi.waitFor(async () => expect(publicDeliveries((await fixture.team()).publicChat!.messages[1]!)[0]!.state).toBe('claimed'))
    const team = await fixture.team(), row = assistanceRows(team)[0]!, request = team.publicChat!.messages[1]!
    // The durable dedup set is sorted; the frame and model blocks must agree on actual source order.
    expect(row.imageIds).toEqual(['image-10', 'image-2'])
    const session = await readPersistedSession(fixture.f.ctx.sessionPersistence, fixture.helperId, SIGNAL)
    const frame = publicDeliveries(request)[0]!.frame
    const delivered = session.events.find(event => event.type === 'user/message' && event.data.content.some(part => part.type === 'text' && part.text === frame))
    if (delivered?.type !== 'user/message') throw new Error('Missing actual helper input')
    const actualModelInput = adapter.requests.filter(modelRequest => modelRequest.sessionId === fixture.helperId).flatMap(modelRequest => modelRequest.messages)
      .find(message => message.content.some(part => part.type === 'text' && part.text === frame))
    expect(actualModelInput?.content).toEqual(delivered.data.content)
    const metadata = JSON.parse(frame.split('Message data (JSON): ')[1]!)
    expect(metadata.assistance.imageIds).toEqual(['image-2', 'image-10'])
    const pairs = delivered.data.content.flatMap((block, index) => block.type !== 'image' ? [] : [{ image: block.attachment, previous: delivered.data.content[index - 1] }])
    expect(pairs.map(pair => pair.image)).toEqual(original.map(part => part.attachment))
    for (const [index, pair] of pairs.entries()) {
      expect(pair.previous).toEqual({ type: 'text', text: `The next image block is this original public image: ${JSON.stringify({ source_message_id: source.id, image_id: original[index]!.imageId })}` })
    }
    const invalid = structuredClone(team.publicChat!)
    const invalidRequest = invalid.messages[1]!
    if (!isPublicMessageV3(invalidRequest) || invalidRequest.delivery.kind !== 'requested') throw new Error('Expected request delivery')
    const projection = invalidRequest.delivery.recipients[0]!.projection!
    const marker = projection.content.find(block => block.type === 'text' && block.text.startsWith('The next image block is this original public image:'))
    if (marker?.type !== 'text') throw new Error('Expected frozen image marker')
    marker.text = marker.text.replace('image-2', 'image-10')
    expect(() => assertPublicChat(invalid, team.id, team.captainSessionId, team.managedOrigin)).toThrow()
    const requestStored = isPublicMessageV3(request) ? request : undefined
    expect(requestStored?.content.filter(part => part.type === 'image').map(part => part.imageId)).toEqual(['image-1', 'image-2'])
    const completion = await fixture.asHelper('agent_swarm_complete_visual_assistance', { request_id: 'mapped-completion', assistance_id: row.assistanceId,
      outcome: { state: 'completed', summary: 'Original image-2 is the GIF; original image-10 is the PNG.' } })
    expect(completion.isError, JSON.stringify(completion)).toBe(false)
    const final = await fixture.call('history')
    expect(final.ok, JSON.stringify(final)).toBe(true)
    expect(final.value.entries[2]).toMatchObject({ assistance: { kind: 'result', sourceMessageId: source.id, imageIds: ['image-2', 'image-10'] } })
  } finally { await fixture.close() }
}, 30_000)


it.each(['request', 'result'] as const)('keeps literal odd/even backslashes before @ in real assistance %s history and model input', async kind => {
  const adapter = new AssistanceRecording(); adapter.autoRequest = false; adapter.autoComplete = false
  const fixture = await visualFixture(adapter)
  const literal = String.raw`C:\@folder \@name \\@name \\\@name \\\\@name`
  try {
    const args = await originalImage(fixture)
    expect(await fixture.asCaptain('agent_swarm_request_visual_assistance', { ...args, question: literal })).toMatchObject({ isError: false })
    await vi.waitFor(async () => expect(publicDeliveries((await fixture.team()).publicChat!.messages[1]!)[0]!.state).toBe('claimed'))
    const row = assistanceRows(await fixture.team())[0]!
    expect(await fixture.asHelper('agent_swarm_complete_visual_assistance', { request_id: 'literal-complete', assistance_id: row.assistanceId,
      outcome: { state: 'completed', summary: literal } })).toMatchObject({ isError: false })
    await vi.waitFor(async () => expect(publicDeliveries((await fixture.team()).publicChat!.messages[2]!)[0]!.state).toBe('claimed'))
    const index = kind === 'request' ? 1 : 2, recipient = kind === 'request' ? fixture.helperId : fixture.captain.id
    const page = await fixture.call('history')
    expect(page.value.entries[index].text).toBe(literal)
    const message = (await fixture.team()).publicChat!.messages[index]!, frame = publicDeliveries(message)[0]!.frame
    const input = adapter.requests.filter(request => request.sessionId === recipient).flatMap(request => request.messages)
      .find(candidate => candidate.content.some(part => part.type === 'text' && part.text === frame))
    expect(input?.content[1]).toEqual({ type: 'text', text: literal })
    const persisted = await readPersistedSession(fixture.f.ctx.sessionPersistence, recipient, SIGNAL)
    const delivered = persisted.events.find(event => event.type === 'user/message' && event.data.content.some(part => part.type === 'text' && part.text === frame))
    if (delivered?.type !== 'user/message') throw new Error('Missing actual assistance input')
    expect(delivered.data.content[1]).toEqual({ type: 'text', text: literal })
  } finally { await fixture.close() }
}, 30_000)
