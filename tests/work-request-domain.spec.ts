import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { openStorageStack, type StorageStack } from './helpers/storage-stack.js'
import { TaskId } from '../src/domain/types.js'
import { TeamDomain, DEFAULT_TEAM_LIMITS } from '../src/domain/team-domain.js'
import { messageObsoleteReason } from '../src/domain/team-domain-mailbox.js'
import { openClaimNoticeDeferred } from '../src/domain/team-domain-open-claim.js'
import { appendWorkActivity } from '../src/domain/team-domain-work-activity.js'

const stacks: StorageStack[] = []
const roots: string[] = []
afterEach(async () => {
  for (const stack of stacks.splice(0).toReversed()) await stack.close()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'work-request-domain-'))
  roots.push(root)
  const stack = await openStorageStack(join(root, 'storage'))
  stacks.push(stack)
  const team = await stack.port.createTeam(root, 'captain', 'Work', 'Atomic requests')
  for (const name of ['alice', 'bob']) {
    await stack.port.provisionMember(root, team.id, 'captain', { name, role: 'worker', sessionId: name, provider: 'spawn' })
    await stack.port.settleMember(root, team.id, name, { active: true })
  }
  return { stack, root, team, port: stack.port }
}
it('atomically deduplicates human requests and accepts a dependency batch with restart replay', async () => {
  const { stack, root, team, port } = await fixture()
  const origin = { kind: 'local-operator' } as const
  const input = { requestId: 'client-one', description: 'Deliver the feature' }
  const [first, duplicate] = await Promise.all([port.submitWorkRequest(root, team.id, origin, input), port.submitWorkRequest(root, team.id, origin, input)])
  expect(duplicate.request.id).toBe(first.request.id)
  const proposed = await stack.store.read(root, team.id)
  expect(proposed?.tasks).toHaveLength(0)
  expect(proposed?.messages).toHaveLength(1)
  expect(proposed?.messages[0]).toMatchObject({ kind: 'work-request-notice', origin })
  expect(proposed?.messages[0]).not.toHaveProperty('senderSessionId')
  const decision = { kind: 'accept', items: [
    { itemKey: 'first', subject: 'First', description: 'Implement' },
    { itemKey: 'second', subject: 'Second', description: 'Check', blockedByItems: ['first'] },
  ] } as const
  const accepted = await port.resolveWorkRequest(root, team.id, 'captain', { workRequestId: first.request.id, expectedRequestRevision: 1, decision })
  expect(accepted.request.resolution).toMatchObject({ kind: 'accept', taskIdsByItemKey: { first: 'task-1', second: 'task-2' } })
  const current = await stack.store.read(root, team.id)
  expect(current?.tasks[1]?.blockedBy).toEqual(['task-1'])
  expect(current?.tasks[0]).toMatchObject({ createdBySessionId: 'captain', source: { origin, itemKey: 'first', workRequestId: first.request.id } })
  const retargeted = await port.cancelAttempt(root, team.id, 'captain', TaskId('task-1'), 1, 'Assign request work', 'alice')
  const retargetPage = await port.workActivity(root, team.id, current!.workActivity!.nextSequence - 1)
  expect(retargetPage.entries).toEqual([expect.objectContaining({ kind: 'task-reassigned', workRequestId: first.request.id })])
  expect(retargetPage.referencedRequests).toEqual([accepted.request])
  const claimed = await port.claimTask(root, team.id, 'alice', retargeted.id, retargeted.revision, 'alice')
  const beforeReassign = await port.workActivity(root, team.id)
  await port.cancelAttempt(root, team.id, 'captain', claimed.task.id, claimed.task.revision, 'Reassign request work', 'bob')
  const reassignPage = await port.workActivity(root, team.id, beforeReassign.throughSequence)
  expect(reassignPage.entries).toEqual([expect.objectContaining({ kind: 'task-reassigned', workRequestId: first.request.id, attemptId: claimed.attempt.id })])
  expect(reassignPage.referencedRequests).toEqual([accepted.request])
  await stack.close(); stacks.splice(stacks.indexOf(stack), 1)
  const reopened = await openStorageStack(join(root, 'storage')); stacks.push(reopened)
  const replay = await reopened.port.resolveWorkRequest(root, team.id, 'captain', { workRequestId: first.request.id, expectedRequestRevision: 1, decision })
  expect(replay).toMatchObject({ replayed: true, request: accepted.request })
  await expect(reopened.port.resolveWorkRequest(root, team.id, 'alice', { workRequestId: first.request.id, expectedRequestRevision: 1, decision })).rejects.toMatchObject({ code: 'TEAM_CAPTAIN_REQUIRED' })
  await expect(reopened.port.submitWorkRequest(root, team.id, origin, { ...input, description: 'Changed' })).rejects.toMatchObject({ code: 'TEAM_WORK_REQUEST_CONFLICT' })
})
it('rolls back the entire batch and task number when a later item is invalid', async () => {
  const { stack, root, team, port } = await fixture()
  const first = await port.submitWorkRequest(root, team.id, { kind: 'local-operator' }, { requestId: 'bad-plan', description: 'Plan' })
  const before = await stack.store.read(root, team.id)
  await expect(port.resolveWorkRequest(root, team.id, 'captain', { workRequestId: first.request.id, expectedRequestRevision: 1, decision: { kind: 'accept', items: [
    { itemKey: 'good', subject: 'Good', description: 'Good' },
    { itemKey: 'bad', subject: 'Bad', description: 'Bad', blockedBy: [TaskId('task-missing')] },
  ] } })).rejects.toBeDefined()
  expect(await stack.store.read(root, team.id)).toEqual(before)
})
it('allows one open self-claim winner and stores private-free actual submit/review facts', async () => {
  const { stack, root, team, port } = await fixture()
  const task = await port.createTask(root, team.id, 'alice', { subject: 'Open', description: 'Work', assignmentMode: 'open-claim' })
  await expect(port.claimTask(root, team.id, 'captain', task.id, 1, 'alice')).rejects.toMatchObject({ code: 'TEAM_OPEN_CLAIM_SELF_REQUIRED' })
  const results = await Promise.allSettled(['alice', 'bob'].map(actor => port.claimTask(root, team.id, actor, task.id, 1, actor)))
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const winner = results.find(result => result.status === 'fulfilled')!
  if (winner.status !== 'fulfilled') throw new Error('no winner')
  const seated = winner.value
  const submitted = await port.submitTask(root, team.id, seated.task.ownerSessionId!, task.id, seated.task.revision, seated.attempt.id, 'PRIVATE OUTPUT', ['PRIVATE EVIDENCE'])
  await port.reviewTask(root, team.id, 'captain', task.id, submitted.revision, seated.attempt.id, 'accept', undefined, 'actual-review-provider')
  const page = await port.workActivity(root, team.id)
  expect(page.entries.map(entry => entry.kind)).toEqual(['task-created', 'task-claimed', 'task-submitted', 'task-reviewed'])
  expect(JSON.stringify(page)).not.toContain('PRIVATE')
  const saved = await stack.store.read(root, team.id)
  expect(saved?.attempts[0]).toMatchObject({ submittedBySessionId: seated.task.ownerSessionId, reviewedBySessionId: 'captain', reviewProvider: 'actual-review-provider' })
  expect(page.entries.at(-1)).toMatchObject({ reviewProvider: 'actual-review-provider' })
})

