/**
 * Per-attempt execution-root fault suite (M3-1, issue #100; docs/04 §8l):
 * the three contract fault faces over the REAL provider and manager —
 * parallel attempts isolated in distinct worktree roots with zero
 * cross-contamination, reclamation when an attempt fails/settles, and
 * crash-leftover roots detected, alarmed and marked reclaimable without
 * auto-deletion — plus the authority-derived hold rule and the composition
 * wiring (assignment-frame root declaration through the official cwd seam,
 * self-claim root disclosure, submit-time release and conflict rollback).
 *
 * Evidence tags: docs/08 scenario 21 (distinct worktree/tool roots for two
 * parallel coding attempts).
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import {
  attemptHoldsExecutionRoot,
  deterministicRootPath,
  EXECUTION_ROOT_DEPENDENCIES,
  EXECUTION_ROOT_HANDOFF,
  EXECUTION_ROOT_MARKER,
  ExecutionRoots,
  gitWorktreeExecutionRoots,
} from '../src/runtime/execution-roots.js'
import { AttemptId, TaskId, TeamId, type TeamState, type TeamTask } from '../src/domain/types.js'
import { mount as mountGated, toolCall } from './helpers/gated-composition.js'
import { mountModesComposition, toolCall as modesToolCall } from './helpers/modes-composition.js'

const execFileAsync = promisify(execFile)

/** Sandbox registries cleaned after every test (Windows file locks). */
const sandboxes: string[] = []

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
})

async function freshSandbox(prefix: string): Promise<string> {
  const sandbox = await mkdtemp(join(tmpdir(), `dsh-roots-${prefix}-`))
  sandboxes.push(sandbox)
  return sandbox
}

/** One initialized repository with one committed file at `workspace`. */
async function initRepoWorkspace(sandbox: string): Promise<string> {
  const workspace = join(sandbox, 'workspace')
  mkdirSync(workspace, { recursive: true })
  await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: workspace })
  writeFileSync(join(workspace, 'tracked.txt'), 'base\n', 'utf8')
  await execFileAsync('git', ['add', '.'], { cwd: workspace })
  await execFileAsync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'base'], { cwd: workspace })
  return workspace
}

/** A manager over `base`, isolated per test. */
function managerOver(base: string): ExecutionRoots {
  return new ExecutionRoots(new Context(), {
    enabled: () => true,
    providerName: () => 'git-worktree',
    base,
    builtin: gitWorktreeExecutionRoots,
  })
}

const TEAM = TeamId('team-11111111-1111-1111-1111-111111111111')
const TEAM_OTHER = TeamId('team-22222222-2222-2222-2222-222222222222')
const TASK = TaskId('task-1')
const attempt = (tail: string): AttemptId => AttemptId(`attempt-11111111-1111-1111-1111-1111111111${tail}`)
const RUNNING = attempt('bb')

