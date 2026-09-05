/**
 * P0-2 S1 RED: staged lifecycle in the Team domain (Plan-first approval).
 *
 * Contract (frozen):
 * - createStagedManaged never provisions a Captain Session (captainSessionId
 *   is '' while staged), has no members/tasks/attempts, revision 1.
 * - setPlanDraft stores a bounded planDraft and advances the revision; a stale
 *   expected revision fails with TEAM_REVISION_CONFLICT.
 * - approveStagedPlan is the atomic staged->active commit: requires a real
 *   captainSessionId and the current revision, then phase=active.
 * - discardStagedPlan archives the draft (phase=archived, discardReason set,
 *   planDraft cleared) and is idempotent.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TeamDomain } from '../src/domain/team-domain.js'
import type { TeamPlanDraft } from '../src/domain/types.js'
import { openStorageStack, type StorageStack } from './helpers/storage-stack.js'

const draft: TeamPlanDraft = {
  members: [{ name: 'researcher', role: '性能与安全分析' }],
  tasks: [{
    key: 't1', subject: '性能与安全分析', description: '分析最近交付',
    dependencies: [], targetMemberName: 'researcher',
  }],
}

describe('staged plan lifecycle (S1)', () => {
  let sandbox: string
  let scope: string
  let stack: StorageStack
  let domain: TeamDomain

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-staged-'))
    scope = join(sandbox, 'workspace')
    stack = await openStorageStack(join(sandbox, 'storage'), () => 1_000)
    domain = stack.port as TeamDomain
  })

  afterEach(async () => {
    await stack.close()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('creates a staged managed Team with no captain session, members, or tasks', async () => {
    const team = await domain.createStagedManaged(scope, 'managed:root:turn:1', '评审团队', '分析最近交付')
    expect(team.phase).toBe('staged')
    expect(team.captainSessionId).toBe('')
    expect(team.members).toEqual([])
    expect(team.tasks).toEqual([])
    expect(team.revision).toBe(1)
    // Idempotent same-origin resume returns the same staged Team.
    const again = await domain.createStagedManaged(scope, 'managed:root:turn:1', '评审团队', '分析最近交付')
    expect(again.id).toBe(team.id)
  })

  it('setPlanDraft stores the bounded draft and rejects a stale revision', async () => {
    const team = await domain.createStagedManaged(scope, 'managed:root:turn:2', '评审团队', '分析最近交付')
    const updated = await domain.setPlanDraft(scope, team.id, team.revision, draft)
    expect(updated.phase).toBe('staged')
    expect(updated.planDraft?.members).toHaveLength(1)
    expect(updated.revision).toBe(team.revision + 1)
    await expect(domain.setPlanDraft(scope, team.id, team.revision, draft))
      .rejects.toMatchObject({ code: 'TEAM_REVISION_CONFLICT' })
  })

  it('approveStagedPlan atomically moves the Team to active with the real Captain id', async () => {
    const team = await domain.createStagedManaged(scope, 'managed:root:turn:3', '评审团队', '分析最近交付')
    const planned = await domain.setPlanDraft(scope, team.id, team.revision, draft)
    const active = await domain.approveStagedPlan(scope, team.id, planned.revision, 'captain-real-session')
    expect(active.phase).toBe('active')
    expect(active.captainSessionId).toBe('captain-real-session')
  })

  it('discardStagedPlan archives the draft and is idempotent', async () => {
    const team = await domain.createStagedManaged(scope, 'managed:root:turn:4', '评审团队', '分析最近交付')
    const planned = await domain.setPlanDraft(scope, team.id, team.revision, draft)
    const discarded = await domain.discardStagedPlan(scope, team.id, planned.revision)
    expect(discarded.phase).toBe('archived')
    expect(discarded.discardReason).toBe('discarded')
    expect(discarded.planDraft).toBeUndefined()
    await expect(domain.discardStagedPlan(scope, team.id, discarded.revision)).resolves.toMatchObject({ phase: 'archived' })
  })
})