it('keeps request plus activity plus mail absent after real publish failure and reopen', async () => {
  const { stack, root, team, port } = await fixture()
  const before = await stack.store.read(root, team.id)
  const unit = (stack as unknown as { domain: { unit: { publish: () => Promise<void> } } }).domain.unit
  const publish = unit.publish.bind(unit)
  unit.publish = async () => { throw new Error('request real publish failed') }
  await expect(port.submitWorkRequest(root, team.id, { kind: 'local-operator' }, { requestId: 'publish-failure', description: 'No partial commit' })).rejects.toThrow('request real publish failed')
  unit.publish = publish
  expect(await stack.store.read(root, team.id)).toEqual(before)
  await stack.close(); stacks.splice(stacks.indexOf(stack), 1)
  const reopened = await openStorageStack(join(root, 'storage')); stacks.push(reopened)
  expect(await reopened.store.read(root, team.id)).toEqual(before)
})

it('leaves the request pending and no allocated tasks after accept publish failure', async () => {
  const { stack, root, team, port } = await fixture()
  const first = await port.submitWorkRequest(root, team.id, { kind: 'local-operator' }, { requestId: 'accept-failure', description: 'Atomic acceptance' })
  const before = await stack.store.read(root, team.id)
  const unit = (stack as unknown as { domain: { unit: { publish: () => Promise<void> } } }).domain.unit
  const publish = unit.publish.bind(unit)
  unit.publish = async () => { throw new Error('accept real publish failed') }
  await expect(port.resolveWorkRequest(root, team.id, 'captain', { workRequestId: first.request.id, expectedRequestRevision: 1,
    decision: { kind: 'accept', items: [{ itemKey: 'one', subject: 'First', description: 'Work' }] } })).rejects.toThrow('accept real publish failed')
  unit.publish = publish
  expect(await stack.store.read(root, team.id)).toEqual(before)
  await stack.close(); stacks.splice(stacks.indexOf(stack), 1)
  const reopened = await openStorageStack(join(root, 'storage')); stacks.push(reopened)
  expect(await reopened.store.read(root, team.id)).toEqual(before)
})

