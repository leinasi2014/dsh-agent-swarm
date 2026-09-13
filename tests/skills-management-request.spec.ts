/**
 * S1 skills-management vertical — frozen product RED (task-1, attempt
 * -1830b1d8), promoted to GREEN by the S1 module implementation.
 *
 * The RED discipline here (per the external S ruling): every case drives the
 * REAL official composition — real Context, real AgentLoop agents, the real
 * agent-swarm plugin over the official Storage Domain (json backend) — and
 * invokes the Skills request through the real Captain tool face with the
 * Captain's own live `exec.agent`. Before `src/skills/plugin.ts` exists the
 * module is simply not part of the composition, so the official tool
 * dispatch genuinely does not provide the capability: the failure lands on
 * the product surface (missing capability at `ctx.tools.execute`), never on
 * an import error, a keyword scan, or a mock entry point.
 *
 * GREEN expectations frozen by these cases:
 *  1. `agent_swarm_skills_request` durably persists the Captain's intent in
 *     the module-owned official Storage Domain (`agent_swarm_skills_management`
 *     unit) BEFORE the tool returns "received";
 *  2. requestId + request revision + canonical payload is idempotent: same
 *     revision + same payload reads the stored receipt back (replayed), same
 *     revision + different payload conflicts loudly;
 *  3. a full composition restart leaves the receipt readable through
 *     `agent_swarm_skills_status` with ZERO model requests for the query
 *     (storage-only read), and with no manager model configured the stored
 *     outcome is an explicit `unavailable` — never a hang or a silent gap.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { skillsRequestKey } from '../src/storage/skills-management.js'
import {
  captainSkillsTool,
  createSkillsTeam,
  disposeRestartComposition,
  mountSkillsComposition,
  mountSkillsModule,
  SKILLS_UNIT_NAME,
  skillsAdapter,
  skillsUnitFile,
  type SkillsModuleMountConfig,
} from './helpers/skills-management-composition.js'

const REQUEST_TOOL = 'agent_swarm_skills_request'
const STATUS_TOOL = 'agent_swarm_skills_status'

const SANDBOXES: string[] = []
afterAll(async () => {
  for (const dir of SANDBOXES) await rm(dir, { recursive: true, force: true })
})

async function freshSandbox(): Promise<string> {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-skills-s1-'))
  SANDBOXES.push(sandbox)
  return sandbox
}

function intakeArgs(requestId: string, question: string): Record<string, unknown> {
  return {
    request_id: requestId,
    revision: 1,
    question,
    goal: 'Make the Captain skill-request vertical durable and reusable.',
  }
}

function moduleConfig(scope: string, teamId: string): SkillsModuleMountConfig {
  // No manager model configured: the S1 exit rule requires an explicit
  // `unavailable` outcome instead of a stall or a silent gap.
  return { management: [{ scope, teamId }] }
}

describe('S1 skills-management vertical (frozen RED → GREEN)', () => {
  it('durably accepts the Captain skill request through the real official tool path', async () => {
    const sandbox = await freshSandbox()
    const mounted = await mountSkillsComposition(sandbox)
    try {
      const { root, teamId } = await createSkillsTeam(mounted, sandbox)
      // No mount-presence pre-assertion (per the S ruling): before the module
      // exists this call is a silent no-op, so the first mandatory failure
      // lands on the real request tool's acceptance result below, not on the
      // assembly. Once the module exists, any plugin mount failure rejects
      // here loudly as a fixture defect (separate repair lane).
      await mountSkillsModule(mounted.ctx, moduleConfig(mounted.ctx.agentSwarm.scopeOf(root), teamId), mounted.fibers)

      const intake = await captainSkillsTool(mounted.ctx, root, 'skills-intake-1', REQUEST_TOOL,
        intakeArgs('skill-request-1', 'Which approved release covers flaky JSON renames on Windows?'))
      expect(intake.ok, `the real Captain call to ${REQUEST_TOOL} must durably accept the request, got: ${intake.error}${intake.code ? ` (${intake.code})` : ''}`).toBe(true)
      expect(intake.value).toMatchObject({ request_id: 'skill-request-1', revision: 1, received: true })

      // Durable before response, proven at the EXACT official record key
      // (Root ruling: no arbitrary-string hits): the row of the module-owned
      // unit located by skillsRequestKey must carry the real fields.
      const scope = mounted.ctx.agentSwarm.scopeOf(root)
      const unit = JSON.parse(await readFile(skillsUnitFile(sandbox), 'utf8')) as {
        unit: { name: string; version: number }
        tables: { requests: Record<string, Record<string, unknown> | undefined> }
      }
      expect(unit.unit.name, 'the durable medium is the module-owned unit').toBe(SKILLS_UNIT_NAME)
      const row = unit.tables.requests[skillsRequestKey(scope, teamId, 'skill-request-1')]
      expect(row, `the receipt must live at its exact record key in ${SKILLS_UNIT_NAME}`).toBeTruthy()
      expect(row).toMatchObject({
        schemaVersion: 1,
        scope,
        teamId,
        requestId: 'skill-request-1',
        revision: 1,
        state: 'unavailable',
        reason: 'manager-model-not-configured',
      })
      expect(row!.payload).toMatchObject({
        question: 'Which approved release covers flaky JSON renames on Windows?',
        goal: 'Make the Captain skill-request vertical durable and reusable.',
        evidence: [],
      })
    } finally {
      await disposeRestartComposition(mounted)
    }
  }, 30_000)

  it('is idempotent on requestId+revision+canonical payload and conflicts on a different payload', async () => {
    const sandbox = await freshSandbox()
    const mounted = await mountSkillsComposition(sandbox)
    try {
      const { root, teamId } = await createSkillsTeam(mounted, sandbox)
      await mountSkillsModule(mounted.ctx, moduleConfig(mounted.ctx.agentSwarm.scopeOf(root), teamId), mounted.fibers)

      const first = await captainSkillsTool(mounted.ctx, root, 'skills-intake-2a', REQUEST_TOOL,
        intakeArgs('skill-request-2', 'How should the manager cite retained work activity for evidence?'))
      expect(first.ok, `first intake must be accepted, got: ${first.error}`).toBe(true)

      const replay = await captainSkillsTool(mounted.ctx, root, 'skills-intake-2b', REQUEST_TOOL,
        intakeArgs('skill-request-2', 'How should the manager cite retained work activity for evidence?'))
      expect(replay.ok, `an identical revision+payload must replay the stored receipt, got: ${replay.error}`).toBe(true)
      expect(replay.value).toMatchObject({ request_id: 'skill-request-2', revision: 1, replayed: true })

      const conflict = await captainSkillsTool(mounted.ctx, root, 'skills-intake-2c', REQUEST_TOOL,
        intakeArgs('skill-request-2', 'A DIFFERENT question payload at the SAME revision must conflict.'))
      expect(conflict.ok, 'same revision with a different canonical payload must conflict loudly').toBe(false)
      expect([conflict.code ?? '', conflict.error ?? ''].some(field => field.includes('SKILLS_REQUEST_CONFLICT')),
        `conflict must carry the SKILLS_REQUEST_CONFLICT code, got: code=${conflict.code} error=${conflict.error}`).toBe(true)
    } finally {
      await disposeRestartComposition(mounted)
    }
  }, 30_000)

  it('reads the durable receipt back after a full restart with zero model requests', async () => {
    const sandbox = await freshSandbox()
    const first = await mountSkillsComposition(sandbox)
    let teamId = ''
    try {
      const { root, teamId: createdTeamId } = await createSkillsTeam(first, sandbox)
      teamId = createdTeamId
      await mountSkillsModule(first.ctx, moduleConfig(first.ctx.agentSwarm.scopeOf(root), teamId), first.fibers)
      const intake = await captainSkillsTool(first.ctx, root, 'skills-intake-3', REQUEST_TOOL,
        intakeArgs('skill-request-3', 'Does a release already cover restart-safe skill intake?'))
      expect(intake.ok, `pre-restart intake must be accepted, got: ${intake.error}`).toBe(true)
    } finally {
      await disposeRestartComposition(first)
    }

    // Restart: a fresh Context over the same durable roots. No model is ever
    // configured for the manager on either side of the restart.
    const second = await mountSkillsComposition(sandbox)
    try {
      const { root } = await createSkillsTeam(second, sandbox, true)
      await mountSkillsModule(second.ctx, moduleConfig(second.ctx.agentSwarm.scopeOf(root), teamId), second.fibers)
      const adapter = skillsAdapter(second)
      const before = adapter.requests.length

      const status = await captainSkillsTool(second.ctx, root, 'skills-status-3', STATUS_TOOL,
        { request_id: 'skill-request-3' })
      expect(status.ok, `post-restart ${STATUS_TOOL} must read the durable receipt, got: ${status.error}`).toBe(true)
      expect(status.value).toMatchObject({ request_id: 'skill-request-3', revision: 1 })
      const receipt = status.value as { state: string; reason?: string }
      expect(['unavailable'], `with no manager model configured the durable outcome must be an explicit unavailable, got: ${JSON.stringify(receipt)}`).toContain(receipt.state)
      expect(receipt.reason, 'the unavailable outcome must carry an explicit reason').toBeTruthy()

      // Zero-model status query: the restart-side composition served the
      // whole read from storage without a single model request.
      expect(adapter.requests.length, 'a post-restart status query must not touch the model').toBe(before)
    } finally {
      await disposeRestartComposition(second)
    }
  }, 40_000)
})
