import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CaptainLiaison,
  humanInteractionDomainSpec,
  HumanInteractionOverlayStore,
  TeamId,
} from '../src/index.js'
import { AttemptId } from '../src/domain/types.js'
import type { TeamDomainPort } from '../src/domain/team-domain-port.js'
import { openStorageStack, type StorageStack } from './helpers/storage-stack.js'

const SIGNAL = new AbortController().signal
const CAPTAIN = { id: 'captain-session' } as Agent
const MEMBER = { id: 'member-1' } as Agent
const CALLERS = {
  resolve: (sessionId: string) => sessionId === CAPTAIN.id ? CAPTAIN : sessionId === MEMBER.id ? MEMBER : undefined,
  isRoot: (agent: Agent) => agent === CAPTAIN,
}

function relay(
  liaison: CaptainLiaison,
  input: Parameters<CaptainLiaison['relayMemberQuestion']>[0],
) {
  return liaison.relayMemberQuestion(input, { exec: { agent: MEMBER, signal: SIGNAL } })
}

function present(
  liaison: CaptainLiaison,
  input: Parameters<CaptainLiaison['presentQuestion']>[0],
) {
  return liaison.presentQuestion(input, { exec: { agent: CAPTAIN, signal: SIGNAL } })
}

describe('SW-I1a Captain Liaison', () => {
  let sandbox: string
  let scope: string
  let tick: number
  let stack: StorageStack
  let humanDomain: Domain<typeof humanInteractionDomainSpec>
  let overlay: HumanInteractionOverlayStore

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-i1a-'))
    scope = join(sandbox, 'workspace')
    tick = 1_000
    stack = await openStorageStack(join(sandbox, 'storage'), () => tick++)
    humanDomain = await stack.ctx.storageDomain.open(humanInteractionDomainSpec)
    overlay = new HumanInteractionOverlayStore(stack.ctx, humanDomain)
  })

  afterEach(async () => {
    overlay.close()
    await humanDomain.close()
    await stack.close()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  async function teamWithMember() {
    const team = await stack.port.createTeam(scope, 'captain-session', 'I1a team', 'Question relay')
    await stack.port.provisionMember(scope, team.id, 'captain-session', {
      name: 'worker',
      role: 'implementer',
      sessionId: 'member-1',
      provider: 'spawn',
    })
    await stack.port.settleMember(scope, team.id, 'member-1', { active: true })
    return (await stack.port.snapshot(scope, team.id, 'captain-session')).team
  }

  async function taskWithAttempt(teamId: import('../src/index.js').TeamId) {
    const task = await stack.port.createTask(scope, teamId, 'captain-session', {
      subject: 'question task',
      description: 'Correlated question',
    })
    const claim = await stack.port.claimTask(scope, teamId, 'captain-session', task.id, task.revision, 'member-1')
    return { task, claim }
  }

  function relayInput(teamId: import('../src/index.js').TeamId, revision: number, requestId: string) {
    return {
      scope,
      teamId,
      memberSessionId: 'member-1',
      body: 'Should I ship or ask first?',
      expectedTeamRevision: revision,
      requestId,
    }
  }

  it('scenario 40: a delegated member relays a question and one acknowledged request lifecycle does not duplicate either durable mail leg', async () => {
    const team = await teamWithMember()
    const liaison = new CaptainLiaison(stack.port, overlay, {
      ask: async question => `Answer for ${question.requestId}`,
    }, () => tick++, CALLERS)

    const first = await relay(liaison, relayInput(team.id, team.revision, 'human-relay-00000001'))
    expect(first.status).toBe('acknowledged')
    expect(first.routedMessageId).toBeDefined()
    expect(first.resultingTeamRevision).toBeGreaterThan(team.revision)

    let teamState = (await stack.port.snapshot(scope, team.id, 'captain-session')).team
    expect(teamState.messages.filter(message =>
      message.senderName === 'worker' && message.targetName === 'captain' && message.content === 'Should I ship or ask first?',
    )).toHaveLength(1)

    // The request id is the replay key: a duplicate returns the prior receipt
    // and never queues a second member->captain message.
    const duplicate = await relay(liaison, relayInput(team.id, team.revision, 'human-relay-00000001'))
    expect(duplicate).toEqual(first)
    teamState = (await stack.port.snapshot(scope, team.id, 'captain-session')).team
    expect(teamState.messages.filter(message => message.senderName === 'worker')).toHaveLength(1)

    const executed = await present(liaison, {
      scope,
      teamId: team.id,
      requestId: first.requestId,
      captainSessionId: 'captain-session',
    })
    expect(executed.status).toBe('executed')
    expect(executed.answerMessageId).toBeDefined()
    expect(executed.answerMessageId).not.toBe(first.routedMessageId)

    teamState = (await stack.port.snapshot(scope, team.id, 'captain-session')).team
    expect(teamState.messages.filter(message =>
      message.senderName === 'captain' && message.targetName === 'worker' && message.content === 'Answer for human-relay-00000001',
    )).toHaveLength(1)

    // Presenting the already-executed question is idempotent: no second answer.
    const executedAgain = await present(liaison, {
      scope,
      teamId: team.id,
      requestId: first.requestId,
      captainSessionId: 'captain-session',
    })
    expect(executedAgain).toEqual(executed)
    teamState = (await stack.port.snapshot(scope, team.id, 'captain-session')).team
    expect(teamState.messages.filter(message => message.senderName === 'captain')).toHaveLength(1)
  })

  it('scenario 41: a delegated member cannot bypass the captain, and a missing question provider leaves an explicit failed interaction rather than a fabricated answer', async () => {
    const team = await teamWithMember()
    const liaison = new CaptainLiaison(stack.port, overlay, undefined, () => tick++, CALLERS)

    const relayed = await relay(liaison, relayInput(team.id, team.revision, 'human-relay-00000002'))
    expect(relayed.status).toBe('acknowledged')

    // The member holds no presentation authority: the host port rejects the
    // direct attempt before any user-interaction service is reached.
    await expect(present(liaison, {
      scope,
      teamId: team.id,
      requestId: relayed.requestId,
      captainSessionId: 'member-1',
    })).rejects.toMatchObject({ code: 'TEAM_CAPTAIN_REQUIRED' })

    let teamState = (await stack.port.snapshot(scope, team.id, 'captain-session')).team
    expect(teamState.messages).toHaveLength(1)

    // No question provider: the receipt fails explicitly and no answer is
    // fabricated or routed.
    const failed = await present(liaison, {
      scope,
      teamId: team.id,
      requestId: relayed.requestId,
      captainSessionId: 'captain-session',
    })
    expect(failed.status).toBe('failed')
    expect(failed.code).toBe('TEAM_INTERACTION_PROVIDER_MISSING')
    expect(failed.diagnostic).toContain('no answer was fabricated')
    expect(failed.answerMessageId).toBeUndefined()

    teamState = (await stack.port.snapshot(scope, team.id, 'captain-session')).team
    expect(teamState.messages).toHaveLength(1)
  })

  it('rejects stale Team/task revision and attempt fences before any durable mail', async () => {
    const team = await teamWithMember()
    const liaison = new CaptainLiaison(stack.port, overlay, undefined, () => tick++, CALLERS)
    const { claim } = await taskWithAttempt(team.id)
      const currentRevision = (await stack.port.snapshot(scope, team.id, 'captain-session')).team.revision

    await expect(relay(liaison, {
      ...relayInput(team.id, team.revision - 1, 'human-relay-00000003'),
      expectedTeamRevision: team.revision - 1,
    })).rejects.toMatchObject({ code: 'TEAM_INTERACTION_STALE_REVISION' })

    await expect(relay(liaison, {
      ...relayInput(team.id, currentRevision, 'human-relay-00000004'),
      taskId: claim.task.id,
      expectedTaskRevision: claim.task.revision + 1,
    })).rejects.toMatchObject({ code: 'TEAM_INTERACTION_STALE_TASK_REVISION' })

    await expect(relay(liaison, {
      ...relayInput(team.id, currentRevision, 'human-relay-00000005'),
      taskId: claim.task.id,
      expectedTaskRevision: claim.task.revision,
      attemptId: claim.attempt.id,
    })).resolves.toMatchObject({ status: 'acknowledged' })
      const currentAfterRelay = (await stack.port.snapshot(scope, team.id, 'captain-session')).team.revision

    await expect(relay(liaison, {
      ...relayInput(team.id, currentAfterRelay, 'human-relay-00000006'),
      taskId: claim.task.id,
      expectedTaskRevision: claim.task.revision,
      attemptId: AttemptId('attempt-never-issued'),
    })).rejects.toMatchObject({ code: 'TEAM_INTERACTION_ATTEMPT_STALE' })

    const after = await stack.port.snapshot(scope, team.id, 'captain-session')
    expect(after.team.messages).toHaveLength(1)
    expect(overlay.list(scope, team.id)).toHaveLength(1)
  })

  it('rejects malformed task fences before admission, Team or overlay access', async () => {
    const touches = { team: 0, overlay: 0 }
    const team = new Proxy({}, {
      get() {
        touches.team += 1
        return () => { throw new Error('Team must not be touched') }
      },
    }) as unknown as TeamDomainPort
    const isolatedOverlay = new Proxy({}, {
      get() {
        touches.overlay += 1
        return () => { throw new Error('overlay must not be touched') }
      },
    }) as unknown as HumanInteractionOverlayStore
    const liaison = new CaptainLiaison(team, isolatedOverlay, undefined, () => tick++, CALLERS)
    const base = {
      scope: 'workspace-validation',
      teamId: TeamId('team-validation'),
      memberSessionId: 'member-1',
      body: 'Question',
      expectedTeamRevision: 1,
      requestId: 'human-task-validation-00000001',
    }
    const invalid = [
      { ...base, taskId: 42 },
      { ...base, taskId: 'task-1', expectedTaskRevision: 0 },
      { ...base, taskId: 'task-1', expectedTaskRevision: 1.5 },
      { ...base, taskId: 'task-1', attemptId: { forged: true } },
      { ...base, expectedTaskRevision: 1 },
    ]
    for (const input of invalid) {
      await expect(liaison.relayMemberQuestion(
        input as unknown as Parameters<CaptainLiaison['relayMemberQuestion']>[0],
        { exec: { agent: MEMBER, signal: SIGNAL } },
      )).rejects.toMatchObject({ code: 'TEAM_INTERACTION_INVALID' })
    }
    expect(touches).toEqual({ team: 0, overlay: 0 })
  })

  it('rejects an already-expired request before commit and expires a pending answer without routing', async () => {
    const team = await teamWithMember()
    const liaison = new CaptainLiaison(stack.port, overlay, undefined, () => tick++, CALLERS)

    await expect(relay(liaison, {
      ...relayInput(team.id, team.revision, 'human-relay-00000007'),
      expiresAt: 1,
    })).rejects.toMatchObject({ code: 'TEAM_INTERACTION_EXPIRED' })
    expect(overlay.list(scope, team.id)).toHaveLength(0)

    const relayed = await relay(liaison, {
      ...relayInput(team.id, team.revision, 'human-relay-00000008'),
      expiresAt: 10_000_000,
    })
    expect(relayed.status).toBe('acknowledged')
    // Advance the clock past the expiry and reconcile: the pending question is
    // expired and no answer message exists.
    tick = 10_000_001
    const receipts = await liaison.reconcile(scope, team.id, { exec: { agent: CAPTAIN, signal: SIGNAL } })
    expect(receipts.find(receipt => receipt.requestId === 'human-relay-00000008')).toMatchObject({
      status: 'expired',
      code: 'TEAM_INTERACTION_EXPIRED',
    })
    const teamState = (await stack.port.snapshot(scope, team.id, 'captain-session')).team
    expect(teamState.messages).toHaveLength(1)
  })

  it('rebuilds durable receipts after a full reopen and never re-executes the relay', async () => {
    const team = await teamWithMember()
    const liaison = new CaptainLiaison(stack.port, overlay, undefined, () => tick++, CALLERS)
    const first = await relay(liaison, relayInput(team.id, team.revision, 'human-relay-00000009'))
    expect(first.status).toBe('acknowledged')

    const storageRoot = join(sandbox, 'storage')
    overlay.close()
    await humanDomain.close()
    await stack.close()

    stack = await openStorageStack(storageRoot, () => tick++)
    humanDomain = await stack.ctx.storageDomain.open(humanInteractionDomainSpec)
    overlay = new HumanInteractionOverlayStore(stack.ctx, humanDomain)
    const rebuilt = overlay.get(scope, team.id, 'human-relay-00000009')
    expect(rebuilt?.receipt.status).toBe('acknowledged')
    expect(rebuilt?.receipt.routedMessageId).toBe(first.routedMessageId)

    const reloaded = new CaptainLiaison(stack.port, overlay, undefined, () => tick++, CALLERS)
    const duplicate = await relay(reloaded, relayInput(team.id, team.revision, 'human-relay-00000009'))
    expect(duplicate).toEqual(first)
    const teamState = (await stack.port.snapshot(scope, team.id, 'captain-session')).team
    expect(teamState.messages).toHaveLength(1)

    await expect(reloaded.listReceipts(scope, team.id, { exec: { agent: CAPTAIN, signal: SIGNAL } })).resolves.toEqual([
      expect.objectContaining({ requestId: 'human-relay-00000009', status: 'acknowledged' }),
    ])
  })

  it('quarantines a committed answer whose revision read fails and never asks or queues it again in-process', async () => {
    const team = await teamWithMember()
    let failCaptainSnapshot = false
    let askCount = 0
    const faultingPort = {
      requireMembership: stack.port.requireMembership.bind(stack.port),
      queueMessage: async (...args: Parameters<TeamDomainPort['queueMessage']>) => {
        const result = await stack.port.queueMessage(...args)
        if (args[2] === 'captain-session') failCaptainSnapshot = true
        return result
      },
      snapshot: async (...args: Parameters<TeamDomainPort['snapshot']>) => {
        if (failCaptainSnapshot) throw new Error('C:\\private\\provider token=secret-answer')
        return await stack.port.snapshot(...args)
      },
    } as TeamDomainPort
    const liaison = new CaptainLiaison(faultingPort, overlay, {
      ask: async () => {
        askCount += 1
        return 'one answer only'
      },
    }, () => tick++, CALLERS)
    const relayed = await relay(liaison, relayInput(team.id, team.revision, 'human-outcome-answer-00000010'))

    await expect(present(liaison, {
      scope,
      teamId: team.id,
      requestId: relayed.requestId,
      captainSessionId: 'captain-session',
    })).rejects.toMatchObject({ code: 'TEAM_INTERACTION_OUTCOME_UNKNOWN' })
    expect(askCount).toBe(1)
    expect((await stack.port.snapshot(scope, team.id, 'captain-session')).team.messages
      .filter(message => message.senderName === 'captain')).toHaveLength(1)

    await expect(present(liaison, {
      scope,
      teamId: team.id,
      requestId: relayed.requestId,
      captainSessionId: 'captain-session',
    })).rejects.toMatchObject({ code: 'TEAM_INTERACTION_OUTCOME_UNKNOWN' })
    expect(askCount).toBe(1)
    expect((await stack.port.snapshot(scope, team.id, 'captain-session')).team.messages
      .filter(message => message.senderName === 'captain')).toHaveLength(1)
    expect((await liaison.reconcile(
      scope,
      team.id,
      { exec: { agent: CAPTAIN, signal: SIGNAL } },
    )).find(item => item.requestId === relayed.requestId)).toMatchObject({
      status: 'acknowledged',
      code: 'TEAM_INTERACTION_OUTCOME_UNKNOWN',
      diagnostic: 'effect outcome unknown; reconciliation required',
    })
    expect(JSON.stringify(await liaison.listReceipts(
      scope,
      team.id,
      { exec: { agent: CAPTAIN, signal: SIGNAL } },
    ))).not.toMatch(/private|secret-answer/)
  })

  it('treats a throwing presentation as outcome-unknown, survives expiry reconcile, and never leaks or asks twice', async () => {
    const team = await teamWithMember()
    let asks = 0
    const liaison = new CaptainLiaison(stack.port, overlay, {
      ask: async () => {
        asks += 1
        throw new Error('C:\\private\\questions token=secret-presentation')
      },
    }, () => tick++, CALLERS)
    const relayed = await relay(liaison, {
      ...relayInput(team.id, team.revision, 'human-presentation-unknown-00000011'),
      expiresAt: tick + 100,
    })

    await expect(present(liaison, {
      scope,
      teamId: team.id,
      requestId: relayed.requestId,
      captainSessionId: 'captain-session',
    })).rejects.toMatchObject({ code: 'TEAM_INTERACTION_OUTCOME_UNKNOWN' })
    tick += 1_000
    const reconciled = await liaison.reconcile(scope, team.id, { exec: { agent: CAPTAIN, signal: SIGNAL } })
    expect(reconciled.find(item => item.requestId === relayed.requestId)).toMatchObject({
      status: 'acknowledged',
      code: 'TEAM_INTERACTION_OUTCOME_UNKNOWN',
    })
    await expect(present(liaison, {
      scope,
      teamId: team.id,
      requestId: relayed.requestId,
      captainSessionId: 'captain-session',
    })).rejects.toMatchObject({ code: 'TEAM_INTERACTION_OUTCOME_UNKNOWN' })
    expect(asks).toBe(1)
    expect(JSON.stringify(reconciled)).not.toMatch(/private|secret-presentation/)
  })
})