it('rejects once without tasks, obsoletes pending notice, rejects altered decisions and ignores stale replay revision', async () => {
  const { stack, root, team, port } = await fixture()
  const first = await port.submitWorkRequest(root, team.id, { kind: 'local-operator' }, { requestId: 'rejected', description: 'Review me' })
  const decision = { kind: 'reject', publicReason: 'Outside the agreed scope' } as const
  const rejected = await port.resolveWorkRequest(root, team.id, 'captain', { workRequestId: first.request.id, expectedRequestRevision: 1, decision })
  expect(rejected.request.resolution).toMatchObject({ kind: 'reject', publicReason: decision.publicReason, actorSessionId: 'captain' })
  expect(await port.resolveWorkRequest(root, team.id, 'captain', { workRequestId: first.request.id, expectedRequestRevision: 1, decision })).toMatchObject({ replayed: true })
  await expect(port.resolveWorkRequest(root, team.id, 'captain', { workRequestId: first.request.id, expectedRequestRevision: 2, decision: { ...decision, publicReason: 'Different' } })).rejects.toMatchObject({ code: 'TEAM_WORK_REQUEST_CONFLICT' })
  const current = (await stack.store.read(root, team.id))!
  expect(current.tasks).toHaveLength(0)
  expect(current.nextTaskNumber).toBe(1)
  expect(messageObsoleteReason(current, current.messages[0]!)).toContain('no longer pending')
  expect((await port.workActivity(root, team.id)).referencedRequests).toEqual([rejected.request])
})

it('rejects request mailbox capacity atomically and preserves identity after receipt pruning', async () => {
  const { stack, root, team } = await fixture()
  const port = new TeamDomain(stack.store, { ...DEFAULT_TEAM_LIMITS, maxPendingMessagesPerMember: 1, maxRetainedMessages: 1 })
  const origin = { kind: 'local-operator' } as const
  const input = { requestId: 'keep-identity', description: 'Persist identity' }
  const first = await port.submitWorkRequest(root, team.id, origin, input)
  const before = await stack.store.read(root, team.id)
  await expect(port.submitWorkRequest(root, team.id, origin, { ...input, requestId: 'overflow' })).rejects.toMatchObject({ code: 'TEAM_MAILBOX_FULL' })
  expect(await stack.store.read(root, team.id)).toEqual(before)
  await port.acknowledgeMessage(root, team.id, first.notificationMessageId)
  const mail = await port.queueMessage(root, team.id, 'alice', 'captain', 'Other mail', 'wakeup')
  await port.acknowledgeMessage(root, team.id, mail.id)
  expect((await stack.store.read(root, team.id))?.messages.map(item => item.id)).not.toContain(first.notificationMessageId)
  expect(await port.submitWorkRequest(root, team.id, origin, input)).toMatchObject({ replayed: true, notificationMessageId: first.notificationMessageId })
  expect((await stack.store.read(root, team.id))?.messages).toHaveLength(1)
})

