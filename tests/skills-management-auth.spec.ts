/**
 * S1 skills-management authorization batch (task-1, attempt-1830b1d8).
 *
 * The request/status faces are Captain-only on an ACTIVE Team, with identity
 * derived ONLY from the live `exec.agent`: a real managed Team's dedicated
 * Captain is accepted, while a real Team member and a same-workspace
 * non-member Agent are both rejected with SKILLS_CAPTAIN_REQUIRED — the
 * caller cannot borrow authority by naming another root, Captain, or Session.
 * Cancellation semantics (tombstone before intake, blocking that revision,
 * a higher revision accepted, terminal states not cancellable) are exercised
 * on the Host service face.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { skillsRequestKey } from '../src/storage/skills-management.js'
import {
  captainSkillsTool,
  createSkillsTeam,
  disposeRestartComposition,
  liveSkillsAgent,
  mountSkillsComposition,
  mountSkillsModule,
  RESTART_SIGNAL,
  SKILLS_CAPTAIN_ROUTE,
  SkillsHeldChildAdapter,
  skillsModule,
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
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-skills-auth-'))
  SANDBOXES.push(sandbox)
  return sandbox
}

describe('S1 authorization: Captain-only faces and cancellation', () => {
  it('accepts the real managed Team Captain through the official managed lifecycle', async () => {
    const sandbox = await freshSandbox()
    // Official settlement lifecycle: a child Agent whose boot turn FINISHES
    // with nothing pending is disposed at the natural epoch (dsh-subagent
    // watchSettlement) — the durable Session is not a resident instance.
    // The managed Captain's boot turn is therefore HELD at a cancellable
    // gate on its real model route; the main bootstrap settles normally, and
    // the intake runs inside the Captain's genuinely live window.
    const childAdapter = new SkillsHeldChildAdapter('skills-auth-managed-main')
    const mounted = await mountSkillsComposition(sandbox, { [SKILLS_CAPTAIN_ROUTE.provider]: childAdapter })
    try {
      const main = await mounted.ctx.agentLoop.create(SessionId('skills-auth-managed-main'), SKILLS_CAPTAIN_ROUTE, { cwd: join(sandbox, 'workspace') })
      main.followup(createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Provision a managed Team for the Skills authorization case.' }],
      }))
      await main.whenIdle()
      const created = await captainSkillsTool(mounted.ctx, main, 'auth-managed-create', 'agent_swarm_create_managed', {
        name: 'Skills managed auth',
        description: 'Managed Team whose dedicated Captain owns the Skills request face.',
      })
      expect(created.ok, `agent_swarm_create_managed must succeed, got: ${created.error}${created.code ? ` (${created.code})` : ''}`).toBe(true)
      const teamId = (created.value as { team_id: string }).team_id
      const captainSessionId = (created.value as { captain_session_id: string }).captain_session_id
      // The held boot turn must genuinely ENTER the gate (the child is live
      // mid-turn), not merely be scheduled.
      await vi.waitFor(() => expect(childAdapter.gateEntered, 'the managed Captain boot turn is inside the held live window').toBeGreaterThan(0), { timeout: 5_000 })
      const captain = await liveSkillsAgent(mounted.ctx, captainSessionId)
      const scope = mounted.ctx.agentSwarm.scopeOf(captain)
      await mountSkillsModule(mounted.ctx, { management: [{ scope, teamId }] } satisfies SkillsModuleMountConfig, mounted.fibers)

      // Print-safe identity facts (whole Cordis proxies never enter an
      // assertion diff): the official registry and Session store resolve the
      // CURRENT exact live instance while its boot turn is held.
      const facts = () => {
        const live = mounted.ctx.agents.get(captain.id)
        return {
          live: live !== undefined,
          sameInstance: live === captain,
          sameSession: live !== undefined && mounted.ctx.sessions.get(captain.id) === live.session,
        }
      }
      expect(facts(), `the dedicated managed Captain must be the exact live instance in Session ${captain.id}`).toMatchObject({ live: true, sameInstance: true, sameSession: true })
      const intake = await captainSkillsTool(mounted.ctx, mounted.ctx.agents.get(captain.id)!, 'auth-managed-intake', REQUEST_TOOL, {
        request_id: 'auth-managed-request', revision: 1,
        question: 'Does the managed Captain own the durable intake face?',
      })
      expect(intake.ok, `the dedicated managed Captain must be accepted, got: ${intake.error}${intake.code ? ` (${intake.code})` : ''}`).toBe(true)
      expect(intake.value).toMatchObject({ request_id: 'auth-managed-request', revision: 1, received: true })
    } finally {
      childAdapter.releaseAll()
      await disposeRestartComposition(mounted)
    }
  }, 60_000)

  it('rejects a real Team member and a non-member Agent with SKILLS_CAPTAIN_REQUIRED', async () => {
    const sandbox = await freshSandbox()
    const mounted = await mountSkillsComposition(sandbox)
    try {
      const { root, teamId } = await createSkillsTeam(mounted, sandbox)
      const scope = mounted.ctx.agentSwarm.scopeOf(root)
      await mountSkillsModule(mounted.ctx, { management: [{ scope, teamId }] }, mounted.fibers)

      const added = await captainSkillsTool(mounted.ctx, root, 'auth-add-member', 'agent_swarm_add_member', {
        name: 'skills-auth-worker', role: 'worker',
      })
      expect(added.ok, `add_member must succeed, got: ${added.error}`).toBe(true)
      const member = await liveSkillsAgent(mounted.ctx, (added.value as { session_id: string }).session_id)

      const asMember = await captainSkillsTool(mounted.ctx, member, 'auth-member-intake', REQUEST_TOOL, {
        request_id: 'auth-member-request', revision: 1, question: 'A member must never reach the Captain face.',
      })
      expect(asMember.ok, 'an ordinary member must be rejected').toBe(false)
      expect([asMember.code ?? '', asMember.error ?? ''].join(' ')).toContain('SKILLS_CAPTAIN_REQUIRED')

      const outsider = (await mounted.ctx.agents.create({
        sessionId: SessionId('skills-auth-outsider'),
        agentOptions: SKILLS_CAPTAIN_ROUTE,
        meta: { cwd: join(sandbox, 'workspace') },
      })).agent
      const asOutsider = await captainSkillsTool(mounted.ctx, outsider, 'auth-outsider-intake', REQUEST_TOOL, {
        request_id: 'auth-outsider-request', revision: 1, question: 'A same-workspace non-member must be rejected.',
      })
      expect(asOutsider.ok, 'a non-member Agent in the same workspace must be rejected').toBe(false)
      expect([asOutsider.code ?? '', asOutsider.error ?? ''].join(' ')).toContain('SKILLS_CAPTAIN_REQUIRED')
    } finally {
      await disposeRestartComposition(mounted)
    }
  }, 60_000)

  it('enforces cancellation semantics and accepts a higher revision after a tombstone', async () => {
    const sandbox = await freshSandbox()
    const mounted = await mountSkillsComposition(sandbox)
    try {
      const { root, teamId } = await createSkillsTeam(mounted, sandbox)
      const scope = mounted.ctx.agentSwarm.scopeOf(root)
      await mountSkillsModule(mounted.ctx, { management: [{ scope, teamId }] }, mounted.fibers)
      const module = skillsModule(mounted.ctx)
      const exec = { agent: root, signal: RESTART_SIGNAL }

      // Pre-intake cancellation is a durable tombstone for that revision.
      const tombstone = await module.cancel('auth-cancel-request', 1, exec)
      expect(tombstone).toMatchObject({ request_id: 'auth-cancel-request', revision: 1, state: 'cancelled' })

      const blocked = await captainSkillsTool(mounted.ctx, root, 'auth-cancel-blocked', REQUEST_TOOL, {
        request_id: 'auth-cancel-request', revision: 1, question: 'Must hit the tombstone.',
      })
      expect(blocked.ok).toBe(false)
      expect([blocked.code ?? '', blocked.error ?? ''].join(' ')).toContain('SKILLS_REQUEST_CANCELLED')

      // A HIGHER revision after the cancellation is a fresh accepted attempt.
      const revived = await captainSkillsTool(mounted.ctx, root, 'auth-cancel-revived', REQUEST_TOOL, {
        request_id: 'auth-cancel-request', revision: 2, question: 'Fresh attempt after the tombstone.',
      })
      expect(revived.ok, `revision 2 after a cancelled revision 1 must be accepted, got: ${revived.error}`).toBe(true)

      // Terminal outcomes are not cancellable. The intake receipt carries the
      // state; the reason field belongs to the durable status read-back.
      const terminal = await captainSkillsTool(mounted.ctx, root, 'auth-terminal', REQUEST_TOOL, {
        request_id: 'auth-terminal-request', revision: 1, question: 'No manager configured → terminal unavailable.',
      })
      expect(terminal.ok).toBe(true)
      expect(terminal.value).toMatchObject({ request_id: 'auth-terminal-request', revision: 1, state: 'unavailable' })
      const terminalStatus = await captainSkillsTool(mounted.ctx, root, 'auth-terminal-status', STATUS_TOOL, {
        request_id: 'auth-terminal-request',
      })
      expect(terminalStatus.ok).toBe(true)
      expect(terminalStatus.value).toMatchObject({ state: 'unavailable', reason: 'manager-model-not-configured' })
      const cancelTerminal = await module.cancel('auth-terminal-request', 1, exec).then(
        () => undefined,
        (error: unknown) => error as Error & { code?: string },
      )
      expect([cancelTerminal?.code ?? '', cancelTerminal?.message ?? ''].join(' ')).toContain('SKILLS_REQUEST_NOT_CANCELLABLE')
    } finally {
      await disposeRestartComposition(mounted)
    }
  }, 40_000)

  it('refuses intake for a Team outside the Host management manifest BEFORE any write', async () => {
    const sandbox = await freshSandbox()
    const mounted = await mountSkillsComposition(sandbox)
    try {
      const { root, teamId } = await createSkillsTeam(mounted, sandbox)
      const scope = mounted.ctx.agentSwarm.scopeOf(root)
      // Manifest does NOT contain this Team: intake must be refused BEFORE the
      // received write and without ever starting the manager model.
      await mountSkillsModule(mounted.ctx, { management: [{ scope: 'C:/somewhere/else', teamId: 'team-elsewhere' }] } satisfies SkillsModuleMountConfig, mounted.fibers)

      const refused = await captainSkillsTool(mounted.ctx, root, 'auth-out-of-manifest', REQUEST_TOOL, {
        request_id: 'auth-out-of-manifest-request', revision: 1, question: 'A Team nobody granted me.',
      })
      expect(refused.ok, 'out-of-manifest intake must be refused').toBe(false)
      expect([refused.code ?? '', refused.error ?? ''].join(' ')).toContain('SKILLS_UNAUTHORIZED')

      // No `received` was written. A legitimate zero-write refusal may never
      // have touched the unit medium AT ALL — an absent file is the strongest
      // proof; only when the file exists may the exact key be checked.
      const unitText = await readFile(skillsUnitFile(sandbox), 'utf8').catch((error: unknown) => {
        expect((error as NodeJS.ErrnoException).code, 'a touched unit must be readable; an absent one proves zero write').toBe('ENOENT')
        return undefined
      })
      if (unitText !== undefined) {
        const unit = JSON.parse(unitText) as { tables?: { requests?: Record<string, unknown> } }
        expect(unit.tables?.requests?.[skillsRequestKey(scope, teamId, 'auth-out-of-manifest-request')],
          'refusal must leave no durable intake row').toBeUndefined()
      }
    } finally {
      await disposeRestartComposition(mounted)
    }
  }, 40_000)
})
