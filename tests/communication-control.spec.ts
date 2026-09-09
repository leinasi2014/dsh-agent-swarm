import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { TeamDomain, DEFAULT_TEAM_LIMITS } from '../src/domain/team-domain.js'
import { openStorageStack } from './helpers/storage-stack.js'
import { TeamMessageId, type TeamCommunicationIntensity } from '../src/domain/types.js'
import { communicationPolicy } from '../src/domain/team-domain-communication.js'
import { assertTeamState } from '../src/domain/state-validation.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).toReversed()) await close() })
async function mount(maxRetainedMessages = 256, pluginDefault: TeamCommunicationIntensity = 'active') {
  const root = await mkdtemp(join(tmpdir(), 'swarm-communication-'))
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  let now = 1_000_000
  let stack = await openStorageStack(join(root, 'store'), () => now)
  cleanup.push(() => stack.close())
  const limits = { ...DEFAULT_TEAM_LIMITS, maxRetainedMessages }
  let domain = new TeamDomain(stack.store, limits, () => now, pluginDefault)
  const scope = join(root, 'workspace')
  const team = await domain.createTeam(scope, 'captain', 'Communication', 'Control peer wakeups')
  for (const name of ['alpha', 'beta']) {
    await domain.provisionMember(scope, team.id, 'captain', { name, role: name, sessionId: name, provider: 'spawn' })
    await domain.settleMember(scope, team.id, name, { active: true })
  }
  return {
    get domain() { return domain }, scope, team,
    advance(ms: number) { now += ms },
    snapshot: async () => (await domain.snapshot(scope, team.id, 'captain')).team,
    send: (sender = 'alpha', target = 'beta') => domain.queueMessage(scope, team.id, sender, target, 'A useful update', 'wakeup'),
    reopen: async (nextDefault: TeamCommunicationIntensity = pluginDefault) => {
      await stack.close()
      stack = await openStorageStack(join(root, 'store'), () => now)
      domain = new TeamDomain(stack.store, limits, () => now, nextDefault)
    },
  }
}

it('defaults old Teams to twelve proactive peer wakeups per rolling minute, keeping overflow as quiet mail', async () => {
  const test = await mount()
  expect(await test.snapshot()).not.toHaveProperty('communicationIntensity')
  for (let count = 0; count < 12; count++) expect((await test.send()).delivery).toBe('wakeup')
  expect(await test.send()).toMatchObject({ delivery: 'quiet', communicationLimited: true, phase: 'queued' })
  expect((await test.snapshot()).messages).toHaveLength(13)
  expect((await test.send('alpha', 'captain')).delivery).toBe('wakeup')
  expect((await test.send('captain', 'beta')).delivery).toBe('wakeup')
  test.advance(59_999)
  expect((await test.send()).delivery).toBe('quiet')
  test.advance(1)
  expect((await test.send()).delivery).toBe('wakeup')
})

for (const [intensity, limit] of [['quiet', 1], ['balanced', 4], ['active', 12]] as const) {
  it(`enforces ${intensity} from plugin defaults without inserting fields into old Teams`, async () => {
    const test = await mount(256, intensity)
    const original = await test.snapshot()
    await test.reopen()
    expect(await test.snapshot()).toEqual(original)
    for (let count = 0; count < limit; count++) expect((await test.send()).delivery).toBe('wakeup')
    expect((await test.send()).delivery).toBe('quiet')
    expect(communicationPolicy(original, intensity)).toEqual({ intensity, source: 'plugin', peerWakeupsPerMinute: limit, windowSeconds: 60 })
  })
}

it('persists a Captain-only Team override, fences concurrent writes and resets to the current plugin default', async () => {
  const test = await mount()
  const before = await test.snapshot()
  await expect(test.domain.setCommunication(test.scope, test.team.id, 'alpha', before.revision, 'quiet')).rejects.toMatchObject({ code: 'TEAM_CAPTAIN_REQUIRED' })
  expect(await test.snapshot()).toEqual(before)
  const changed = await test.domain.setCommunication(test.scope, test.team.id, 'captain', before.revision, 'quiet')
  expect(changed).toMatchObject({ revision: before.revision + 1, communicationIntensity: 'quiet' })
  await test.reopen('balanced')
  expect(await test.snapshot()).toEqual(changed)
  expect((await test.send()).delivery).toBe('wakeup')
  expect((await test.send()).delivery).toBe('quiet')
  const revision = (await test.snapshot()).revision
  const writes = await Promise.allSettled(['balanced', 'active'].map(intensity => test.domain.setCommunication(test.scope, test.team.id, 'captain', revision, intensity as TeamCommunicationIntensity)))
  expect(writes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(writes.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'TEAM_REVISION_CONFLICT' } })
  const reset = await test.domain.setCommunication(test.scope, test.team.id, 'captain', (await test.snapshot()).revision, undefined)
  expect(reset).not.toHaveProperty('communicationIntensity')
  expect(communicationPolicy(reset, 'balanced')).toMatchObject({ intensity: 'balanced', source: 'plugin', peerWakeupsPerMinute: 4 })
  await test.reopen('balanced')
  expect(await test.snapshot()).toEqual(reset)
})