it('notifies each eligible recipient once per task revision and defers temporary busy or budget', async () => {
  const { stack, root, team, port } = await fixture()
  const task = await port.createTask(root, team.id, 'captain', { subject: 'Open', description: 'Available', assignmentMode: 'open-claim' })
  const notice = await port.noticeOpenClaimTask(root, team.id, 'captain', { taskId: task.id, expectedTaskRevision: 1, recipientSessionIds: ['alice', 'alice'] })
  expect(notice.notifiedSessionIds).toEqual(['alice'])
  let current = (await stack.store.read(root, team.id))!
  expect(current.tasks[0]?.revision).toBe(1)
  expect(current.tasks[0]?.openClaimNotice).toEqual({ revision: 1, recipientSessionIds: ['alice'] })
  expect(messageObsoleteReason(current, current.messages[0]!)).toBeUndefined()
  const busy = await port.createTask(root, team.id, 'captain', { subject: 'Busy', description: 'Other work' })
  await port.claimTask(root, team.id, 'alice', busy.id, 1, 'alice')
  current = (await stack.store.read(root, team.id))!
  expect(openClaimNoticeDeferred(current, current.messages[0]!, Date.now())).toBe(true)
  expect(messageObsoleteReason(current, current.messages[0]!)).toBeUndefined()
  expect(openClaimNoticeDeferred({ ...current, tasks: [current.tasks[0]!], budget: { ...current.budget, tokenLimit: 1, usedTokens: 1 } }, current.messages[0]!, Date.now())).toBe(true)
  await stack.close(); stacks.splice(stacks.indexOf(stack), 1)
  const reopened = await openStorageStack(join(root, 'storage')); stacks.push(reopened)
  expect(await reopened.port.noticeOpenClaimTask(root, team.id, 'captain', { taskId: task.id, expectedTaskRevision: 1, recipientSessionIds: ['alice'] })).toEqual({ messageIds: [], notifiedSessionIds: [] })
  await reopened.port.claimTask(root, team.id, 'bob', task.id, 1, 'bob')
  current = (await reopened.store.read(root, team.id))!
  expect(current.tasks[0]?.openClaimNotice).toBeUndefined()
  expect(messageObsoleteReason(current, current.messages[0]!)).toContain('no longer eligible')
})

it('skips a full mailbox without blocking other recipients and removes retired recipients', async () => {
  const { stack, root, team } = await fixture()
  const port = new TeamDomain(stack.store, { ...DEFAULT_TEAM_LIMITS, maxPendingMessagesPerMember: 1 })
  const task = await port.createTask(root, team.id, 'captain', { subject: 'Open', description: 'Available', assignmentMode: 'open-claim' })
  const busyMail = await port.queueMessage(root, team.id, 'captain', 'bob', 'Mailbox full', 'wakeup')
  expect(await port.noticeOpenClaimTask(root, team.id, 'captain', { taskId: task.id, expectedTaskRevision: 1, recipientSessionIds: ['alice', 'bob'] })).toMatchObject({ notifiedSessionIds: ['alice'] })
  expect((await stack.store.read(root, team.id))?.tasks[0]?.openClaimNotice?.recipientSessionIds).toEqual(['alice'])
  await port.acknowledgeMessage(root, team.id, busyMail.id)
  await port.noticeOpenClaimTask(root, team.id, 'captain', { taskId: task.id, expectedTaskRevision: 1, recipientSessionIds: ['alice', 'bob'] })
  await port.removeMember(root, team.id, 'captain', 'alice', 'Retired')
  const current = (await stack.store.read(root, team.id))!
  expect(current.tasks[0]?.openClaimNotice?.recipientSessionIds).toEqual(['bob'])
  expect(current.messages.find(item => item.kind === 'open-claim-notice' && item.targetSessionId === 'alice')?.phase).toBe('obsolete')
})

it('requires dependencies and fixed-target XOR while allowing Captain self-claim and explicit retarget', async () => {
  const { root, team, port } = await fixture()
  await expect(port.createTask(root, team.id, 'captain', { subject: 'Bad', description: 'Both', assignmentMode: 'open-claim', targetMemberSessionId: 'alice' })).rejects.toMatchObject({ code: 'TEAM_INPUT_INVALID' })
  const dependency = await port.createTask(root, team.id, 'captain', { subject: 'Dependency', description: 'First' })
  const blocked = await port.createTask(root, team.id, 'captain', { subject: 'Blocked', description: 'Later', assignmentMode: 'open-claim', blockedBy: [dependency.id] })
  await expect(port.noticeOpenClaimTask(root, team.id, 'captain', { taskId: blocked.id, expectedTaskRevision: 1, recipientSessionIds: ['alice'] })).rejects.toMatchObject({ code: 'TEAM_TASK_NOT_READY' })
  await expect(port.claimTask(root, team.id, 'alice', blocked.id, 1, 'alice')).rejects.toMatchObject({ code: 'TEAM_TASK_NOT_READY' })
  const open = await port.createTask(root, team.id, 'captain', { subject: 'Captain', description: 'Self', assignmentMode: 'open-claim' })
  expect((await port.claimTask(root, team.id, 'captain', open.id, 1, 'captain')).task.ownerSessionId).toBe('captain')
  const directed = await port.cancelAttempt(root, team.id, 'captain', blocked.id, 1, 'Assign explicitly', 'alice')
  expect(directed).toMatchObject({ assignmentMode: 'automatic', targetMemberSessionId: 'alice', revision: 2 })
})

