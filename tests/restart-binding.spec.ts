import { describe, expect, it } from 'vitest'
import { AttemptId, TaskId, TeamId, type TeamState } from '../src/domain/types.js'
import { deriveRestartSafeAttemptBinding, parseRestartSafeAttemptBinding } from '../src/runtime/restart-binding.js'

const TEAM = TeamId('team-11111111-1111-1111-1111-111111111111')
const TASK = TaskId('task-1')
const ATTEMPT = AttemptId('attempt-11111111-1111-1111-1111-111111111111')

function fixture(): TeamState {
  return {
    schemaVersion: 1, id: TEAM, revision: 3, name: 'restart', description: 'fixture', captainSessionId: 'captain-1', phase: 'active',
    members: [],
    tasks: [{ id: TASK, revision: 4, subject: 'subject', description: 'description', acceptanceCriteria: [], status: 'in_progress', blockedBy: [], writeScopes: [], priority: 0, ownerSessionId: 'member-1', currentAttemptId: ATTEMPT, createdAt: 1, updatedAt: 1 }],
    attempts: [{ id: ATTEMPT, taskId: TASK, generation: 2, memberSessionId: 'member-1', phase: 'running', assignmentPhase: 'delivered', assignmentDeliveredAt: 1, evidence: [], createdAt: 1, updatedAt: 1 }],
    messages: [], budget: { usedTokens: 0, usedRequests: 0, usedRetries: 0 }, usageCursors: {}, memory: [], nextTaskNumber: 2, nextMemoryNumber: 1, createdAt: 1, updatedAt: 1,
  }
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
  } catch (error) {
    expect(error).toMatchObject({ code })
    return
  }
  throw new Error(`expected ${code}`)
}

describe('restart-safe attempt binding', () => {
  it('derives an immutable, secret-free identity and revalidates its JSON round trip', () => {
    const binding = deriveRestartSafeAttemptBinding(fixture(), TASK)
    expect(binding).toEqual({ teamId: TEAM, taskId: TASK, taskRevision: 4, attemptId: ATTEMPT, attemptGeneration: 2, memberSessionId: 'member-1' })
    expect(Object.isFrozen(binding)).toBe(true)
    expect(Object.keys(binding).toSorted()).toEqual(['attemptGeneration', 'attemptId', 'memberSessionId', 'taskId', 'taskRevision', 'teamId'])
    expect(parseRestartSafeAttemptBinding(fixture(), JSON.parse(JSON.stringify(binding)))).toEqual(binding)
  })

  const malformed: ReadonlyArray<readonly [string, (team: TeamState) => TeamState, string]> = [
    ['missing task', (team: TeamState) => ({ ...team, tasks: [] }), 'TEAM_RESTART_BINDING_TASK_MISSING'],
    ['missing current attempt', (team: TeamState) => {
      const { currentAttemptId: _currentAttemptId, ...task } = team.tasks[0]!
      return { ...team, tasks: [task] }
    }, 'TEAM_RESTART_BINDING_CURRENT_ATTEMPT_MISSING'],
    ['task mismatch', (team: TeamState) => ({ ...team, attempts: [{ ...team.attempts[0]!, taskId: TaskId('task-other') }] }), 'TEAM_RESTART_BINDING_TASK_ATTEMPT_MISMATCH'],
    ['owner mismatch', (team: TeamState) => ({ ...team, tasks: [{ ...team.tasks[0]!, ownerSessionId: 'member-other' }] }), 'TEAM_RESTART_BINDING_OWNER_MISMATCH'],
    ['terminal phase', (team: TeamState) => ({ ...team, attempts: [{ ...team.attempts[0]!, phase: 'submitted' as const }] }), 'TEAM_RESTART_BINDING_PHASE_INVALID'],
  ]

  it.each(malformed)('rejects %s aggregate', (_name, mutate, code) => {
    expectCode(() => deriveRestartSafeAttemptBinding(mutate(fixture()), TASK), code)
  })

  it('rejects stale or expanded restored JSON instead of treating it as authority', () => {
    const team = fixture()
    const binding = JSON.parse(JSON.stringify(deriveRestartSafeAttemptBinding(team, TASK))) as Record<string, unknown>
    expectCode(() => parseRestartSafeAttemptBinding({ ...team, tasks: [{ ...team.tasks[0]!, revision: 5 }] }, binding), 'TEAM_RESTART_BINDING_STALE')
    const successor = AttemptId('attempt-22222222-2222-2222-2222-222222222222')
    const reassigned: TeamState = {
      ...team,
      tasks: [{ ...team.tasks[0]!, revision: 5, currentAttemptId: successor }],
      attempts: [
        { ...team.attempts[0]!, phase: 'stale' },
        { ...team.attempts[0]!, id: successor, generation: 3 },
      ],
    }
    expectCode(() => parseRestartSafeAttemptBinding(reassigned, binding), 'TEAM_RESTART_BINDING_STALE')
    expectCode(() => parseRestartSafeAttemptBinding(team, { ...binding, executionRoot: 'C:\\secret' }), 'TEAM_RESTART_BINDING_INVALID')
  })
})