it('gives exactly the first genuine reply a wakeup exemption, including concurrent replies', async () => {
  const test = await mount(256, 'quiet')
  await test.send('beta', 'alpha') // Beta's proactive allowance is spent.
  const question = await test.send('alpha', 'beta')
  const reply = () => test.domain.queueMessage(test.scope, test.team.id, 'beta', 'alpha', 'Answer', 'wakeup', undefined, undefined, question.id)
  const replies = await Promise.all([reply(), reply()])
  expect(replies.filter(message => message.replyExempt === true)).toHaveLength(1)
  expect(replies.map(message => message.delivery).toSorted()).toEqual(['quiet', 'wakeup'])
  expect((await test.snapshot()).messages.find(message => message.id === question.id)?.repliedBy).toBe(replies.find(message => message.replyExempt)?.id)
  await expect(test.domain.queueMessage(test.scope, test.team.id, 'alpha', 'beta', 'Fake reply', 'wakeup', undefined, undefined, question.id)).rejects.toMatchObject({ code: 'TEAM_MESSAGE_REPLY_INVALID' })
  await expect(test.domain.queueMessage(test.scope, test.team.id, 'alpha', 'beta', 'Reply chain', 'wakeup', undefined, undefined, replies[0]!.id)).rejects.toMatchObject({ code: 'TEAM_MESSAGE_REPLY_INVALID' })
  await expect(test.domain.queueMessage(test.scope, test.team.id, 'beta', 'alpha', 'Missing', 'wakeup', undefined, undefined, TeamMessageId('missing'))).rejects.toMatchObject({ code: 'TEAM_MESSAGE_REPLY_INVALID' })
})

it('keeps rate and first-reply evidence through receipt pruning and a real Storage reopen', async () => {
  const test = await mount(1)
  const question = await test.send()
  await test.domain.acknowledgeMessage(test.scope, test.team.id, question.id)
  const reply = await test.domain.queueMessage(test.scope, test.team.id, 'beta', 'alpha', 'Answer', 'wakeup', undefined, undefined, question.id)
  expect(reply.replyExempt).toBe(true)
  await test.domain.acknowledgeMessage(test.scope, test.team.id, reply.id)
  expect((await test.snapshot()).messages).toEqual([expect.objectContaining({ id: question.id, repliedBy: reply.id })])
  await test.reopen()
  expect((await test.send()).delivery).toBe('quiet')
  expect(await test.domain.queueMessage(test.scope, test.team.id, 'beta', 'alpha', 'Repeat', 'wakeup', undefined, undefined, question.id))
    .toMatchObject({ delivery: 'quiet', communicationLimited: true })
  const captain = await test.send('captain', 'alpha')
  await test.domain.acknowledgeMessage(test.scope, test.team.id, captain.id)
  expect((await test.snapshot()).messages.filter(message => message.phase !== 'queued')).toHaveLength(1)
  expect((await test.snapshot()).messages).toContainEqual(expect.objectContaining({ id: question.id }))
  test.advance(60_000)
  expect((await test.send()).delivery).toBe('wakeup')
})

it('validates new persisted fields without weakening existing state validation', async () => {
  const test = await mount()
  const state = await test.snapshot()
  expect(() => assertTeamState({ ...state, communicationIntensity: 'unlimited' }, 'test')).toThrow()
  const message = await test.send()
  expect(() => assertTeamState({ ...state, messages: [{ ...message, communicationLimited: true }] }, 'test')).toThrow()
  expect(() => assertTeamState({ ...state, messages: [{ ...message, replyExempt: true }] }, 'test')).toThrow()
})