it('validates precise Main origin and transaction admission witness', async () => {
  const { stack, root, team, port } = await fixture()
  await stack.store.transact(root, team.id, draft => { Object.assign(draft, { managedOrigin: 'managed:main-parent:turn:turn-one' }) })
  const current = (await stack.store.read(root, team.id))!
  const admission = { expectedCaptainSessionId: 'captain', expectedManagedOrigin: current.managedOrigin!, expectedTeamRevision: current.revision }
  const origin = { kind: 'main', sessionId: 'main-parent' } as const
  await expect(port.submitWorkRequest(root, team.id, { kind: 'main', sessionId: 'main' }, { requestId: 'wrong', description: 'Wrong Main' }, admission)).rejects.toMatchObject({ code: 'TEAM_WORK_REQUEST_ORIGIN_INVALID' })
  const first = await port.submitWorkRequest(root, team.id, origin, { requestId: 'main-valid', description: 'Valid Main' }, admission)
  expect(first.request.origin).toEqual(origin)
  expect(await port.submitWorkRequest(root, team.id, origin, { requestId: 'main-valid', description: 'Valid Main' }, admission)).toMatchObject({ replayed: true })
  await expect(port.submitWorkRequest(root, team.id, origin, { requestId: 'new-stale', description: 'Stale cut' }, admission)).rejects.toMatchObject({ code: 'TEAM_REVISION_CONFLICT' })
  await expect(port.submitWorkRequest(root, team.id, origin, { requestId: 'foreign-source', description: 'Foreign source', sourceMessageId: 'missing' })).rejects.toMatchObject({ code: 'TEAM_WORK_REQUEST_SOURCE_INVALID' })
})

it('returns an explicit retained activity boundary with bounded same-cut pages', async () => {
  const { stack, root, team, port } = await fixture()
  const task = await port.createTask(root, team.id, 'captain', { subject: 'Activity fixture', description: 'Bounded sequence history' })
  await stack.store.transact(root, team.id, draft => {
    for (let index = 0; index < 1029; index += 1) appendWorkActivity(draft, { kind: 'task-reassigned', taskId: task.id, actor: { kind: 'session', sessionId: 'captain' }, occurredAt: index })
  })
  const current = (await stack.store.read(root, team.id))!
  const first = await port.workActivity(root, team.id, 0, 100)
  expect(first).toMatchObject({ teamRevision: current.revision, retainedFromSequence: 7, throughSequence: 1030, hasMore: true })
  expect(first.entries).toHaveLength(100)
  expect(first.entries[0]?.sequence).toBe(7)
  expect((await port.workActivity(root, team.id, 1006, 100)).entries).toHaveLength(24)
  await expect(port.workActivity(root, team.id, 0, 101)).rejects.toMatchObject({ code: 'TEAM_INPUT_INVALID' })
})

it('rejects request 257 without evicting stable request identities or earlier lookup', async () => {
  const { stack, root, team } = await fixture()
  const port = new TeamDomain(stack.store, { ...DEFAULT_TEAM_LIMITS, maxPendingMessagesPerMember: 300 })
  const origin = { kind: 'local-operator' } as const
  const first = await port.submitWorkRequest(root, team.id, origin, { requestId: 'bounded-0', description: 'Request 0' })
  for (let index = 1; index < 256; index += 1) await port.submitWorkRequest(root, team.id, origin, { requestId: `bounded-${index}`, description: `Request ${index}` })
  const before = await stack.store.read(root, team.id)
  await expect(port.submitWorkRequest(root, team.id, origin, { requestId: 'bounded-256', description: 'Overflow' })).rejects.toMatchObject({ code: 'TEAM_WORK_REQUEST_CAPACITY' })
  expect(await stack.store.read(root, team.id)).toEqual(before)
  expect(await port.workRequestResult(root, team.id, origin, 'bounded-0')).toEqual(first.request)
  expect(await port.submitWorkRequest(root, team.id, origin, { requestId: 'bounded-0', description: 'Request 0' })).toMatchObject({ replayed: true })
}, 20_000)