/** Synthetic aggregate fixture driving the hold-rule and scan faces. */
function teamFixture(overrides: Partial<TeamState> = {}): TeamState {
  return {
    schemaVersion: 1,
    id: TEAM,
    revision: 3,
    name: 'Roots fixture',
    description: 'Fixture aggregate for execution-root holds.',
    captainSessionId: 'captain-1',
    phase: 'active',
    members: [],
    tasks: [{
      id: TASK, revision: 3, subject: 's', description: 'd', acceptanceCriteria: [],
      status: 'in_progress', blockedBy: [], writeScopes: [], priority: 0,
      ownerSessionId: 'member-1', currentAttemptId: RUNNING,
      createdAt: 1, updatedAt: 1,
    }],
    attempts: [{
      id: RUNNING, taskId: TASK, generation: 1,
      memberSessionId: 'member-1', phase: 'running', assignmentPhase: 'delivered', evidence: [], createdAt: 1, updatedAt: 1,
    }],
    messages: [],
    budget: { usedTokens: 0, usedRequests: 0, usedRetries: 0 },
    usageCursors: {},
    memory: [],
    nextTaskNumber: 2,
    nextMemoryNumber: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('execution-root provider isolation (M3-1, issue #100)', () => {
  it('scenario 21: two parallel attempts hold distinct worktree roots with zero cross-contamination', async () => {
    const sandbox = await freshSandbox('parallel')
    const workspace = await initRepoWorkspace(sandbox)
    const base = join(sandbox, 'roots')
    const roots = managerOver(base)

    const [leaseA, leaseB] = await Promise.all([
      roots.acquire(workspace, TEAM, TASK, attempt('aa')),
      roots.acquire(workspace, TEAM, TASK, attempt('bb')),
    ])
    expect(leaseA.path).not.toBe(leaseB.path)
    expect(leaseA.isolation).toBe('git-worktree')
    expect(leaseB.isolation).toBe('git-worktree')
    // Both roots are real checkouts of the same repository...
    expect(existsSync(join(leaseA.path, 'tracked.txt'))).toBe(true)
    expect(existsSync(join(leaseB.path, 'tracked.txt'))).toBe(true)
    // ...and each carries its durable identity marker.
    expect(existsSync(join(leaseA.path, EXECUTION_ROOT_MARKER))).toBe(true)
    expect(existsSync(join(leaseB.path, EXECUTION_ROOT_MARKER))).toBe(true)

    // Each attempt writes only inside its own root.
    writeFileSync(join(leaseA.path, 'attempt-a.txt'), 'a\n', 'utf8')
    writeFileSync(join(leaseB.path, 'attempt-b.txt'), 'b\n', 'utf8')
    expect(existsSync(join(leaseA.path, 'attempt-a.txt'))).toBe(true)
    expect(existsSync(join(leaseA.path, 'attempt-b.txt'))).toBe(false)
    expect(existsSync(join(leaseB.path, 'attempt-b.txt'))).toBe(true)
    expect(existsSync(join(leaseB.path, 'attempt-a.txt'))).toBe(false)
    // The shared workspace checkout itself stays untouched.
    expect(readdirSync(workspace).includes('attempt-a.txt')).toBe(false)
    expect(readdirSync(workspace).includes('attempt-b.txt')).toBe(false)
  }, 60_000)

  it('degrades to a declared independent temp directory when the scope holds no repository', async () => {
    const sandbox = await freshSandbox('norepo')
    const base = join(sandbox, 'roots')
    const roots = managerOver(base)
    const lease = await roots.acquire(join(sandbox, 'plain-workspace'), TEAM, TASK, attempt('cc'))
    expect(lease.isolation).toBe('temp-directory')
    expect(existsSync(join(lease.path, EXECUTION_ROOT_MARKER))).toBe(true)
    expect(lease.path.startsWith(base)).toBe(true)
  })

  it('releases and reclaims a failed attempt\'s root; a re-acquire starts fresh', async () => {
    const sandbox = await freshSandbox('reclaim')
    const workspace = await initRepoWorkspace(sandbox)
    const base = join(sandbox, 'roots')
    const roots = managerOver(base)
    const key = attempt('dd')
    const lease = await roots.acquire(workspace, TEAM, TASK, key)
    writeFileSync(join(lease.path, 'partial-work.txt'), 'dirty output of a failed attempt\n', 'utf8')
    await roots.release(workspace, TEAM, TASK, key, 'attempt failed')
    expect(existsSync(lease.path)).toBe(false)
    expect(roots.leaseOf(workspace, TEAM, TASK, key)).toBeUndefined()
    const fresh = await roots.acquire(workspace, TEAM, TASK, key)
    expect(existsSync(join(fresh.path, 'partial-work.txt'))).toBe(false)
    expect(existsSync(join(fresh.path, 'tracked.txt'))).toBe(true)
    await roots.releaseAll('test teardown')
  }, 60_000)

  it('deduplicates concurrent acquires of the same fence tuple to one root', async () => {
    const sandbox = await freshSandbox('dedup')
    const base = join(sandbox, 'roots')
    const roots = managerOver(base)
    const key = attempt('ee')
    const [first, second] = await Promise.all([
      roots.acquire(join(sandbox, 'w'), TEAM, TASK, key),
      roots.acquire(join(sandbox, 'w'), TEAM, TASK, key),
    ])
    expect(first).toBe(second)
    expect(first.path).toBe(deterministicRootPath(base, join(sandbox, 'w'), TEAM, TASK, key))
    await roots.releaseAll('test teardown')
  })

  it('seeds a replacement generation from the newest delivered predecessor before reclaim', async () => {
    const sandbox = await freshSandbox('handoff')
    const scope = join(sandbox, 'workspace')
    const base = join(sandbox, 'roots')
    const roots = managerOver(base)
    const previous = attempt('a1')
    const successor = attempt('a2')
    const source = await roots.acquire(scope, TEAM, TASK, previous)
    writeFileSync(join(source.path, 'package.json'), '{"name":"recovered"}\n', 'utf8')
    mkdirSync(join(source.path, 'server'), { recursive: true })
    writeFileSync(join(source.path, 'server', 'index.js'), 'export const recovered = true\n', 'utf8')
    mkdirSync(join(source.path, 'node_modules'), { recursive: true })
    writeFileSync(join(source.path, 'node_modules', 'discarded.js'), 'cache\n', 'utf8')

    const task: TeamTask = {
      id: TASK, revision: 4, subject: 's', description: 'd', acceptanceCriteria: [],
      status: 'in_progress', blockedBy: [], writeScopes: [], priority: 0,
      ownerSessionId: 'member-2', currentAttemptId: successor,
      createdAt: 1, updatedAt: 2,
    }
    const handoffTeam = teamFixture({
      tasks: [task],
      attempts: [
        { id: previous, taskId: TASK, generation: 1, memberSessionId: 'member-1', phase: 'stale', assignmentPhase: 'delivered', evidence: [], createdAt: 1, updatedAt: 2 },
        { id: successor, taskId: TASK, generation: 2, memberSessionId: 'member-2', phase: 'running', assignmentPhase: 'reserved', evidence: [], createdAt: 2, updatedAt: 2 },
      ],
    })
    const target = await roots.acquire(scope, TEAM, TASK, successor)
    expect(roots.inheritLatestAttempt(scope, handoffTeam, task, handoffTeam.attempts[1]!)).toEqual({
      sourceAttemptId: previous,
      copiedEntries: 2,
    })
    expect(readFileSync(join(target.path, 'package.json'), 'utf8')).toContain('recovered')
    expect(readFileSync(join(target.path, 'server', 'index.js'), 'utf8')).toContain('recovered = true')
    expect(existsSync(join(target.path, 'node_modules', 'discarded.js'))).toBe(false)
    expect(JSON.parse(readFileSync(join(target.path, EXECUTION_ROOT_HANDOFF), 'utf8'))).toMatchObject({
      sourceAttemptId: previous,
      targetAttemptId: successor,
      copiedEntries: 2,
    })

    const delivered = teamFixture({
      tasks: [task],
      attempts: [
        handoffTeam.attempts[0]!,
        { ...handoffTeam.attempts[1]!, assignmentPhase: 'delivered' },
      ],
    })
    await roots.sweepSettledAttempts(scope, TEAM, delivered)
    expect(existsSync(source.path)).toBe(false)
    expect(existsSync(target.path)).toBe(true)
    await roots.releaseAll('test teardown')
  })

  it('materializes accepted blocker artifacts by declared write scope for a dependent task', async () => {
    const sandbox = await freshSandbox('dependencies')
    const scope = join(sandbox, 'workspace')
    const roots = managerOver(join(sandbox, 'roots'))
    const dependencyAttemptId = attempt('d1')
    const targetAttemptId = attempt('d2')
    const targetTaskId = TaskId('task-2')
    const source = await roots.acquire(scope, TEAM, TASK, dependencyAttemptId)
    mkdirSync(join(source.path, 'public'), { recursive: true })
    writeFileSync(join(source.path, 'public', 'index.html'), '<h1>accepted</h1>\n', 'utf8')
    writeFileSync(join(source.path, 'private-note.txt'), 'must not cross scope\n', 'utf8')
    const target = await roots.acquire(scope, TEAM, targetTaskId, targetAttemptId)
    const dependencyTask: TeamTask = {
      id: TASK, revision: 5, subject: 'dependency', description: 'd', acceptanceCriteria: [],
      status: 'completed', blockedBy: [], writeScopes: ['public/'], priority: 0,
      currentAttemptId: dependencyAttemptId, output: 'accepted frontend', createdAt: 1, updatedAt: 2,
    }
    const targetTask: TeamTask = {
      id: targetTaskId, revision: 2, subject: 'qa', description: 'd', acceptanceCriteria: [],
      status: 'in_progress', blockedBy: [TASK], writeScopes: ['tests/'], priority: 0,
      ownerSessionId: 'qa-1', currentAttemptId: targetAttemptId, createdAt: 2, updatedAt: 3,
    }
    const state = teamFixture({
      tasks: [dependencyTask, targetTask],
      attempts: [
        { id: dependencyAttemptId, taskId: TASK, generation: 1, memberSessionId: 'worker-1', phase: 'accepted', assignmentPhase: 'delivered', evidence: [], output: 'accepted frontend', createdAt: 1, updatedAt: 2 },
        { id: targetAttemptId, taskId: targetTaskId, generation: 1, memberSessionId: 'qa-1', phase: 'running', assignmentPhase: 'reserved', evidence: [], createdAt: 2, updatedAt: 3 },
      ],
    })
    expect(roots.inheritCompletedDependencies(scope, state, targetTask, state.attempts[1]!)).toEqual([{
      taskId: TASK,
      attemptId: dependencyAttemptId,
      copiedScopes: ['public/'],
    }])
    expect(readFileSync(join(target.path, 'public', 'index.html'), 'utf8')).toContain('accepted')
    expect(existsSync(join(target.path, 'private-note.txt'))).toBe(false)
    expect(JSON.parse(readFileSync(join(target.path, EXECUTION_ROOT_DEPENDENCIES), 'utf8'))).toMatchObject({
      targetAttemptId,
      dependencies: [{ taskId: TASK, attemptId: dependencyAttemptId, copiedScopes: ['public/'] }],
    })
    await roots.releaseAll('test teardown')
  })

  it('preserves roots on runtime detach and reclaims verified roots after Team archival', async () => {
    const sandbox = await freshSandbox('archive')
    const scope = join(sandbox, 'workspace')
    const base = join(sandbox, 'roots')
    const roots = managerOver(base)
    const key = attempt('e1')
    const lease = await roots.acquire(scope, TEAM, TASK, key)
    writeFileSync(join(lease.path, 'durable.txt'), 'survives restart\n', 'utf8')
    await roots.detachAll()
    expect(existsSync(join(lease.path, 'durable.txt'))).toBe(true)

    const recovered = managerOver(base)
    expect(await recovered.reclaimTeam(scope, TEAM, 'Team archived')).toBe(1)
    expect(existsSync(lease.path)).toBe(false)
  })

  it('fails loud on a foreign occupant of the deterministic root path', async () => {
    const sandbox = await freshSandbox('conflict')
    const scope = join(sandbox, 'w')
    const base = join(sandbox, 'roots')
    const key = attempt('ff')
    const occupied = deterministicRootPath(base, scope, TEAM, TASK, key)
    mkdirSync(occupied, { recursive: true })
    writeFileSync(join(occupied, 'foreign.txt'), 'not ours\n', 'utf8')
    const roots = managerOver(base)
    await expect(roots.acquire(scope, TEAM, TASK, key)).rejects.toMatchObject({
      code: 'TEAM_EXECUTION_ROOT_CONFLICT',
    })
  })
})

describe('execution-root crash residue detection (M3-1, issue #100)', () => {
  it('scenario 21 (crash face): a crash-left settled root is alarmed, marked reclaimable and kept; a redrivable attempt reports reattachable', async () => {
    const sandbox = await freshSandbox('crash')
    const workspace = await initRepoWorkspace(sandbox)
    const base = join(sandbox, 'roots')
    // The "crashed" process: acquired two roots and died without releasing
    // (two Teams so each marker resolves against its own authoritative
    // aggregate — the same shape two parallel squads leave behind).
    const crashed = managerOver(base)
    const settledRoot = await crashed.acquire(workspace, TEAM_OTHER, TASK, attempt('aa'))
    const liveRoot = await crashed.acquire(workspace, TEAM, TASK, attempt('bb'))
    const foreign = deterministicRootPath(base, workspace, TEAM, TASK, attempt('99'))
    mkdirSync(foreign, { recursive: true })
    const settledTeam = teamFixture({
      id: TEAM_OTHER,
      attempts: [{
        id: attempt('aa'), taskId: TASK, generation: 1, memberSessionId: 'member-1',
        phase: 'cancelled', assignmentPhase: 'delivered', evidence: [], createdAt: 1, updatedAt: 1,
      }],
    })
    const runningTeam = teamFixture()

    // The recovered process holds ZERO live leases (fresh manager, same base).
    const recovered = managerOver(base)
    const residues = await recovered.scanResidue(workspace, [settledTeam, runningTeam])
    const byPath = new Map(residues.map(residue => [residue.path, residue]))
    const settled = byPath.get(settledRoot.path)
    expect(settled?.verdict).toBe('orphan')
    expect(existsSync(join(settledRoot.path, '.dsh-execution-root.reclaimable.json'))).toBe(true)
    expect(existsSync(settledRoot.path)).toBe(true) // never auto-deleted
    const live = byPath.get(liveRoot.path)
    expect(live?.verdict).toBe('reattachable')
    expect(existsSync(join(liveRoot.path, '.dsh-execution-root.reclaimable.json'))).toBe(false)
    const stranger = byPath.get(foreign)
    expect(stranger?.verdict).toBe('orphan')
    expect(stranger?.identity).toBeUndefined()
    expect(existsSync(foreign)).toBe(true)
    await recovered.releaseAll('test teardown')
  }, 60_000)

  it('issue #122 F9: a marker whose recorded path is not the directory it lives in cannot vouch for it', async () => {
    const sandbox = await freshSandbox('marker-path')
    const workspace = await initRepoWorkspace(sandbox)
    const base = join(sandbox, 'roots')
    const manager = managerOver(base)
    const root = await manager.acquire(workspace, TEAM, TASK, attempt('dd'))
    // A worker-controlled copy inside the SAME scanned scope partition: the
    // marker claims a DIFFERENT directory. The F9 rule treats it as
    // unreadable — the residue report calls it an orphan without identity
    // instead of trusting the forged identity.
    const forgedPath = join(dirname(root.path), 'zz-forged')
    mkdirSync(forgedPath, { recursive: true })
    const marker = JSON.parse(readFileSync(join(root.path, EXECUTION_ROOT_MARKER), 'utf8')) as Record<string, unknown>
    writeFileSync(join(forgedPath, EXECUTION_ROOT_MARKER), JSON.stringify({ ...marker, path: root.path }), 'utf8')
    // scan with a FRESH manager (zero live leases — the crash-test form; a
    // leased root is skipped by design, and release would remove the root)
    const recovered = managerOver(base)
    const residues = await recovered.scanResidue(workspace, [teamFixture()])
    const forged = residues.find(residue => residue.path === forgedPath)
    expect(forged?.verdict).toBe('orphan')
    expect(forged?.identity).toBeUndefined()
    expect(forged?.reason).toContain('no readable execution-root marker')
    // the legitimate marker (path matches its directory) still resolves normally
    const honest = residues.find(residue => residue.path === root.path)
    expect(honest?.identity?.attemptId).toBe(attempt('dd'))
  }, 60_000)

  it('derives the hold rule only from the authoritative aggregate', () => {
    const running = RUNNING
    expect(attemptHoldsExecutionRoot(teamFixture(), running)).toBe(true)
    for (const phase of ['submitted', 'verifying', 'accepted'] as const) {
      const durable = teamFixture({
        attempts: [{
          id: running, taskId: TASK, generation: 1, memberSessionId: 'member-1',
          phase, assignmentPhase: 'delivered', evidence: [], createdAt: 1, updatedAt: 1,
        }],
      })
      expect(attemptHoldsExecutionRoot(durable, running)).toBe(true)
    }
    for (const phase of ['rejected', 'cancelled'] as const) {
      const settled = teamFixture({
        attempts: [{
          id: running, taskId: TASK, generation: 1, memberSessionId: 'member-1',
          phase, assignmentPhase: 'delivered', evidence: [], createdAt: 1, updatedAt: 1,
        }],
      })
      expect(attemptHoldsExecutionRoot(settled, running)).toBe(false)
    }
    const pendingTasks: TeamTask[] = [{
      id: TASK, revision: 4, subject: 's', description: 'd', acceptanceCriteria: [],
      status: 'pending', blockedBy: [], writeScopes: [], priority: 0,
      createdAt: 1, updatedAt: 2,
    }]
    expect(attemptHoldsExecutionRoot(teamFixture({
      tasks: pendingTasks,
      attempts: [{
        id: running, taskId: TASK, generation: 1, memberSessionId: 'member-1',
        phase: 'stale', assignmentPhase: 'delivered', evidence: [], createdAt: 1, updatedAt: 2,
      }],
    }), running)).toBe(true)
    // A stale attempt holds exactly through the reinstate window: successor
    // still reserved and naming it as the attempt it replaced.
    const successor = attempt('ce')
    const retriedTasks: TeamTask[] = [{
      id: TASK, revision: 4, subject: 's', description: 'd', acceptanceCriteria: [],
      status: 'in_progress', blockedBy: [], writeScopes: [], priority: 0,
      ownerSessionId: 'member-1', currentAttemptId: successor,
      createdAt: 1, updatedAt: 2,
    }]
    const staleWindow = teamFixture({
      tasks: retriedTasks,
      attempts: [
        { id: running, taskId: TASK, generation: 1, memberSessionId: 'member-1', phase: 'stale', assignmentPhase: 'delivered', evidence: [], createdAt: 1, updatedAt: 2 },
        { id: successor, taskId: TASK, generation: 2, memberSessionId: 'member-1', phase: 'running', assignmentPhase: 'reserved', evidence: [], replacesAttemptId: running, createdAt: 2, updatedAt: 2 },
      ],
    })
    expect(attemptHoldsExecutionRoot(staleWindow, running)).toBe(true)
    const delivered = teamFixture({
      tasks: retriedTasks,
      attempts: [
        { id: running, taskId: TASK, generation: 1, memberSessionId: 'member-1', phase: 'stale', assignmentPhase: 'delivered', evidence: [], createdAt: 1, updatedAt: 2 },
        { id: successor, taskId: TASK, generation: 2, memberSessionId: 'member-1', phase: 'running', assignmentPhase: 'delivered', evidence: [], replacesAttemptId: running, createdAt: 2, updatedAt: 3 },
      ],
    })
    expect(attemptHoldsExecutionRoot(delivered, running)).toBe(false)
    expect(attemptHoldsExecutionRoot(teamFixture(), AttemptId('attempt-pruned'))).toBe(false)
  })
})

describe('execution-root composition wiring (M3-1, issue #100)', () => {
  it('scenario 21 (seam): the dispatched assignment frame declares the deterministic root and submit preserves its candidate tree', async () => {
    const sandbox = await freshSandbox('compose')
    const workspace = await initRepoWorkspace(sandbox)
    const base = join(sandbox, 'roots')
    const composition = await mountModesComposition(sandbox, { executionRoots: true, executionRootsBase: base })
    const scope = composition.ctx.agentSwarm.scopeOf(composition.lead)
    try {
      const { ctx, adapter } = composition
      const created = await modesToolCall(ctx, composition.lead, 'roots-create', 'agent_swarm_create', {
        name: 'Roots composition team', description: 'Prove the per-attempt execution-root wiring.',
      })
      expect(created.isError).toBe(false)
      const teamId = AgentSwarm.TeamId((created.value as { team_id: string }).team_id)
      const added = await modesToolCall(ctx, composition.lead, 'roots-add', 'agent_swarm_add_member', {
        name: 'root-worker', role: 'Work inside the execution root.',
      })
      expect(added.isError).toBe(false)
      const memberId = (added.value as { session_id: string }).session_id
      const task = await modesToolCall(ctx, composition.lead, 'roots-task', 'agent_swarm_create_task', {
        subject: 'Write inside the attempt root',
        description: 'Create the marker file inside the declared execution root.',
      })
      expect(task.isError).toBe(false)

      // Release the member's held join turn ONCE: its idle edge drives the
      // pass that claims the task and dispatches the assignment frame, which
      // the member parks on. Re-opening inside the wait would run that
      // assignment turn before `submit` is armed below and strand the flow.
      adapter.open()
      await vi.waitFor(async () => {
        const snapshot = await ctx.agentSwarm.domain.snapshot(scope, teamId, composition.lead.id)
        const claimedNow = snapshot.team.tasks.find((candidate: TeamTask) => candidate.status === 'in_progress')
        // A plain early return would read as success to vi.waitFor: keep
        // polling by asserting the claim exists.
        expect(claimedNow?.currentAttemptId).toBeDefined()
        const leased = ctx.agentSwarm.executionRoots.roots.leaseOf(scope, teamId, claimedNow!.id, claimedNow!.currentAttemptId!)
        expect(leased).toBeDefined()
        expect(existsSync(join(leased!.path, EXECUTION_ROOT_MARKER))).toBe(true)
      }, { timeout: 20_000 })
      const snapshot = await ctx.agentSwarm.domain.snapshot(scope, teamId, composition.lead.id)
      const claimed = snapshot.team.tasks.find((candidate: TeamTask) => candidate.status === 'in_progress')!
      const attemptId = claimed.currentAttemptId!
      const expectedPath = deterministicRootPath(base, scope, teamId, claimed.id, attemptId)
      // The root physically exists and is leased to exactly this attempt.
      expect(existsSync(expectedPath)).toBe(true)
      expect(existsSync(join(expectedPath, EXECUTION_ROOT_MARKER))).toBe(true)
      expect(ctx.agentSwarm.executionRoots.roots.leaseOf(scope, teamId, claimed.id, attemptId)?.path).toBe(expectedPath)
      // The delivered frame declares the root through the official cwd seam:
      // the member sees the absolute path it must use as its shell workdir.
      const textsOf = (events: readonly { type: string, data: unknown }[]): string[] => {
        const texts: string[] = []
        for (const event of events) {
          const data = event.data as { content?: unknown, inserted?: unknown } | null
          const blocks = Array.isArray(data?.content) ? data.content : Array.isArray(data?.inserted) ? data.inserted : []
          for (const block of blocks as { type?: string, text?: string }[]) {
            if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
          }
        }
        return texts
      }
      await vi.waitFor(async () => {
        const stored = await ctx.sessionPersistence.inspect(SessionId(memberId), new AbortController().signal)
        expect(textsOf(stored.events).some(text => text.includes(expectedPath))).toBe(true)
      }, { timeout: 10_000 })

      // Submission (the member's real agent_swarm_submit_task) settles the
      // attempt but preserves its executable candidate tree for review and
      // downstream dependency use; the shared workspace stays untouched.
      adapter.submit = true
      await vi.waitFor(async () => {
        adapter.open()
        await new Promise(resolve => setTimeout(resolve, 120))
        const settled = await ctx.agentSwarm.domain.snapshot(scope, teamId, composition.lead.id)
        expect(settled.team.tasks.find((candidate: TeamTask) => candidate.id === claimed.id)?.status).toBe('submitted')
        expect(existsSync(expectedPath)).toBe(true)
      }, { timeout: 20_000 })
      expect(readdirSync(workspace).includes('tracked.txt')).toBe(true)
    } finally {
      for (const fiber of composition.fibers.toReversed()) await fiber.dispose()
    }
  }, 90_000)

  it('discloses the root on the self-claim face and rolls the claim back when acquisition fails', async () => {
    const sandbox = await freshSandbox('claimface')
    const base = join(sandbox, 'roots')
    const composition = await mountGated(sandbox, 60_000, 'priority-ready', {
      executionRoots: true, executionRootsBase: base,
    })
    const { ctx, lead } = composition
    try {
      const teamId = AgentSwarm.TeamId(composition.teamId)
      const added = await toolCall(ctx, lead, 'roots-add', 'agent_swarm_add_member', { name: 'claimer', role: 'Claim and disclose.' })
      expect(added.isError).toBe(false)
      const memberId = (added.value as { session_id: string }).session_id
      const member = await vi.waitFor(() => {
        const live = ctx.agents.get(SessionId(memberId))
        expect(live).toBeDefined()
        return live!
      }, { timeout: 10_000 })
      const task = await toolCall(ctx, lead, 'roots-task', 'agent_swarm_create_task', {
        subject: 'Self-claim with a root', description: 'The claim result must disclose the execution root.',
      })
      expect(task.isError).toBe(false)
      const taskId = (task.value as { task_id: string }).task_id
      const pending = (await ctx.agentSwarm.domain.snapshot(composition.scope, teamId, lead.id))
        .team.tasks.find(candidate => candidate.id === taskId)!
      expect(pending.status).toBe('pending') // the gated member is running: no dispatch steals it

      // The member's self-claim acquires and discloses its root (the
      // workspace holds no repository: the declared degradation applies).
      const claim = await ctx.agentSwarm.claimTask({ agent: member, signal: new AbortController().signal }, taskId, pending.revision)
      expect(claim.executionRoot?.isolation).toBe('temp-directory')
      expect(existsSync(claim.executionRoot!.path)).toBe(true)
      expect(ctx.agentSwarm.executionRoots.roots.leaseOf(composition.scope, teamId, TaskId(taskId), claim.attempt.id)?.path)
        .toBe(claim.executionRoot!.path)

      // The failing-supply face: a member cannot be left holding a claimed
      // attempt without its fenced root — the claim is rolled back under the
      // captain's compensating authority and the structured error surfaces.
      const failing = await mkdtemp(join(tmpdir(), 'dsh-roots-failface-'))
      sandboxes.push(failing)
      const blockedBase = join(failing, 'not-a-directory')
      writeFileSync(blockedBase, 'a file where the roots base should be\n', 'utf8')
      const occupied = await mountGated(failing, 60_000, 'priority-ready', {
        executionRoots: true, executionRootsBase: blockedBase,
      })
      try {
        // The gated mount already created the captain's Team — a second one
        // would violate the one-active-Team-per-captain rule.
        const blockedTeamId = AgentSwarm.TeamId(occupied.teamId)
        const blockedTask = await toolCall(occupied.ctx, occupied.lead, 'blocked-task', 'agent_swarm_create_task', {
          subject: 'Cannot acquire', description: 'The claim must roll back.',
        })
        expect(blockedTask.isError).toBe(false)
        const blockedId = (blockedTask.value as { task_id: string }).task_id
        const blockedSnapshot = await occupied.ctx.agentSwarm.domain.snapshot(occupied.scope, blockedTeamId, occupied.lead.id)
        const blockedPending = blockedSnapshot.team.tasks.find(candidate => candidate.id === blockedId)!
        await expect(occupied.ctx.agentSwarm.claimTask(
          { agent: occupied.lead, signal: new AbortController().signal }, blockedId, blockedPending.revision,
        )).rejects.toMatchObject({ code: 'TEAM_EXECUTION_ROOT_ACQUIRE_FAILED' })
        const after = await occupied.ctx.agentSwarm.domain.snapshot(occupied.scope, blockedTeamId, occupied.lead.id)
        // The compensating cancel returned the task to the board.
        expect(after.team.tasks.find(candidate => candidate.id === blockedId)?.status).toBe('pending')
      } finally {
        for (const fiber of occupied.fibers.toReversed()) await fiber.dispose()
      }
    } finally {
      for (const fiber of composition.fibers.toReversed()) await fiber.dispose()
    }
  }, 90_000)
})
