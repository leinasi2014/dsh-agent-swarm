import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { replaceAttempt, replaceTask } from '../src/domain/team-domain-shared.js'
import { AttemptId, TaskId } from '../src/domain/types.js'
import { openStorageStack, type StorageStack } from './helpers/storage-stack.js'

let root: string
let stack: StorageStack
const scope = 'hardening-workspace'
const captain = 'hardening-captain'

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-domain-hardening-'))
  stack = await openStorageStack(root)
})
afterEach(async () => {
  await stack.close()
  await rm(root, { recursive: true, force: true })
})

it.each(['acceptanceCriteria', 'writeScopes'] as const)('bounds %s at 64 items and rejects the 65th before a durable mutation', async field => {
  const team = await stack.port.createTeam(scope, captain, 'Bounded board', 'Input admission')
  const entries = Array.from({ length: 64 }, (_, index) => `item-${index}`)
  const task = await stack.port.createTask(scope, team.id, captain, { subject: 'At limit', description: 'Exact limit admitted', [field]: entries })
  expect(task[field]).toEqual(entries)
  const before = await stack.port.snapshot(scope, team.id, captain)
  await expect(stack.port.createTask(scope, team.id, captain, {
    subject: 'Beyond limit', description: 'Must reject atomically', [field]: [...entries, 'extra'],
  })).rejects.toMatchObject({ code: 'TEAM_INPUT_LIMIT' })
  expect(await stack.port.snapshot(scope, team.id, captain)).toEqual(before)
})

it('bounds evidence at 64 and leaves the exact running attempt untouched on rejection', async () => {
  const team = await stack.port.createTeam(scope, captain, 'Evidence', 'Bounded submission')
  const task = await stack.port.createTask(scope, team.id, captain, { subject: 'Submit', description: 'Evidence count' })
  const claimed = await stack.port.claimTask(scope, team.id, captain, task.id, task.revision, captain)
  const before = await stack.port.snapshot(scope, team.id, captain)
  const evidence = Array.from({ length: 64 }, (_, index) => `evidence-${index}`)
  await expect(stack.port.submitTask(scope, team.id, captain, task.id, claimed.task.revision, claimed.attempt.id, 'output', [...evidence, 'extra']))
    .rejects.toMatchObject({ code: 'TEAM_INPUT_LIMIT' })
  expect(await stack.port.snapshot(scope, team.id, captain)).toEqual(before)
  await stack.port.submitTask(scope, team.id, captain, task.id, claimed.task.revision, claimed.attempt.id, 'output', evidence)
  expect((await stack.port.snapshot(scope, team.id, captain)).team.attempts[0]?.evidence).toEqual(evidence)
})

it('explicitly rejects missing replacement ids without negative array properties', async () => {
  const team = await stack.port.createTeam(scope, captain, 'Replace', 'Absent id is an error')
  const task = await stack.port.createTask(scope, team.id, captain, { subject: 'Existing', description: 'Existing task' })
  const claim = await stack.port.claimTask(scope, team.id, captain, task.id, task.revision, captain)
  const draft = (await stack.port.snapshot(scope, team.id, captain)).team
  const before = structuredClone(draft)
  expect.soft(() => replaceTask(draft, { ...claim.task, id: TaskId('missing') })).toThrow(expect.objectContaining({ code: 'TEAM_TASK_NOT_FOUND' }))
  expect.soft(() => replaceAttempt(draft, { ...claim.attempt, id: AttemptId('missing') })).toThrow(expect.objectContaining({ code: 'TEAM_ATTEMPT_NOT_FOUND' }))
  expect(Object.hasOwn(draft.tasks, '-1')).toBe(false)
  expect(Object.hasOwn(draft.attempts, '-1')).toBe(false)
  expect(draft).toEqual(before)
})

it('keeps previously stored longer arrays readable after reopening the real store', async () => {
  const team = await stack.port.createTeam(scope, captain, 'Historical', 'New limits are admission only')
  const task = await stack.port.createTask(scope, team.id, captain, { subject: 'Old task', description: 'Old data remains valid' })
  const claim = await stack.port.claimTask(scope, team.id, captain, task.id, task.revision, captain)
  const oldEntries = Array.from({ length: 65 }, (_, index) => `legacy-${index}`)
  await stack.store.transact(scope, team.id, draft => {
    Object.assign(draft.tasks[0]!, { acceptanceCriteria: oldEntries, writeScopes: oldEntries })
    Object.assign(draft.attempts[0]!, { evidence: oldEntries })
  })
  await stack.close()
  stack = await openStorageStack(root)
  const stored = await stack.port.snapshot(scope, team.id, captain)
  expect(stored.team.tasks[0]?.acceptanceCriteria).toEqual(oldEntries)
  expect(stored.team.tasks[0]?.writeScopes).toEqual(oldEntries)
  expect(stored.team.attempts.find(attempt => attempt.id === claim.attempt.id)?.evidence).toEqual(oldEntries)
})