it('keeps a real source message author distinct from the work request origin', async () => {
  const { stack, root, team, port } = await fixture()
  await stack.store.transact(root, team.id, draft => { Object.assign(draft, { managedOrigin: 'managed:main-parent:turn:source-turn' }) })
  const discussion = await port.appendPublicMessage(root, team.id, { author: { kind: 'local-operator' }, requestId: 'discussion', text: 'Discuss improvements' })
  const source = await port.appendPublicMessage(root, team.id, { author: { kind: 'agent', sessionId: 'alice' }, requestId: 'source-message', replyTo: discussion.message.id, text: 'A possible improvement' })
  const request = await port.submitWorkRequest(root, team.id, { kind: 'local-operator' }, { requestId: 'from-source', description: 'Please consider this', sourceMessageId: source.message.id })
  const current = (await stack.store.read(root, team.id))!
  expect(current.publicChat?.messages).toHaveLength(2)
  expect(current.publicChat?.messages[1]?.author).toMatchObject({ kind: 'agent', sessionId: 'alice' })
  expect(request.request).toMatchObject({ origin: { kind: 'local-operator' }, sourceMessageId: source.message.id })
})

it('reads pre-feature tasks and attempts without inferred creator, submission, review or activity', async () => {
  const { stack, root, team, port } = await fixture()
  const task = await port.createTask(root, team.id, 'captain', { subject: 'Legacy', description: 'Old task' })
  const claim = await port.claimTask(root, team.id, 'alice', task.id, task.revision, 'alice')
  await port.submitTask(root, team.id, 'alice', task.id, claim.task.revision, claim.attempt.id, 'Historical private output', [])
  await stack.store.transact(root, team.id, draft => {
    Object.assign(draft, { tasks: draft.tasks.map(({ createdBySessionId: _creator, submittedAt: _time, submittedBySessionId: _actor, ...legacy }) => legacy),
      attempts: draft.attempts.map(({ submittedAt: _time, submittedBySessionId: _actor, ...legacy }) => legacy) })
    Reflect.deleteProperty(draft, 'workActivity')
  })
  await stack.close(); stacks.splice(stacks.indexOf(stack), 1)
  const reopened = await openStorageStack(join(root, 'storage')); stacks.push(reopened)
  const current = (await reopened.store.read(root, team.id))!
  expect(current.tasks[0]).not.toHaveProperty('createdBySessionId')
  expect(current.tasks[0]).not.toHaveProperty('submittedAt')
  expect(current.attempts[0]).not.toHaveProperty('submittedBySessionId')
  expect(current.attempts[0]).not.toHaveProperty('reviewProvider')
  expect((await reopened.port.workActivity(root, team.id)).entries).toEqual([])
})

it.each([
  [{ itemKey: 'a', subject: 'A', description: 'A' }, { itemKey: 'a', subject: 'B', description: 'B' }],
  [{ itemKey: 'a', subject: 'A', description: 'A', blockedByItems: ['b'] }, { itemKey: 'b', subject: 'B', description: 'B', blockedByItems: ['a'] }],
  [{ itemKey: 'a', subject: 'A', description: 'A', blockedByItems: ['missing'] }],
])('does not allocate any task for duplicate keys, a batch cycle or an unresolved item reference: %j', async (...items) => {
  const { stack, root, team, port } = await fixture()
  const request = await port.submitWorkRequest(root, team.id, { kind: 'local-operator' }, { requestId: 'invalid-items', description: 'Atomic plan' })
  const before = await stack.store.read(root, team.id)
  await expect(port.resolveWorkRequest(root, team.id, 'captain', { workRequestId: request.request.id, expectedRequestRevision: 1,
    decision: { kind: 'accept', items } })).rejects.toBeDefined()
  expect(await stack.store.read(root, team.id)).toEqual(before)
})
