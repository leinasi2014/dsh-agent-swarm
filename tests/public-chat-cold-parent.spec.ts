/** Cold public delivery must reconstruct the parent that receives the real child settlement. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { publicDeliveries } from '../src/domain/public-message.js'
import { readPersistedSession } from '../src/runtime/persisted-session.js'
import { ROOT, Recording, setup, createTeam, publicClient } from './helpers/public-chat-real-composition.js'
import { RESTART_SIGNAL as SIGNAL } from './helpers/restart-real-composition.js'

const CAPTAIN_MODEL = 'cold-captain-model'
const MEMBER_MODEL = 'cold-member-model'
const DEPLOYMENT = 'Deployment route {{model}}.'

function systemText(request: GenerateOptions): string {
  const head = request.messages[0]
  return head?.role === 'system'
    ? head.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('')
    : ''
}

/** The sole scripted boundary is the model; recruitment and replies use actual tools. */
class ColdConversation extends Recording {
  private recruited = false
  private publicCalls = 0
  memberId?: string
  constructor(private readonly recruit: boolean) { super() }

  private async * call(options: GenerateOptions, name: string, args: object, label: string): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const id = ToolCallId(label), arguments_ = JSON.stringify(args)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: arguments_ }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: arguments_ } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (this.recruit && options.sessionId !== ROOT && !this.recruited) {
      this.recruited = true
      yield* this.call(options, 'agent_swarm_add_member', {
        name: 'cold-member', role: 'Public conversation', profession: 'Software engineer',
        llm_provider: 'public-fixture', model: MEMBER_MODEL,
        deny_tools: ['agent_swarm_add_private_memory'],
      }, 'cold-parent-recruit')
      return
    }
    const frame = options.messages.filter(message => message.role === 'user').flatMap(message => message.content)
      .find(part => part.type === 'text' && part.text.startsWith('Public Team message, frame version '))
    if (options.sessionId === this.memberId && frame?.type === 'text' && this.publicCalls < 2) {
      const message = JSON.parse(frame.text.split('Message data (JSON): ')[1]!) as { messageId: string }
      const index = ++this.publicCalls
      yield* this.call(options, index === 1 ? 'agent_swarm_public_reply' : 'agent_swarm_public_post',
        index === 1
          ? { request_id: 'cold-parent-reply', reply_to: message.messageId, text: '公开回复已完成。' }
          : { request_id: 'cold-parent-post', text: '公开进度已发布。' },
        `cold-parent-public-${index}`)
      return
    }
    yield* super.stream(options)
  }
}

