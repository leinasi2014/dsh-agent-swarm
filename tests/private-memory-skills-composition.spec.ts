import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import { canonicalJson } from '../src/storage/skills-management.js'
import {
  captainSkillsTool, createSkillsTeam, disposeRestartComposition, mountSkillsComposition, mountSkillsModule,
  SKILLS_MANAGER_ROUTE, SkillsManagerScriptAdapter, skillsManagerModuleConfig, skillsModule, skillsTextChunks, skillsToolTurn,
} from './helpers/skills-management-composition.js'
import {
  MEMBER_ROUTE, RELEASE_PROVIDER, claimCurrentTask, createS2Task, expectSkillInRequest, gesture, liveTaskMember,
} from './helpers/skills-management-release.js'
import { skillsSandboxTracker } from './helpers/skills-management-support.js'
import { invalidateNote, latestNamedContribution, writeMatchingNote } from './helpers/private-memory-composition.js'

const tracker = skillsSandboxTracker('dsh-private-memory-skills-')
const SKILL = 'recallproof-skill'
const BODY = 'APPROVED_SKILL_COMPOSITION: preserve the exact task binding while checking recallprobe evidence.'
const RECALL = 'agent-swarm:private-memory-recall'
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

describe('private-memory recall and assigned Skills in one official request', () => {
  it('loads both for the same running attempt, then clears invalidated recall without removing the legal Skill', async () => {
    const sandbox = await tracker.freshSandbox()
    const adapter = new SkillsManagerScriptAdapter()
    const mounted = await mountSkillsComposition(sandbox, {
      [MEMBER_ROUTE.provider]: adapter,
      [SKILLS_MANAGER_ROUTE.provider]: new SkillsManagerScriptAdapter(),
    }, { allowedSkills: [SKILL], skillCatalog: { providerName: 'composition-catalog', entries: [
      { name: SKILL, description: 'A task-bound integration check.', content: BODY },
    ] } })
    let disposeMember: (() => Promise<void>) | undefined
    let releaseReload = () => {}
    let releaseFinish = () => {}
    const reloadGate = new Promise<void>(resolve => { releaseReload = resolve })
    const finishGate = new Promise<void>(resolve => { releaseFinish = resolve })
    try {
      // Reuse the existing stack; grant recall through the public Host plugin
      // config before any Agent/Team exists, rather than mounting a second Swarm.
      const swarmFibers = mounted.fibers.filter(fiber => fiber.runtime?.callback === AgentSwarm.apply)
      expect(swarmFibers).toHaveLength(1)
      await swarmFibers[0]!.update({ ...swarmFibers[0]!.config, privateMemoryRecall: 'active-task' })
      await swarmFibers[0]!.await()
      const { root, teamId } = await createSkillsTeam(mounted, sandbox)
      const scope = mounted.ctx.agentSwarm.scopeOf(root)
      const taskId = await createS2Task(mounted.ctx, root, 'composition-task', 'recallprobe evidence with an approved Skill')
      const live = await liveTaskMember(mounted, root, 'composition-worker', [SKILL], adapter)
      disposeMember = live.disposeMember
      const { member } = live
      await claimCurrentTask(mounted, member, scope, teamId, taskId, 'composition', 'evidence:composition/recall-and-skill')
      const currentTask = async () => (await mounted.ctx.agentSwarm.listTeamAggregates(scope))
        .find(team => team.id === teamId)!.tasks.find(task => task.id === taskId)!
      const task = await currentTask()
      const attemptId = task.currentAttemptId
      expect(attemptId).toBeTruthy()
      expect(mounted.ctx.agents.get(member.id)).toBe(member)
      expect(mounted.ctx.sessions.get(member.id)).toBe(member.session)
      const note = await writeMatchingNote(mounted, member)

      expect(await mountSkillsModule(mounted.ctx, skillsManagerModuleConfig(scope, teamId), mounted.fibers)).toBe(true)
      const approved = await skillsModule(mounted.ctx).releases.approveRelease({
        scope, teamId, skillName: SKILL, version: '1.0.0', provider: 'composition-catalog', locator: SKILL,
        body: BODY, contentSha256: sha256(BODY), resourcesSha256: sha256(canonicalJson([])),
        applicability: 'recallprobe evidence', verification: 'deterministic request composition',
        approvedBy: 'composition-host-reviewer',
      })
      expect(approved).toMatchObject({ name: SKILL, version: '1.0.0' })
      const assigned = await captainSkillsTool(mounted.ctx, root, 'composition-assign', 'agent_swarm_skills_assign', {
        skill_name: SKILL, version: '1.0.0', member: member.id, expected_revision: 0,
      })
      expect(assigned.ok, assigned.error).toBe(true)
      expect(assigned.value).toMatchObject({ member_session_id: member.id, skill_name: SKILL, version: '1.0.0' })

      const start = adapter.requests.length
      adapter.append(
        skillsToolTurn('composition-load', 'skill', { name: SKILL }),
        [{ gate: reloadGate }, ...skillsToolTurn('composition-reload', 'skill', { name: SKILL })],
        [{ gate: finishGate }, ...skillsTextChunks('Both contributions checked on the same running attempt.')],
      )
      await gesture(member, adapter, `Use /${SKILL} and load its approved body for recallprobe.`, false, live.releaseReady)
      const requestWithResult = (callId: string) => adapter.requests.slice(start).find(request => request.sessionId === member.id
        && request.messages.some(message => message.content.some(block => block.type === 'tool-result' && block.toolCallId === callId)))
      await vi.waitFor(() => expect(requestWithResult('composition-load')).toBeDefined(), { timeout: 5_000 })
      const combined = requestWithResult('composition-load')!
      const contribution = latestNamedContribution(combined, RECALL)
      expect(contribution).toContain(`<private-memory-recall task="${taskId}" attempt="${attemptId}">`)
      expect(contribution).toContain(`data-memory-id="${note.memoryId}"`)
      expect(contribution).toContain(`data-head-seq="${note.headSeq}"`)
      expect(contribution).toContain('recallprobe lesson')
      await expectSkillInRequest(mounted, member, combined, { name: SKILL, provider: RELEASE_PROVIDER, content: BODY }, 'composition-load')
      expect(await currentTask()).toMatchObject({ status: 'in_progress', ownerSessionId: member.id, currentAttemptId: attemptId })

      // Invalidate through the actual member tool while the adapter holds this
      // attempt open. The next real request must recompute only the recall seat.
      await invalidateNote(mounted, member, note)
      releaseReload()
      await vi.waitFor(() => expect(requestWithResult('composition-reload')).toBeDefined(), { timeout: 5_000 })
      const afterCleanup = requestWithResult('composition-reload')!
      expect(afterCleanup).not.toBe(combined)
      expect(latestNamedContribution(afterCleanup, RECALL)).toBe('')
      await expectSkillInRequest(mounted, member, afterCleanup, { name: SKILL, provider: RELEASE_PROVIDER, content: BODY }, 'composition-reload')
      expect(await currentTask()).toMatchObject({ status: 'in_progress', ownerSessionId: member.id, currentAttemptId: attemptId })
      expect(mounted.ctx.agents.get(member.id)).toBe(member)
      expect(mounted.ctx.sessions.get(member.id)).toBe(member.session)
      // Clearing the current contribution must not rewrite the earlier request.
      expect(latestNamedContribution(combined, RECALL)).toBe(contribution)
    } finally {
      releaseReload()
      releaseFinish()
      try { await disposeMember?.() } finally { await disposeRestartComposition(mounted) }
    }
  }, 90_000)
})
