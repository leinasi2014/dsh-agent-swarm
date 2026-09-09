import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { TeamId } from '../src/domain/types.js'
import { assignmentPrompt } from '../src/runtime/prompts.js'
import { addMember, mount, snapshotOf } from './helpers/gated-composition.js'

it.each(['submitted', 'completed', 'replaced'] as const)('does not admit a parked assignment after it is %s; later feedback still runs', async state => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-stale-assignment-'))
  const stack = await mount(root, 0)
  const { ctx, adapter } = stack
  try {
    const memberId = await addMember(stack, 'finishing-worker')
    const member = ctx.agents.get(SessionId(memberId))!
    await adapter.waitForRequests(1)
    const domain = ctx.agentSwarm.domain
    const teamId = TeamId(stack.teamId)
    const task = await domain.createTask(stack.scope, teamId, stack.lead.id, {
      subject: 'Work already performed in the current turn', description: 'Do not replay after acceptance.',
    })
    const claim = await domain.claimTask(stack.scope, teamId, memberId, task.id, task.revision, memberId)
    const frame = assignmentPrompt((await snapshotOf(stack)).team, claim.task, claim.attempt.id)
    const stale = createUserMessage({ content: [{ type: 'text', text: frame }], source: { kind: 'plugin', plugin: 'dsh-agent-swarm' } })
    member.followup(stale)
    expect(member.inbox.nextTurn.some(message => message.id === stale.id)).toBe(true)
    if (state === 'replaced') {
      const successor = await domain.retryAttempt(stack.scope, teamId, stack.lead.id, task.id, claim.task.revision, memberId, 'Superseded execution')
      expect(successor.attempt.id).not.toBe(claim.attempt.id)
    } else {
      const submitted = await domain.submitTask(stack.scope, teamId, memberId, task.id, claim.task.revision, claim.attempt.id, 'Done in this turn')
      if (state === 'completed') {
        const completed = await domain.reviewTask(stack.scope, teamId, stack.lead.id, task.id, submitted.revision, claim.attempt.id, 'accept')
        expect(completed.status).toBe('completed')
      }
    }
    adapter.open()
    await vi.waitFor(() => {
      expect(member.inbox.nextTurn).toHaveLength(0)
    }, { timeout: 5_000 })
    expect(member.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === stale.id)).toBe(false)
    if (state !== 'replaced') await vi.waitFor(() => expect(member.status).toBe('idle'))
    const feedback = createUserMessage({ content: [{ type: 'text', text: 'Continue with the current task board.' }], source: { kind: 'plugin', plugin: 'dsh-agent-swarm' } })
    member.followup(feedback)
    await vi.waitFor(() => {
      adapter.open()
      expect(member.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === feedback.id)).toBe(true)
    }, { timeout: 5_000 })
  } finally {
    adapter.open()
    for (const fiber of stack.fibers.toReversed()) await fiber.dispose()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 30_000)

it.each(['feedback', 'runtime-context'] as const)('handles downstream pre-step additions of %s without reviving old work', async addition => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-assignment-downstream-'))
  const stack = await mount(root, 0)
  const { ctx, adapter } = stack
  let off: (() => void) | undefined
  try {
    const memberId = await addMember(stack, 'downstream-worker')
    const member = ctx.agents.get(SessionId(memberId))!
    await adapter.waitForRequests(1)
    const domain = ctx.agentSwarm.domain, teamId = TeamId(stack.teamId)
    const task = await domain.createTask(stack.scope, teamId, stack.lead.id, { subject: 'Old task', description: 'Already performed.' })
    const claim = await domain.claimTask(stack.scope, teamId, memberId, task.id, task.revision, memberId)
    const stale = createUserMessage({ content: [{ type: 'text', text: assignmentPrompt((await snapshotOf(stack)).team, claim.task, claim.attempt.id) }], source: { kind: 'plugin', plugin: 'dsh-agent-swarm' } })
    member.followup(stale)
    await domain.submitTask(stack.scope, teamId, memberId, task.id, claim.task.revision, claim.attempt.id, 'Submitted')
    const added = createUserMessage({ content: [{ type: 'text', text: addition === 'feedback' ? 'Valid feedback added by another admission plugin.' : 'Current runtime context: none.' }], source: { kind: 'plugin', plugin: addition === 'feedback' ? 'feedback-plugin' : '@deepseek-ai/dsh-system-prompt' } })
    off = ctx.on('agent/pre-step', async ({ messages }, next) => {
      const decision = await next()
      return decision.kind === 'enter' && messages.some(message => message.id === stale.id)
        ? { ...decision, messages: [...decision.messages, added] } : decision
    })
    adapter.open()
    await vi.waitFor(() => {
      if (addition === 'feedback') expect(member.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === added.id)).toBe(true)
      else expect(member.status).toBe('idle')
    })
    expect(member.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === stale.id)).toBe(false)
    if (addition === 'runtime-context') expect(member.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === added.id)).toBe(false)
  } finally {
    off?.(); adapter.open()
    for (const fiber of stack.fibers.toReversed()) await fiber.dispose()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 30_000)