it('restores the cold Captain composition before a mentioned member settlement wakes its next turn', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-public-cold-parent-'))
  const errors: Array<{ sessionId: string; message: string }> = []
  const observe: NonNullable<Parameters<typeof setup>[3]> = async ctx => {
    ctx.on('agent/error', ({ agent, error }) => {
      errors.push({ sessionId: String(agent.id), message: error instanceof Error ? error.message : String(error) })
    })
  }
  const config = { captainModel: CAPTAIN_MODEL, personaPrefix: DEPLOYMENT }
  let f = await setup(sandbox, new ColdConversation(true), true, observe, config)
  let closed = false
  try {
    // ROOT has public-model, the Captain and member have different explicit models.
    // In particular there is no default provider/model to rescue a bare resume.
    const { captain, teamId, scope } = await createTeam(f, sandbox)
    const before = await vi.waitFor(async () => {
      const team = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
      expect(team.members.filter(member => member.phase === 'active')).toHaveLength(1)
      return team
    })
    const memberId = SessionId(before.members.find(member => member.phase === 'active')!.sessionId)
    // Do not recruit through the former fixture's bare-resume helper.
    // Wait for the actual official initial activations and settlement to retire.
    await vi.waitFor(() => {
      expect(f.ctx.agents.get(memberId)).toBeUndefined()
      expect(f.ctx.agents.get(captain.id)).toBeUndefined()
    }, { timeout: 10_000 })
    expect(errors).toEqual([])
    const captainBefore = await readPersistedSession(f.ctx.sessionPersistence, captain.id, SIGNAL)
    const memberBefore = await readPersistedSession(f.ctx.sessionPersistence, memberId, SIGNAL)
    const captainDescriptor = captainBefore.events.find(event => event.type === 'subagent/descriptor')
    const memberDescriptor = memberBefore.events.find(event => event.type === 'subagent/descriptor')
    expect(captainDescriptor?.data).toMatchObject({
      mode: 'continuable', agentProvider: 'public-fixture', agentModel: CAPTAIN_MODEL,
      toolFilter: { deny: ['agent_swarm_create_managed'] },
    })
    expect(memberDescriptor?.data).toMatchObject({
      mode: 'continuable', agentProvider: 'public-fixture', agentModel: MEMBER_MODEL,
    })
    expect(before.tasks).toEqual([])
    await f.close()
    closed = true

    const adapter = new ColdConversation(false)
    adapter.memberId = memberId
    f = await setup(sandbox, adapter, true, observe, {
      ...config, startupRecoveryExcludedTeamIds: [teamId],
    })
    closed = false
    expect(f.ctx.agents.get(captain.id)).toBeUndefined()
    expect(f.ctx.agents.get(memberId)).toBeUndefined()
    const call = await publicClient(f, teamId)
    await call('append', { requestId: 'cold-parent-input', content: [
      { type: 'mention', memberId }, { type: 'text', text: '请公开回复并发布进度，然后结束。' },
    ] })
    await vi.waitFor(async () => {
      const team = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
      const member = await readPersistedSession(f.ctx.sessionPersistence, memberId, SIGNAL)
      const toolResults = member.events.filter(event => event.type === 'tool/result')
      expect(team.publicChat!.messages, JSON.stringify({ errors, toolResults })).toHaveLength(3)
      expect(publicDeliveries(team.publicChat!.messages[0]!)[0]?.state).toBe('claimed')
    }, { timeout: 15_000 })

    // The observed production bug occurs AFTER both public tools have succeeded.
    // Require the real settled notification and the Captain's resulting completed turn.
    const captainAfter = await vi.waitFor(async () => {
      const stored = await readPersistedSession(f.ctx.sessionPersistence, captain.id, SIGNAL)
      const fresh = stored.events.filter(event => event.seq > (captainBefore.events.at(-1)?.seq ?? -1))
      const ends = fresh.flatMap(event => event.type === 'turn/end' ? [event.data] : [])
      const diagnostic = JSON.stringify({ errors, ends, fresh })
      expect(fresh.some(event => event.type === 'agent/inbox/spliced'
        && event.data.inserted.some(message => message.source?.kind === 'subagent-settled'
          && message.source.senderSessionId === memberId)), diagnostic).toBe(true)
      expect(ends.length, diagnostic).toBeGreaterThan(0)
      return stored
    }, { timeout: 15_000 })
    const fresh = captainAfter.events.filter(event => event.seq > (captainBefore.events.at(-1)?.seq ?? -1))
    const ends = fresh.flatMap(event => event.type === 'turn/end' ? [event.data] : [])
    const diagnostic = JSON.stringify({ errors, ends, fresh })
    expect(ends.some(end => end.reason.kind === 'error'), diagnostic).toBe(false)
    expect(fresh.some(event => event.type === 'user/message'
      && event.data.source?.kind === 'subagent-settled'), diagnostic).toBe(true)
    expect(ends.some(end => end.reason.kind === 'completed'), diagnostic).toBe(true)
    expect(errors).toEqual([])

    const captainRequests = adapter.requests.filter(request => request.sessionId === captain.id)
    const memberRequests = adapter.requests.filter(request => request.sessionId === memberId)
    expect(captainRequests).toHaveLength(1)
    expect(JSON.stringify(adapter.requests)).not.toContain('Agent Swarm transport maintenance v1:')
    expect(memberRequests.length).toBeGreaterThan(0)
    for (const request of captainRequests) {
      expect(request.model).toBe(CAPTAIN_MODEL)
      expect(systemText(request)).toContain('Dedicated Captain of DSH Team')
      expect(systemText(request)).not.toContain('Deployment route')
      expect(request.tools?.map(tool => tool.name)).not.toContain('agent_swarm_create_managed')
    }
    for (const request of memberRequests) {
      expect(request.model).toBe(MEMBER_MODEL)
      expect(request.tools?.map(tool => tool.name)).not.toContain('agent_swarm_add_private_memory')
      expect(request.tools?.map(tool => tool.name)).toContain('agent_swarm_public_post')
    }
    expect(captainAfter.events.filter(event => event.type === 'subagent/descriptor'))
      .toEqual(captainBefore.events.filter(event => event.type === 'subagent/descriptor'))
    const memberAfter = await readPersistedSession(f.ctx.sessionPersistence, memberId, SIGNAL)
    expect(memberAfter.events.filter(event => event.type === 'subagent/descriptor'))
      .toEqual(memberBefore.events.filter(event => event.type === 'subagent/descriptor'))
    const after = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
    expect(after.tasks).toEqual(before.tasks)
    expect(after.publicChat!.messages.slice(1).map(message => message.author))
      .toEqual([expect.objectContaining({ sessionId: memberId }), expect.objectContaining({ sessionId: memberId })])

    const registry = f.ctx.agents
    await f.close()
    closed = true
    expect(registry.get(captain.id)).toBeUndefined()
    expect(registry.get(memberId)).toBeUndefined()
  } finally {
    if (!closed) await f.close()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 45_000)
