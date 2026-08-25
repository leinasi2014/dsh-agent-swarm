import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { AttemptId, TaskId, TeamId, type TeamState, type TeamTask } from '../src/domain/types.js'
import {
  deterministicRootPath,
  EXECUTION_ROOT_MARKER,
  ExecutionRoots,
  gitWorktreeExecutionRoots,
} from '../src/runtime/execution-roots.js'

const sandboxes: string[] = []
const TEAM = TeamId('team-11111111-1111-1111-1111-111111111111')
const TASK = TaskId('task-1')
const attempt = (tail: string): AttemptId => AttemptId(`attempt-11111111-1111-1111-1111-1111111111${tail}`)

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
})

async function sandbox(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-root-identity-'))
  sandboxes.push(root)
  return root
}

function manager(base: string): ExecutionRoots {
  return new ExecutionRoots(new Context(), {
    enabled: () => true,
    providerName: () => 'git-worktree',
    base,
    builtin: gitWorktreeExecutionRoots,
  })
}

function state(task: TeamTask, attempts: TeamState['attempts']): TeamState {
  return {
    schemaVersion: 1, id: TEAM, revision: 3, name: 'identity', description: 'fixture',
    captainSessionId: 'captain', phase: 'active', members: [], tasks: [task], attempts,
    messages: [], budget: { usedTokens: 0, usedRequests: 0, usedRetries: 0 }, usageCursors: {}, memory: [],
    nextTaskNumber: 2, nextMemoryNumber: 1, createdAt: 1, updatedAt: 1,
  }
}

describe('execution-root artifact identity fencing', () => {
  it('fails loud when the newest delivered predecessor is missing instead of falling back', async () => {
    const root = await sandbox()
    const scope = join(root, 'workspace')
    const roots = manager(join(root, 'roots'))
    const first = attempt('a1')
    const newest = attempt('a2')
    const successor = attempt('a3')
    const oldLease = await roots.acquire(scope, TEAM, TASK, first)
    writeFileSync(join(oldLease.path, 'stale.txt'), 'must not inherit\n', 'utf8')
    await roots.acquire(scope, TEAM, TASK, newest)
    rmSync(deterministicRootPath(join(root, 'roots'), scope, TEAM, TASK, newest), { recursive: true, force: true })
    await roots.acquire(scope, TEAM, TASK, successor)
    const task: TeamTask = {
      id: TASK, revision: 3, subject: 'recover', description: 'd', acceptanceCriteria: [], status: 'in_progress',
      blockedBy: [], writeScopes: [], priority: 0, ownerSessionId: 'member-3', currentAttemptId: successor, createdAt: 1, updatedAt: 2,
    }
    const team = state(task, [
      { id: first, taskId: TASK, generation: 1, memberSessionId: 'm1', phase: 'stale', assignmentPhase: 'delivered', evidence: [], createdAt: 1, updatedAt: 1 },
      { id: newest, taskId: TASK, generation: 2, memberSessionId: 'm2', phase: 'stale', assignmentPhase: 'delivered', evidence: [], createdAt: 2, updatedAt: 2 },
      { id: successor, taskId: TASK, generation: 3, memberSessionId: 'm3', phase: 'running', assignmentPhase: 'reserved', evidence: [], createdAt: 3, updatedAt: 3 },
    ])
    expect(() => roots.inheritLatestAttempt(scope, team, task, team.attempts[2]!)).toThrowError(expect.objectContaining({ code: 'TEAM_EXECUTION_ROOT_HANDOFF_MISSING' }))
  })

  it('rejects an accepted dependency root whose marker does not own its fence tuple', async () => {
    const root = await sandbox()
    const scope = join(root, 'workspace')
    const roots = manager(join(root, 'roots'))
    const dependencyAttempt = attempt('d1')
    const targetAttempt = attempt('d2')
    const targetTaskId = TaskId('task-2')
    const source = await roots.acquire(scope, TEAM, TASK, dependencyAttempt)
    mkdirSync(join(source.path, 'public'), { recursive: true })
    const markerPath = join(source.path, EXECUTION_ROOT_MARKER)
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as Record<string, unknown>
    writeFileSync(markerPath, JSON.stringify({ ...marker, taskId: 'task-forged' }), 'utf8')
    await roots.acquire(scope, TEAM, targetTaskId, targetAttempt)
    const dependency: TeamTask = {
      id: TASK, revision: 2, subject: 'dep', description: 'd', acceptanceCriteria: [], status: 'completed', blockedBy: [],
      writeScopes: ['public/'], priority: 0, currentAttemptId: dependencyAttempt, output: 'accepted', createdAt: 1, updatedAt: 2,
    }
    const target: TeamTask = {
      id: targetTaskId, revision: 2, subject: 'target', description: 'd', acceptanceCriteria: [], status: 'in_progress', blockedBy: [TASK],
      writeScopes: [], priority: 0, ownerSessionId: 'qa', currentAttemptId: targetAttempt, createdAt: 2, updatedAt: 3,
    }
    const team = { ...state(dependency, [
      { id: dependencyAttempt, taskId: TASK, generation: 1, memberSessionId: 'm1', phase: 'accepted', assignmentPhase: 'delivered', evidence: [], createdAt: 1, updatedAt: 2 },
      { id: targetAttempt, taskId: targetTaskId, generation: 1, memberSessionId: 'qa', phase: 'running', assignmentPhase: 'reserved', evidence: [], createdAt: 2, updatedAt: 3 },
    ]), tasks: [dependency, target] }
    expect(() => roots.inheritCompletedDependencies(scope, team, target, team.attempts[1]!)).toThrowError(expect.objectContaining({ code: 'TEAM_EXECUTION_ROOT_DEPENDENCY_MISSING' }))
  })
})