it.each(['mixed', 'current', 'foreign-source'] as const)('preserves legitimate model input in a %s batch', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-assignment-input-'))
  const stack = await mount(root, 0)
  const { ctx, adapter } = stack
  try {
    const memberId = await addMember(stack, 'input-worker')
    const member = ctx.agents.get(SessionId(memberId))!
    await adapter.waitForRequests(1)
    const domain = ctx.agentSwarm.domain, teamId = TeamId(stack.teamId)
    const task = await domain.createTask(stack.scope, teamId, stack.lead.id, { subject: 'Input boundary', description: 'Keep legitimate work.' })
    const claim = await domain.claimTask(stack.scope, teamId, memberId, task.id, task.revision, memberId)
    const frame = assignmentPrompt((await snapshotOf(stack)).team, claim.task, claim.attempt.id)
    const input = createUserMessage({ content: [{ type: 'text', text: frame }], source: { kind: 'plugin', plugin: mode === 'foreign-source' ? 'another-plugin' : 'dsh-agent-swarm' } })
    if (mode === 'current') await domain.acknowledgeAssignment(stack.scope, teamId, task.id, claim.attempt.id)
    else await domain.submitTask(stack.scope, teamId, memberId, task.id, claim.task.revision, claim.attempt.id, 'Submitted')
    // Both messages enter one real next-step claim behind the held request.
    member.inject(input)
    const feedback = createUserMessage({ content: [{ type: 'text', text: 'Independent current feedback in the same batch.' }], source: { kind: 'user' } })
    member.inject(feedback)
    adapter.open()
    await vi.waitFor(() => expect(member.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === feedback.id)).toBe(true))
    expect(member.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === input.id)).toBe(mode !== 'mixed')
    if (mode === 'current') expect((await snapshotOf(stack)).team.tasks.find(candidate => candidate.id === task.id)?.currentAttemptId).toBe(claim.attempt.id)
  } finally {
    adapter.open()
    for (const fiber of stack.fibers.toReversed()) await fiber.dispose()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 30_000)

it('preserves feedback already queued behind an expired assignment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-expired-queue-'))
  const stack = await mount(root, 0)
  const { ctx, adapter } = stack
  try {
    const memberId = await addMember(stack, 'queued-worker')
    const member = ctx.agents.get(SessionId(memberId))!
    await adapter.waitForRequests(1)
    const domain = ctx.agentSwarm.domain, teamId = TeamId(stack.teamId)
    const task = await domain.createTask(stack.scope, teamId, stack.lead.id, { subject: 'Old task', description: 'Already done.' })
    const claim = await domain.claimTask(stack.scope, teamId, memberId, task.id, task.revision, memberId)
    const stale = createUserMessage({ content: [{ type: 'text', text: assignmentPrompt((await snapshotOf(stack)).team, claim.task, claim.attempt.id) }], source: { kind: 'plugin', plugin: 'dsh-agent-swarm' } })
    member.followup(stale)
    const secondStale = createUserMessage({ content: stale.content, source: stale.source })
    member.followup(secondStale)
    await domain.submitTask(stack.scope, teamId, memberId, task.id, claim.task.revision, claim.attempt.id, 'Submitted')
    const feedback = createUserMessage({ content: [{ type: 'text', text: 'Feedback already waiting behind obsolete work.' }], source: { kind: 'plugin', plugin: 'dsh-agent-swarm' } })
    member.followup(feedback)
    await vi.waitFor(() => {
      adapter.open()
      expect(member.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === feedback.id)).toBe(true)
    }, { timeout: 5_000 })
    expect(member.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === stale.id)).toBe(false)
    expect(member.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === secondStale.id)).toBe(false)
  } finally {
    adapter.open()
    for (const fiber of stack.fibers.toReversed()) await fiber.dispose()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 30_000)
