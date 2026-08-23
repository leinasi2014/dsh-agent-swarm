import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import {
  HumanControlGateway,
  TeamId,
  type HumanControlGatewayDeps,
  type HumanInteractionRecord,
  type HumanInteractionRequest,
} from '../src/index.js'

const SIGNAL = new AbortController().signal

describe('SW-I1a uncertain effect outcome', () => {
  for (const failure of ['post-effect-revision-read', 'receipt-write'] as const) {
    it(`${failure} remains pending/outcome-unknown and a replay never repeats the Team effect`, async () => {
      const captain = { id: SessionId('captain-outcome') } as Agent
      const teamId = TeamId('team-outcome')
      const scope = 'workspace-outcome'
      let durable: HumanInteractionRecord | undefined
      let effectCount = 0
      let quarantined = false
      const overlay = {
        assertAvailable() {},
        async runAdmitted<T>(operation: () => Promise<T>) {
          return await operation()
        },
        async runRequestExclusive<T>(_scope: string, _teamId: string, _requestId: string, operation: () => Promise<T>) {
          return await operation()
        },
        get(readScope: string, readTeamId: string, requestId: string) {
          return readScope === scope && readTeamId === teamId && durable?.request.requestId === requestId
            ? structuredClone(durable)
            : undefined
        },
        async commitIfAbsent(record: HumanInteractionRecord) {
          if (durable !== undefined) return structuredClone(durable)
          durable = structuredClone(record)
          return undefined
        },
        async update(record: HumanInteractionRecord) {
          if (failure === 'receipt-write') throw new Error('receipt medium unavailable')
          durable = structuredClone(record)
          return structuredClone(record)
        },
        quarantine() {
          quarantined = true
        },
        isOutcomeUnknown() {
          return quarantined || durable?.receipt.code === 'TEAM_INTERACTION_OUTCOME_UNKNOWN'
        },
      }
      const team = {
        id: teamId,
        revision: 1,
        captainSessionId: captain.id,
        members: [{ name: 'worker', sessionId: 'member-outcome', role: 'worker', phase: 'active' }],
        tasks: [],
        attempts: [],
      }
      const domain = {
        async requireMembership() {
          return { role: 'captain', name: 'captain', team }
        },
        async snapshot() {
          if (failure === 'post-effect-revision-read') throw new Error('C:\\private\\adapter token=secret-after-commit')
          return { team: { ...team, revision: 2 } }
        },
      }
      const ctx = {
        agents: {
          get: (id: SessionId) => id === captain.id ? captain : undefined,
          roots: () => [captain],
        },
      } as unknown as Context
      const gateway = new HumanControlGateway({
        ctx,
        domain: () => domain,
        overlay,
        sendMessage: async () => {
          effectCount += 1
          return { id: 'message-outcome' }
        },
        interruptMember: async () => ({ name: 'worker', previousStatus: 'idle' }),
        reassignTask: async () => { throw new Error('not used') },
        reviewTask: async () => { throw new Error('not used') },
      } as unknown as HumanControlGatewayDeps)
      const request: HumanInteractionRequest = {
        schemaVersion: 1,
        requestId: `human-outcome-${failure === 'receipt-write' ? 'receipt' : 'revision'}-00000001`,
        teamId,
        source: { kind: 'captain-mediated', captainSessionId: captain.id },
        target: { kind: 'member', memberName: 'worker' },
        intent: 'wake-member',
        expectedTeamRevision: 1,
        createdAt: 1,
      }
      const admission = { kind: 'captain' as const, exec: { agent: captain, signal: SIGNAL } }

      let publicError: unknown
      try {
        await gateway.submit(scope, request, admission, SIGNAL)
      } catch (error) {
        publicError = error
      }
      expect(publicError).toMatchObject({ code: 'TEAM_INTERACTION_OUTCOME_UNKNOWN' })
      const errorChain = publicError as Error & { cause?: unknown }
      expect(JSON.stringify({ message: errorChain.message, cause: errorChain.cause })).not.toMatch(
        /private|secret-after-commit|receipt medium unavailable/,
      )
      expect(effectCount).toBe(1)
      expect(durable?.receipt.status).toBe('pending')
      expect(durable?.receipt.diagnostic).toBe(failure === 'post-effect-revision-read'
        ? 'effect outcome unknown; reconciliation required'
        : undefined)
      expect(JSON.stringify(durable)).not.toMatch(/private|secret-after-commit|receipt medium unavailable/)

      await expect(gateway.submit(scope, request, admission, SIGNAL))
        .rejects.toMatchObject({ code: 'TEAM_INTERACTION_OUTCOME_UNKNOWN' })
      expect(effectCount).toBe(1)
      expect(durable?.receipt.status).toBe('pending')
      await expect(gateway.cancel(scope, request, admission))
        .rejects.toMatchObject({ code: 'TEAM_INTERACTION_OUTCOME_UNKNOWN' })
      // scenario-evidence: 45
      expect(durable?.receipt.status).toBe('pending')
    })
  }


  it('rejects malformed source, host surface and admission before verifier, overlay or Team access', async () => {
    const captain = { id: SessionId('captain-validation') } as Agent
    const teamId = TeamId('team-validation')
    const touches = { overlay: 0, team: 0, verifier: 0 }
    const overlay = new Proxy({}, {
      get() {
        return () => {
          touches.overlay += 1
          throw new Error('overlay must not be touched')
        }
      },
    })
    const gateway = new HumanControlGateway({
      ctx: { agents: { get: () => captain, roots: () => [captain] } } as unknown as Context,
      domain: () => {
        touches.team += 1
        throw new Error('Team must not be touched')
      },
      overlay,
      verifyHumanPrincipal: async () => {
        touches.verifier += 1
        return true
      },
      sendMessage: async () => { throw new Error('not used') },
      interruptMember: async () => { throw new Error('not used') },
      reassignTask: async () => { throw new Error('not used') },
      reviewTask: async () => { throw new Error('not used') },
    } as unknown as HumanControlGatewayDeps)
    const base: HumanInteractionRequest = {
      schemaVersion: 1,
      requestId: 'human-validation-00000001',
      teamId,
      source: { kind: 'captain-mediated', captainSessionId: captain.id },
      target: { kind: 'member', memberName: 'worker' },
      intent: 'wake-member',
      expectedTeamRevision: 1,
      createdAt: 1,
    }
    const invalid: Array<{ request: HumanInteractionRequest; admission: unknown }> = [
      { request: { ...base, source: null } as unknown as HumanInteractionRequest, admission: { kind: 'captain', exec: { agent: captain, signal: SIGNAL } } },
      { request: { ...base, source: { kind: 'unknown', captainSessionId: captain.id } } as unknown as HumanInteractionRequest, admission: { kind: 'captain', exec: { agent: captain, signal: SIGNAL } } },
      { request: { ...base, source: { kind: 'captain-mediated', captainSessionId: captain.id, hostSurface: null } } as unknown as HumanInteractionRequest, admission: { kind: 'captain', exec: { agent: captain, signal: SIGNAL } } },
      { request: { ...base, source: { kind: 'authenticated-human', captainSessionId: captain.id, principalRef: 'p', hostSurface: 'x'.repeat(129) } }, admission: { kind: 'authenticated-human', principalRef: 'p' } },
      { request: base, admission: null },
    ]
    for (const item of invalid) {
      await expect(gateway.submit('workspace-validation', item.request, item.admission as never, SIGNAL))
        .rejects.toMatchObject({ code: 'TEAM_INTERACTION_INVALID' })
    }
    expect(touches).toEqual({ overlay: 0, team: 0, verifier: 0 })
  })
})
