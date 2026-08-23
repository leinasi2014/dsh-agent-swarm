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
        async runRequestExclusive<T>(_scope: string, _requestId: string, operation: () => Promise<T>) {
          return await operation()
        },
        get(readScope: string, requestId: string) {
          return readScope === scope && durable?.request.requestId === requestId
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

      await expect(gateway.submit(scope, request, admission, SIGNAL))
        .rejects.toMatchObject({ code: 'TEAM_INTERACTION_OUTCOME_UNKNOWN' })
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
})
