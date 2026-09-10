import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, textOnlyImageText } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { isPublicMessageV3, publicDeliveries } from '../src/domain/public-message.js'
import { readPersistedSession } from '../src/runtime/persisted-session.js'
import { frameVisibility, waitForFrameClaim } from '../src/runtime/frame-visibility.js'
import { publicInputPredicates } from '../src/runtime/public-image-delivery.js'
import { addPublicMembers, createTeam } from './helpers/public-chat-real-composition.js'
import { RESTART_SIGNAL as SIGNAL } from './helpers/restart-real-composition.js'
import { PNG_IMAGE, GIF_IMAGE, ImageRecording, setupImages, imageClient } from './helpers/public-images-real-composition.js'

const noRelease = () => {}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

it('admits real pure/mixed images atomically and delivers exact ordered official references with human provenance', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-public-images-'))
  const adapter = new ImageRecording(), f = await setupImages(sandbox, adapter)
  try {
    const { captain, teamId, scope } = await createTeam(f, sandbox)
    const call = await imageClient(f, teamId)
    const before = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
    const sent = await call('append', { requestId: 'pure-image', content: [PNG_IMAGE] })
    expect(sent, JSON.stringify(sent)).toMatchObject({ ok: true, value: { schemaVersion: 3, message: { formatVersion: 3 } } })
    const mixed = await call('append', { requestId: 'mixed-image', content: [{ type: 'text', text: '看第一张' },
      GIF_IMAGE, { type: 'text', text: '再看第二张' }, PNG_IMAGE, GIF_IMAGE] })
    expect(mixed.ok, JSON.stringify(mixed)).toBe(true)
    await vi.waitFor(async () => {
      const team = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
      expect(team.publicChat?.messages).toHaveLength(2)
      expect(team.publicChat!.messages.every(row => publicDeliveries(row).every(delivery => delivery.state === 'claimed'))).toBe(true)
    }, { timeout: 10_000 })
    const team = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
    expect(team.tasks).toEqual(before.tasks)
    const persisted = await readPersistedSession(f.ctx.sessionPersistence, captain.id, SIGNAL)
    const frames = team.publicChat!.messages.map(row => publicDeliveries(row)[0]!.frame)
    for (const [index, frame] of frames.entries()) {
      const accepted = persisted.events.filter(event => event.type === 'user/message'
        && event.data.content.some(block => block.type === 'text' && block.text === frame))
      expect(accepted).toHaveLength(1)
      const event = accepted[0]!
      if (event.type !== 'user/message') throw new Error('Expected user message')
      expect(event.data.source).toEqual({ kind: 'user', rpcId: team.publicChat!.messages[index]!.id })
      const images = event.data.content.filter(block => block.type === 'image')
      expect(images).toHaveLength(index === 0 ? 1 : 3)
      const original = team.publicChat!.messages[index]!
      if (!isPublicMessageV3(original)) throw new Error('Expected v3 original')
      const expectedRefs = original.content.filter(part => part.type === 'image').map(part => part.attachment)
      expect(images.map(image => image.attachment)).toEqual(expectedRefs)
      for (const image of images) expect((await f.ctx.attachments.readImage(image.attachment, SIGNAL)).ref).toEqual(image.attachment)
      const modelMessage = adapter.requests.filter(request => request.sessionId === captain.id).flatMap(request => request.messages)
        .find(message => message.role === 'user' && message.content.some(block => block.type === 'text' && block.text === frame))
      expect(modelMessage).toBeDefined()
      expect(modelMessage!.content.filter(block => block.type === 'image').map(image => image.attachment)).toEqual(expectedRefs)
    }
    const page = await call('history')
    expect(page.value.imageAvailability).toEqual({ state: 'available', imageLimits: f.ctx.attachments.imageLimits })
    expect(JSON.stringify(page)).not.toMatch(/attachmentId|bindingDigest|frameVersion|"data"/u)
    expect(page.value.entries[1].content.filter((part: { type: string }) => part.type === 'image').map((part: { imageId: string }) => part.imageId))
      .toEqual(['image-1', 'image-2', 'image-3'])
  } finally { await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 30_000)

it('queries retries before admission, rejects byte/MIME/name conflicts and protects the authorized image read', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-public-images-retry-'))
  const adapter = new ImageRecording(); adapter.imageInput = 'unknown'
  const f = await setupImages(sandbox, adapter)
  try {
    const { captain, teamId, scope } = await createTeam(f, sandbox), call = await imageClient(f, teamId)
    const admit = vi.spyOn(f.ctx.attachments, 'admitPromptContent')
    const sent = await call('append', { requestId: 'same-original', content: [PNG_IMAGE] })
    expect(sent.ok, JSON.stringify(sent)).toBe(true)
    await vi.waitFor(async () => expect((await call('history')).value?.entries[0].delivery.recipients[0].deferredReason).toBe('image-capability-unknown'))
    expect((await call('append', { requestId: 'same-original', content: [PNG_IMAGE] })).value).toMatchObject({ replayed: true, message: { id: sent.value.message.id } })
    for (const image of [{ ...PNG_IMAGE, name: 'renamed.png' }, { ...PNG_IMAGE, mediaType: 'image/gif' }, { ...PNG_IMAGE, data: 'AQID' }]) {
      expect(await call('append', { requestId: 'same-original', content: [image] })).toMatchObject({ ok: false, error: { code: 'TEAM_PUBLIC_REQUEST_CONFLICT' } })
    }
    expect(admit).toHaveBeenCalledTimes(1)
    const result = await call('requestResult', { requestId: 'same-original' })
    expect(result.value).toMatchObject({ state: 'committed', message: { id: sent.value.message.id, formatVersion: 3 } })
    const image = await call('image', { messageId: sent.value.message.id, imageId: 'image-1' })
    expect(image.ok, JSON.stringify(image)).toBe(true)
    const { type: _type, imageId: _imageId, ...metadata } = sent.value.message.content[0]
    expect(image.value.image).toMatchObject(metadata)
    // History-only addressing fields are outside the image payload.
    expect(image.value.image.imageId).toBeUndefined()
    const team = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
    const original = team.publicChat!.messages[0]!
    if (!isPublicMessageV3(original) || original.content[0]?.type !== 'image') throw new Error('Expected image original')
    const stored = await f.ctx.attachments.readImage(original.content[0].attachment, SIGNAL)
    expect(Buffer.from(image.value.image.data, 'base64')).toEqual(Buffer.from(stored.data))
    expect(await call('image', { messageId: 'foreign-message', imageId: 'image-1' })).toMatchObject({ ok: false, error: { code: 'TEAM_PUBLIC_IMAGE_NOT_FOUND' } })
    expect(await call('image', { messageId: original.id, imageId: 'image-1', attachmentId: original.content[0].attachment.attachmentId }))
      .toMatchObject({ ok: false, error: { code: 'SWARM_RPC_INVALID_REQUEST' } })
    const foreign = (await f.ctx.agents.create({ sessionId: SessionId('foreign-image-reader'), meta: { cwd: join(sandbox, 'workspace') } })).agent
    expect((await call('image', { target: { rootSessionId: foreign.id, teamId }, messageId: original.id, imageId: 'image-1' })).ok).toBe(false)
    expect(await call('history', {}, 2)).toMatchObject({ ok: false, error: { code: 'SWARM_PUBLIC_VERSION_REQUIRED' } })
    expect(await call('requestResult', { requestId: 'same-original' }, 2)).toMatchObject({ ok: false, error: { code: 'SWARM_PUBLIC_VERSION_REQUIRED' } })
    expect(await call('append', { requestId: 'same-original', content: [{ type: 'text', text: 'different version' }] }, 2))
      .toMatchObject({ ok: false, error: { code: 'SWARM_PUBLIC_VERSION_REQUIRED' } })
    const rejected = await call('append', { requestId: 'invalid-batch', content: [PNG_IMAGE, { ...PNG_IMAGE, data: 'AQID' }] })
    expect(rejected).toMatchObject({ ok: false, error: { code: 'TEAM_PUBLIC_IMAGE_INVALID' } })
    expect((await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team.publicChat!.messages).toHaveLength(1)
    admit.mockRejectedValueOnce(new AttachmentError('private C:/private/store/blob credentials', 'ATTACHMENT_WRITE_FAILED'))
    const privateError = await call('append', { requestId: 'private-error', content: [PNG_IMAGE] })
    expect(privateError.error.message).not.toMatch(/private|credentials|C:\//u)
    const oldText = await call('append', { requestId: 'new-v2-text', content: [{ type: 'text', text: 'v2 still works' }] }, 2)
    expect(oldText.ok, JSON.stringify(oldText)).toBe(true)
    await vi.waitFor(async () => expect((await call('history')).value?.entries.map((row: { formatVersion: number }) => row.formatVersion)).toEqual([3, 2]))
  } finally { await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 30_000)

it('keeps text usable without attachments and freezes text-only input after explicit capability resolution', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-public-image-capability-'))
  const adapter = new ImageRecording(); adapter.imageInput = 'unknown'
  let f = await setupImages(sandbox, adapter, false)
  try {
    const { captain, teamId, scope } = await createTeam(f, sandbox)
    let call = await imageClient(f, teamId)
    expect((await call('history')).value.imageAvailability).toEqual({ state: 'unavailable', reason: 'attachment-service-unavailable' })
    expect(await call('append', { requestId: 'no-service', content: [PNG_IMAGE] })).toMatchObject({ ok: false, error: { code: 'TEAM_PUBLIC_IMAGE_UNAVAILABLE' } })
    expect((await call('append', { requestId: 'text-without-service', content: [{ type: 'text', text: 'text remains available' }] })).ok).toBe(true)
    await vi.waitFor(async () => expect(publicDeliveries((await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team.publicChat!.messages[0]!)[0]!.state).toBe('claimed'))
    await f.close(); f = await setupImages(sandbox, adapter); call = await imageClient(f, teamId)
    const sent = await call('append', { requestId: 'resolve-images', content: [PNG_IMAGE] })
    expect(sent.ok, JSON.stringify(sent)).toBe(true)
    const row = async () => (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team.publicChat!.messages.find(message => message.id === sent.value.message.id)!
    await vi.waitFor(async () => expect(publicDeliveries(await row())[0]).toMatchObject({ state: 'queued', deferredReason: 'image-capability-unknown' }))
    expect(publicDeliveries(await row())[0]).not.toHaveProperty('projection')
    const acknowledge = vi.spyOn(f.ctx.agentSwarm.domain, 'acknowledgePublicMessage').mockRejectedValue(new Error('lose fixture ACK'))
    adapter.imageInput = 'unsupported'; f.ctx.agentSwarm.kickPublicMessages(scope, teamId)
    await vi.waitFor(async () => {
      const current = await row(), delivery = publicDeliveries(current)[0]!
      expect(delivery).toMatchObject({ state: 'queued', projection: { mode: 'text-only' } })
      if (delivery.frameVersion !== 3 || delivery.projection === undefined || !isPublicMessageV3(current)) throw new Error('Expected prepared input')
      expect(await frameVisibility(f.ctx, captain.id, delivery.frame, SIGNAL, 'fixture text-only', true,
        publicInputPredicates(delivery.frame, current.id, delivery.projection))).toBe('claimed')
      expect(delivery.projection.content.every(part => part.type === 'text')).toBe(true)
      const image = current.content.find(part => part.type === 'image')!
      expect(delivery.projection.content[1]).toEqual({ type: 'text', text: `${textOnlyImageText(image.attachment)}\nPublic image reference: ${JSON.stringify({ source_message_id: current.id, image_id: image.imageId })}` })
    }, { timeout: 10_000 })
    await f.ctx.agents.get(captain.id)?.whenIdle()
    const frame = publicDeliveries(await row())[0]!.frame
    const claims = async () => (await readPersistedSession(f.ctx.sessionPersistence, captain.id, SIGNAL)).events.filter(event =>
      event.type === 'user/message' && event.data.content.some(part => part.type === 'text' && part.text === frame))
    expect(await claims()).toHaveLength(1)
    adapter.imageInput = 'supported'; acknowledge.mockRestore(); f.ctx.agentSwarm.kickPublicMessages(scope, teamId)
    await vi.waitFor(async () => expect(publicDeliveries(await row())[0]).toMatchObject({ state: 'claimed', projection: { mode: 'text-only' } }))
    // Model steps may still finish across the claim boundary; duplicate delivery is a Session fact.
    expect(await claims()).toHaveLength(1)
  } finally { await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 30_000)

it('reconciles durable image claim across complete teardown without another admission or model delivery', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-public-images-cold-'))
  let f = await setupImages(sandbox)
  try {
    const { captain, teamId, scope } = await createTeam(f, sandbox), call = await imageClient(f, teamId)
    const acknowledge = vi.spyOn(f.ctx.agentSwarm.domain, 'acknowledgePublicMessage').mockRejectedValue(new Error('lost image ACK'))
    const sent = await call('append', { requestId: 'cold-images', content: [GIF_IMAGE, PNG_IMAGE] })
    expect(sent.ok, JSON.stringify(sent)).toBe(true)
    await vi.waitFor(async () => {
      const row = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team.publicChat!.messages[0]!, delivery = publicDeliveries(row)[0]!
      if (delivery.frameVersion !== 3 || delivery.projection === undefined) throw new Error('Input not prepared yet')
      expect(await frameVisibility(f.ctx, captain.id, delivery.frame, SIGNAL, 'fixture before cold', true,
        publicInputPredicates(delivery.frame, row.id, delivery.projection))).toBe('claimed')
      expect(delivery.state).toBe('queued')
    }, { timeout: 10_000 })
    await f.close(); acknowledge.mockRestore()
    const adapter = new ImageRecording(); f = await setupImages(sandbox, adapter)
    const admitted = vi.spyOn(f.ctx.attachments, 'admitPromptContent'), nextCall = await imageClient(f, teamId)
    f.ctx.agentSwarm.kickPublicMessages(scope, teamId)
    await vi.waitFor(async () => expect(publicDeliveries((await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team.publicChat!.messages[0]!)[0]?.state).toBe('claimed'))
    expect((await nextCall('append', { requestId: 'cold-images', content: [GIF_IMAGE, PNG_IMAGE] })).value).toMatchObject({ replayed: true, message: { id: sent.value.message.id } })
    expect(admitted).not.toHaveBeenCalled()
    expect(adapter.requests.filter(request => request.sessionId === captain.id)).toHaveLength(0)
  } finally { await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 30_000)

it.each(['missing', 'wrong-image', 'wrong-order', 'wrong-source', 'wrong-text'] as const)('does not acknowledge or replay a same-identity %s frame, even beside a complete duplicate', async fault => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-public-images-mismatch-'))
  const adapter = new ImageRecording(); adapter.imageInput = 'unknown'
  const f = await setupImages(sandbox, adapter)
  try {
    const { root, captain, teamId, scope } = await createTeam(f, sandbox), call = await imageClient(f, teamId)
    const sent = await call('append', { requestId: 'mismatched-input', content: [GIF_IMAGE, PNG_IMAGE] })
    expect(sent.ok, JSON.stringify(sent)).toBe(true)
    await vi.waitFor(async () => expect(publicDeliveries((await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team.publicChat!.messages[0]!)[0])
      .toMatchObject({ state: 'queued', deferredReason: 'image-capability-unknown' }))
    const prepared = await f.ctx.agentSwarm.domain.preparePublicImageDelivery(scope, teamId, sent.value.message.id, captain.id, 'images')
    if (prepared.projection === undefined) throw new Error('Expected projection')
    const projection = prepared.projection, malformed = structuredClone(projection.content)
    if (fault === 'missing') malformed.splice(1, 1)
    if (fault === 'wrong-image') malformed[1] = structuredClone(malformed[2]!)
    if (fault === 'wrong-order') [malformed[1], malformed[2]] = [malformed[2]!, malformed[1]!]
    if (fault === 'wrong-text') malformed[0] = { type: 'text', text: 'Changed frame but retained rpcId' }
    await f.ctx.subagents.withContinuableChild(root, captain.id, SIGNAL, async active => {
      active.followup(createUserMessage({ content: malformed, source: fault === 'wrong-source' ? { kind: 'plugin', plugin: 'fixture' } : projection.source }))
      active.followup(createUserMessage({ content: structuredClone(projection.content), source: projection.source }))
      await active.whenIdle()
      expect(await f.ctx.sessions.flush(active.session)).toBe(true)
      const predicates = publicInputPredicates(prepared.frame, sent.value.message.id, projection)
      expect(await frameVisibility(f.ctx, active.id, prepared.frame, SIGNAL, 'fixture malformed live', true, predicates)).toBe('unknown')
      expect(await waitForFrameClaim(f.ctx, active, prepared.frame, SIGNAL, 0, true, predicates)).toBe(false)
    })
    const count = adapter.requests.length
    f.ctx.agentSwarm.kickPublicMessages(scope, teamId)
    await vi.waitFor(async () => expect(publicDeliveries((await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team.publicChat!.messages[0]!)[0])
      .toMatchObject({ state: 'queued', deferredReason: 'projection-mismatch' }))
    expect((await call('append', { requestId: 'mismatched-input', content: [GIF_IMAGE, PNG_IMAGE] })).value.replayed).toBe(true)
    expect(adapter.requests).toHaveLength(count)
    await vi.waitFor(() => expect(f.ctx.agents.get(captain.id)).toBeUndefined())
    expect(await frameVisibility(f.ctx, captain.id, prepared.frame, SIGNAL, 'fixture malformed cold', true,
      publicInputPredicates(prepared.frame, sent.value.message.id, projection))).toBe('unknown')
  } finally { await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 30_000)

it('keeps a frozen images projection deferred after model support is withdrawn or its image cannot be read', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-public-images-withdrawn-'))
  const adapter = new ImageRecording(); adapter.imageInput = 'unknown'
  const f = await setupImages(sandbox, adapter)
  try {
    const { captain, teamId, scope } = await createTeam(f, sandbox), call = await imageClient(f, teamId)
    const sent = await call('append', { requestId: 'frozen-images', content: [PNG_IMAGE] })
    expect(sent.ok, JSON.stringify(sent)).toBe(true)
    const row = async () => (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team.publicChat!.messages[0]!
    await vi.waitFor(async () => expect(publicDeliveries(await row())[0]).toMatchObject({ deferredReason: 'image-capability-unknown' }))
    const prepared = await f.ctx.agentSwarm.domain.preparePublicImageDelivery(scope, teamId, sent.value.message.id, captain.id, 'images')
    adapter.imageInput = 'unsupported'; f.ctx.agentSwarm.kickPublicMessages(scope, teamId)
    await vi.waitFor(async () => expect(publicDeliveries(await row())[0]).toMatchObject({ state: 'queued', deferredReason: 'image-model-unsupported', projection: prepared.projection }))
    const read = vi.spyOn(f.ctx.attachments, 'readImage').mockRejectedValue(new AttachmentError('fixture unreadable object', 'ATTACHMENT_NOT_FOUND'))
    adapter.imageInput = 'supported'; f.ctx.agentSwarm.kickPublicMessages(scope, teamId)
    await vi.waitFor(async () => expect(publicDeliveries(await row())[0]).toMatchObject({ state: 'queued', deferredReason: 'image-unavailable', projection: prepared.projection }))
    expect(await frameVisibility(f.ctx, captain.id, prepared.frame, SIGNAL, 'withdrawn not sent', true,
      publicInputPredicates(prepared.frame, sent.value.message.id, prepared.projection))).toBe('absent')
    read.mockRestore()
  } finally { await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 30_000)

it('checks cancellation after official attachment publication and before the Team transaction', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-public-images-cancel-'))
  const f = await setupImages(sandbox)
  let release = noRelease
  try {
    const { captain, teamId, scope } = await createTeam(f, sandbox), call = await imageClient(f, teamId)
    const entered = deferred(), gate = deferred(), closed = deferred()
    release = () => gate.resolve()
    const original = f.ctx.attachments.admitPromptContent.bind(f.ctx.attachments)
    vi.spyOn(f.ctx.attachments, 'admitPromptContent').mockImplementation(async content => {
      const admitted = await original(content)
      entered.resolve(); await gate.promise
      return admitted
    })
    const route = f.routes.find(candidate => candidate.path === '/swarm-public')!, handler = route.handler
    route.handler = (req, res) => { res.once('close', () => closed.resolve()); return handler(req, res) }
    const abort = new AbortController(), pending = call('append', { requestId: 'cancelled-image', content: [PNG_IMAGE] }, 3, abort.signal).catch(error => error)
    await entered.promise; abort.abort(); await pending; await closed.promise; release()
    await f.ctx.agentSwarm.withPublicAdmissionFence(scope, teamId, SIGNAL, async () => {})
    expect((await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team.publicChat?.messages ?? []).toEqual([])
    expect((await call('requestResult', { requestId: 'cancelled-image' })).value).toMatchObject({ state: 'not-found' })
    route.handler = handler
  } finally { release(); await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 30_000)

it('refuses image bytes if the requesting Team member is removed during the official read', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-public-images-revoke-'))
  const adapter = new ImageRecording(); adapter.imageInput = 'unknown'
  const f = await setupImages(sandbox, adapter)
  let release = noRelease
  try {
    const { root, captain, teamId, scope } = await createTeam(f, sandbox)
    const [member] = await addPublicMembers(f, root, captain.id), call = await imageClient(f, teamId)
    const sent = await call('append', { requestId: 'member-read', content: [PNG_IMAGE] })
    expect(sent.ok, JSON.stringify(sent)).toBe(true)
    await vi.waitFor(async () => expect((await call('history')).value?.entries[0].delivery.recipients[0].deferredReason).toBe('image-capability-unknown'))
    const entered = deferred(), gate = deferred()
    release = () => gate.resolve()
    const original = f.ctx.attachments.readImage.bind(f.ctx.attachments)
    const read = vi.spyOn(f.ctx.attachments, 'readImage').mockImplementation(async (...args) => {
      const verified = await original(...args)
      entered.resolve(); await gate.promise
      return verified
    })
    const pending = call('image', { target: { rootSessionId: member, teamId }, messageId: sent.value.message.id, imageId: 'image-1' })
    await entered.promise
    await f.ctx.agentSwarm.domain.removeMember(scope, teamId, captain.id, 'alpha', 'fixture revocation during read')
    release()
    const result = await pending
    expect(result).toMatchObject({ ok: false, error: { code: 'SWARM_HOST_BINDING_MISMATCH' } })
    expect(result.value).toBeUndefined()
    read.mockRestore()
  } finally { release(); await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 30_000)
